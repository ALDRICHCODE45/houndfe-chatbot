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
import type {
  ConversationStore,
  ConversationState,
} from '../../conversation/domain/conversation-store';
import { PostgresRestockInboundEvidenceStore } from '../../human-decisions/infrastructure/postgres-restock-inbound-evidence.store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import { PostgresReceiptMediaStore } from '../../receipt-media/infrastructure/postgres-receipt-media.store';
import { RestockInboundCapture } from '../application/restock-inbound-capture';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import {
  CUSTOMER_INBOUND_CAPTURE,
  customerInboundCaptureProvider,
} from '../infrastructure/customer-inbound-capture.provider';
import { PostgresWebhookDedupStore } from '../infrastructure/postgres-webhook-dedup.store';
import { SignatureGuard } from './signature.guard';
import { WebhookController } from './webhook.controller';

/**
 * G1 end-to-end webhook evidence with NO mocked inbound capture: real
 * SignatureGuard + WebhookController + RestockInboundCapture (Postgres store)
 * + customer-inbound capture (production provider factory, Postgres store) +
 * WebhookDispatcherService + ReceiptIngressService + PostgresReceiptMediaStore.
 * Proves media and Meta-only types (`unsupported`) acknowledge 200 instead of
 * the 500 that made Meta retry the batch forever.
 */

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

const APP_SECRET = 'meta-app-secret';
const PHONE_NUMBER_ID = '123456789';
const PLACED_SALE_ID = '4f7c2f9e-1f30-4a2b-8c3d-0f1e2d3c4b5a';

ddescribe('Webhook real-capture media integration (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let seq = 0;
  const sender = { sendText: jest.fn(), sendTemplate: jest.fn() };

  const configValues: Record<string, string> = {
    'meta.appSecret': APP_SECRET,
    'meta.verifyToken': 'verify-token',
    'meta.phoneNumberId': PHONE_NUMBER_ID,
  };
  const config = {
    get: jest.fn((key: string) => configValues[key]),
    getOrThrow: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const ids = () => {
    seq += 1;
    return { wamid: `wamid.real.${seq}`, from: `52155500000${seq}` };
  };
  const body = (message: Record<string, unknown>): string =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [
                  {
                    timestamp: String(Math.floor(Date.now() / 1000) - 60),
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  const postSigned = (raw: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/webhook')
      .set('content-type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      )
      .send(raw);
  const receipts = async () =>
    (
      await pool.query<{ webhook_message_id: string; status: string }>(
        'SELECT webhook_message_id, status FROM receipt_media ORDER BY webhook_message_id',
      )
    ).rows;
  const observationCount = async () =>
    (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM customer_inbound_observations',
      )
    ).rows[0].n;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });

    const state = {
      data: {
        minimalCart: {
          items: [],
          idempotencyKey: '',
          placedSale: {
            saleId: PLACED_SALE_ID,
            folio: null,
            totalCents: 150_000,
          },
        },
      },
    } as unknown as ConversationState;
    const conversations = {
      get: jest.fn(() => Promise.resolve(state)),
      getState: jest.fn(() => Promise.resolve(state)),
    };
    const handoff = {
      isOpsSender: jest.fn(() => false),
      resolveReply: jest.fn(),
    };
    const recent = { isKnown: jest.fn(() => false), remember: jest.fn() };
    const dispatcher = new WebhookDispatcherService(
      { handle: jest.fn() } as unknown as AgentRunner,
      sender,
      new PostgresWebhookDedupStore(pool),
      recent,
      handoff as unknown as HumanHandoffService,
      conversations as unknown as ConversationStore,
      new ReceiptIngressService(
        { getState: conversations.getState },
        new PostgresReceiptMediaStore(pool),
      ),
      { tryHandle: jest.fn() } as unknown as MinimalCatalogAgentService,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        SignatureGuard,
        { provide: ConfigService, useValue: config },
        { provide: WebhookDispatcherService, useValue: dispatcher },
        {
          provide: RestockInboundCapture,
          useValue: new RestockInboundCapture(
            PHONE_NUMBER_ID,
            new PostgresRestockInboundEvidenceStore(pool),
            () => false,
            () => false,
          ),
        },
        {
          provide: CUSTOMER_INBOUND_CAPTURE,
          useValue: customerInboundCaptureProvider.useFactory(
            config,
            pool,
            handoff,
            recent,
          ),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  it('acknowledges an image message and admits it to receipt ingress', async () => {
    const { wamid, from } = ids();
    await postSigned(
      body({
        id: wamid,
        from,
        type: 'image',
        image: { id: `media.${wamid}`, mime_type: 'image/jpeg' },
      }),
    )
      .expect(200)
      .expect({ received: true });
    expect(await receipts()).toContainEqual({
      webhook_message_id: wamid,
      status: 'RESERVED',
    });
  });

  it('acknowledges a PDF document message and admits it to receipt ingress', async () => {
    const { wamid, from } = ids();
    const before = await observationCount();
    await postSigned(
      body({
        id: wamid,
        from,
        type: 'document',
        document: { id: `media.${wamid}`, mime_type: 'application/pdf' },
      }),
    )
      .expect(200)
      .expect({ received: true });
    expect(await receipts()).toContainEqual({
      webhook_message_id: wamid,
      status: 'RESERVED',
    });
    // Real customer-inbound capture recorded the window observation.
    expect(await observationCount()).toBe(before + 1);
  });

  it('acknowledges an `unsupported` message with 200 and no receipt row', async () => {
    const { wamid, from } = ids();
    const before = await receipts();
    await postSigned(
      body({
        id: wamid,
        from,
        type: 'unsupported',
        errors: [{ code: 131051, title: 'Message type unknown' }],
      }),
    )
      .expect(200)
      .expect({ received: true });
    expect(await receipts()).toEqual(before);
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});
