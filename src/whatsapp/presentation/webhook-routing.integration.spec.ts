import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresConversationStore } from '../../conversation/infrastructure/postgres-conversation.store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import { PostgresReceiptMediaStore } from '../../receipt-media/infrastructure/postgres-receipt-media.store';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { InMemoryRecentOutboundStore } from '../infrastructure/in-memory-recent-outbound.store';
import { PostgresWebhookDedupStore } from '../infrastructure/postgres-webhook-dedup.store';
import { RestockInboundCapture } from '../application/restock-inbound-capture';
import { CUSTOMER_INBOUND_CAPTURE } from '../infrastructure/customer-inbound-capture.provider';
import type { WebhookEventDto } from './dto/webhook-event.dto';
import { SignatureGuard } from './signature.guard';
import { WebhookController } from './webhook.controller';

/**
 * R2/R6 receipt routing over the REAL SignatureGuard + WebhookController +
 * WebhookDispatcherService + ReceiptIngressService + PostgresReceiptMediaStore
 * + PostgresConversationStore + PostgresWebhookDedupStore on one migrated
 * PostgreSQL 16 (Testcontainers). Fakes: the WhatsApp sender, AgentRunner,
 * the minimal agent and the handoff hook. There is no amount dialog: a
 * receipt is admitted silently (the worker reads and uploads it), and
 * customer text always reaches the agent.
 *
 * Gated by RUN_DOCKER_TESTS=1 like the other Testcontainers suites.
 */

const passThroughRestockCapture = {
  capture: (snapshot: { rawBodyBase64: string }) =>
    Promise.resolve({
      action: 'captured' as const,
      event: JSON.parse(
        Buffer.from(snapshot.rawBodyBase64, 'base64').toString('utf8'),
      ) as WebhookEventDto,
      evidence: [],
    }),
} as unknown as RestockInboundCapture;

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

const APP_SECRET = 'meta-app-secret';
const PLACED_SALE_ID = '4f7c2f9e-1f30-4a2b-8c3d-0f1e2d3c4b5a';
const CUSTOMER = '5215550001111';
const IN_PROGRESS = 'Estamos procesando su comprobante.';

const sign = (body: string): string =>
  `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

const envelope = (message: Record<string, unknown>): string =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: CUSTOMER, timestamp: '1719000000', ...message },
              ],
            },
          },
        ],
      },
    ],
  });

const textBody = (id: string, body: string) =>
  envelope({ id, type: 'text', text: { body } });
const imageBody = (id: string, mediaId: string, caption?: string) =>
  envelope({
    id,
    type: 'image',
    image: {
      id: mediaId,
      mime_type: 'image/jpeg',
      ...(caption === undefined ? {} : { caption }),
    },
  });
const pdfBody = (id: string, mediaId: string) =>
  envelope({
    id,
    type: 'document',
    document: {
      id: mediaId,
      mime_type: 'application/pdf',
      filename: 'comprobante.pdf',
    },
  });

ddescribe('Webhook receipt routing integration (R2/R6, Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let sent: Array<{ to: string; text: string }>;
  let minimalAgent: { tryHandle: jest.Mock };
  let outbound = 0;

  const post = (body: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200);

  const receipts = async () =>
    (
      await pool.query<{
        webhook_message_id: string;
        status: string;
        declared_mime_type: string;
        declared_amount_cents: number | null;
      }>(
        `SELECT webhook_message_id, status, declared_mime_type,
                declared_amount_cents FROM receipt_media ORDER BY created_at`,
      )
    ).rows;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    const store = new PostgresReceiptMediaStore(pool);
    const conversations = new PostgresConversationStore(pool);
    sent = [];
    minimalAgent = {
      tryHandle: jest.fn(() =>
        Promise.resolve({ kind: 'handled', reply: 'AGENT-REPLY' }),
      ),
    };
    const dispatcher = new WebhookDispatcherService(
      { handle: jest.fn() } as unknown as AgentRunner,
      {
        sendText: jest.fn((message: { to: string; text: string }) => {
          sent.push(message);
          return Promise.resolve({
            providerMessageId: `wamid.bot.${++outbound}`,
          });
        }),
        sendTemplate: jest.fn(),
      },
      new PostgresWebhookDedupStore(pool),
      new InMemoryRecentOutboundStore(),
      {
        isOpsSender: jest.fn(() => false),
        resolveReply: jest.fn(),
      } as unknown as HumanHandoffService,
      conversations,
      new ReceiptIngressService(
        { enabled: true },
        { getState: (senderId: string) => conversations.get(senderId) },
        store,
      ),
      minimalAgent as unknown as MinimalCatalogAgentService,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        SignatureGuard,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) =>
              key === 'meta.appSecret' ? APP_SECRET : 'verify-token',
            ),
          },
        },
        { provide: WebhookDispatcherService, useValue: dispatcher },
        // Pass-through inbound captures (their behavior has its own specs).
        { provide: RestockInboundCapture, useValue: passThroughRestockCapture },
        {
          provide: CUSTOMER_INBOUND_CAPTURE,
          useValue: () =>
            Promise.resolve({ action: 'captured', observations: [] }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await conversations.create(CUSTOMER, {
      lastMessageAt: new Date().toISOString(),
      data: {
        minimalCart: {
          items: [],
          idempotencyKey: '',
          placedSale: {
            saleId: PLACED_SALE_ID,
            folio: 'F-0042',
            totalCents: 150_000,
          },
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
    await pool.query(
      'TRUNCATE conversation_state, receipt_media_cancellation_commands,' +
        ' receipt_media_outbox, receipt_media, processed_webhook_messages',
    );
  });

  it('admits a captioned receipt image silently with no amount prompt', async () => {
    await post(imageBody('wamid.img', 'media.img', 'transferí 1500'));
    expect(await receipts()).toEqual([
      {
        webhook_message_id: 'wamid.img',
        status: 'RESERVED',
        declared_mime_type: 'image/jpeg',
        declared_amount_cents: 150_000,
      },
    ]);
    expect(sent).toEqual([]);
    expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
  });

  it('admits a PDF document receipt like an image (S8)', async () => {
    await post(pdfBody('wamid.pdf', 'media.pdf'));
    expect(await receipts()).toMatchObject([
      { status: 'RESERVED', declared_mime_type: 'application/pdf' },
    ]);
    expect(sent).toEqual([]);
  });

  it('sends customer text to the agent even while a receipt is in progress (R6)', async () => {
    await post(imageBody('wamid.img2', 'media.img2'));
    await post(textBody('wamid.txt', 'CONFIRMAR'));
    expect(minimalAgent.tryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: CUSTOMER, text: 'CONFIRMAR' }),
    );
    expect(sent).toEqual([{ to: CUSTOMER, text: 'AGENT-REPLY' }]);
    expect((await receipts())[0].status).toBe('RESERVED');
  });

  it('answers a second receipt while one is still processing', async () => {
    await post(imageBody('wamid.a', 'media.a'));
    await post(imageBody('wamid.b', 'media.b'));
    expect(await receipts()).toHaveLength(1);
    expect(sent).toEqual([{ to: CUSTOMER, text: IN_PROGRESS }]);
  });

  it('does not re-admit or reply on a re-delivered receipt webhook', async () => {
    await post(imageBody('wamid.dup', 'media.dup'));
    await post(imageBody('wamid.dup', 'media.dup'));
    expect(await receipts()).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});
