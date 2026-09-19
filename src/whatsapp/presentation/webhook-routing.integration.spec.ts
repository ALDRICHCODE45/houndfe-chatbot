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
  PendingHumanRequest,
  ReceiptAmountPointer,
} from '../../conversation/domain/conversation-store';
import { PostgresConversationStore } from '../../conversation/infrastructure/postgres-conversation.store';
import {
  PENDING_HUMAN_REQUEST_REPLY,
  type HumanHandoffResolveReplyResult,
  type HumanHandoffService,
} from '../../human-handoff/application/human-handoff.service';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import { ReceiptAmountRouterService } from '../../receipt-media/application/receipt-amount-router.service';
import type {
  ReceiptAmountRouteInput,
  ReceiptAmountRouteOutcome,
} from '../../receipt-media/application/receipt-amount-router.service';
import { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type {
  ReceiptIngressDecision,
  ReceiptIngressInput,
} from '../../receipt-media/application/receipt-ingress.service';
import type {
  ReservationOutcome,
  ReserveInput,
} from '../../receipt-media/domain/receipt-media-store.port';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../../receipt-media/domain/receipt-media.types';
import { PostgresReceiptMediaStore } from '../../receipt-media/infrastructure/postgres-receipt-media.store';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { InMemoryRecentOutboundStore } from '../infrastructure/in-memory-recent-outbound.store';
import { PostgresWebhookDedupStore } from '../infrastructure/postgres-webhook-dedup.store';
import { SignatureGuard } from './signature.guard';
import { WebhookController } from './webhook.controller';

/**
 * ODD-4E consolidated receipt-routing evidence (customer-visible precedence,
 * sequential terminals, caption/follow-up, and duplicate-event triangulation).
 *
 * This is a tests-only aggregate slice over already-committed ODD-4A/4B/4C/4D
 * behavior. It composes the REAL SignatureGuard + WebhookController +
 * WebhookDispatcherService + ReceiptIngressService + ReceiptAmountRouterService
 * + PostgresReceiptMediaStore + PostgresConversationStore +
 * PostgresWebhookDedupStore + InMemoryRecentOutboundStore over one
 * Testcontainers PostgreSQL 16 instance with the production migrations applied.
 * The only deterministic fakes are MetaWhatsappSender, AgentRunner, and
 * HumanHandoffService; no external network call is performed. The real receipt
 * store is driven through claim/download/bootstrap directly (no worker,
 * dispatcher-as-worker, or module composition is exercised), which is the
 * closest honest boundary for routing evidence.
 *
 * Protocol: this tests-only slice has no honest behavior RED. It follows the
 * established ODD-2E baseline-first protocol: baselines were recorded before
 * any write, the first valid run is expected GREEN, and a valid behavioral
 * failure would be a real production defect (the slice must then stop rather
 * than edit production). It proves successful persisted-marker replay only; the
 * best-effort markSeen failure path is already covered by focused unit
 * evidence, so exactly-once is NOT claimed here.
 *
 * Gated by RUN_DOCKER_TESTS=1 like the other Testcontainers suites.
 */

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'verify-token';
const PLACED_SALE_ID = '4f7c2f9e-1f30-4a2b-8c3d-0f1e2d3c4b5a';
const OPS_PHONE = '5215550000000';
const CUSTOMER = '5215550001111';
const ACTIVE_GUIDANCE = 'Tienes un proceso abierto: finalízalo o cancélalo.';

type Identity = { wamid: string; mediaId: string; senderId: string };
type SentText = { to: string; text: string; providerMessageId: string };

const sign = (body: string): string =>
  `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

const textBody = (wamid: string, senderId: string, text: string): string =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: wamid,
                  from: senderId,
                  timestamp: '1719000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

const mediaBody = (
  wamid: string,
  senderId: string,
  mediaId: string,
  caption?: string,
): string =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: wamid,
                  from: senderId,
                  timestamp: '1719000000',
                  type: 'image',
                  image: {
                    id: mediaId,
                    mime_type: 'image/jpeg',
                    ...(caption === undefined ? {} : { caption }),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

interface ReceiptRow {
  id: string;
  status: string;
  version: string;
  declared_amount_cents: number | null;
  webhook_message_id: string;
  provider_media_id: string;
  attach_attempt_id: string | null;
}

interface OutboxRow {
  dedupe_key: string;
  template_key: string;
  template_args: Record<string, unknown>;
  receipt_media_id: string | null;
  receipt_state_version: string | null;
  source_webhook_message_id: string;
  recipient_id: string;
}

interface BootstrapResult {
  receipt: ReceiptMediaRow;
  intent: ReceiptMediaOutboxRow;
  downloadVersion: string;
}

interface Harness {
  app: INestApplication;
  store: PostgresReceiptMediaStore;
  conversations: PostgresConversationStore;
  dedup: PostgresWebhookDedupStore;
  recentOutbound: InMemoryRecentOutboundStore;
  sent: SentText[];
  // Transparent call observation around the REAL router and the REAL ingress:
  // jest.spyOn keeps the composed implementations and records each invocation.
  routeSpy: jest.SpyInstance<
    Promise<ReceiptAmountRouteOutcome>,
    [ReceiptAmountRouteInput]
  >;
  admitSpy: jest.SpyInstance<
    Promise<ReceiptIngressDecision>,
    [ReceiptIngressInput]
  >;
  // Transparent observation of the REAL admission primitive so tests can
  // distinguish a genuine admission from ODD-4C sender-active interception.
  storeAdmitSpy: jest.SpyInstance<Promise<ReservationOutcome>, [ReserveInput]>;
  sender: {
    sendText: jest.Mock<
      Promise<{ providerMessageId: string }>,
      [{ to: string; text: string }]
    >;
  };
  agentRunner: {
    handle: jest.Mock<
      Promise<{ reply: string }>,
      [{ senderId: string; text: string }]
    >;
  };
  handoff: {
    isOpsSender: jest.Mock<boolean, [string]>;
    resolveReply: jest.Mock<
      Promise<HumanHandoffResolveReplyResult>,
      [{ text: string; from: string }]
    >;
  };
  close: () => Promise<void>;
}

ddescribe('Webhook receipt routing integration (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let seq = 0;
  let outboundSeq = 0;
  const harnesses: Harness[] = [];

  const configValues: Record<string, string> = {
    'meta.appSecret': APP_SECRET,
    'meta.verifyToken': VERIFY_TOKEN,
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;

  const identity = (label: string): Identity => {
    seq += 1;
    return {
      wamid: `wamid.${label}.${seq}`,
      mediaId: `media.${label}.${seq}`,
      senderId: `sender.${label}.${seq}`,
    };
  };

  const ownerFor = (label: string): string => `test:${label}:${++seq}`;

  const postSigned = (app: INestApplication, body: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body);

  const lastSent = (h: Harness): SentText => {
    const sent = h.sent[h.sent.length - 1];
    if (!sent) throw new Error('no outbound message was sent');
    return sent;
  };

  const receiptRow = async (id: string): Promise<ReceiptRow> => {
    const { rows } = await pool.query<ReceiptRow>(
      `SELECT id, status, version, declared_amount_cents, webhook_message_id,
              provider_media_id, attach_attempt_id
         FROM receipt_media WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error(`receipt ${id} not found`);
    return row;
  };

  const receiptByWamid = async (wamid: string): Promise<ReceiptRow> => {
    const { rows } = await pool.query<ReceiptRow>(
      `SELECT id, status, version, declared_amount_cents, webhook_message_id,
              provider_media_id, attach_attempt_id
         FROM receipt_media WHERE webhook_message_id = $1`,
      [wamid],
    );
    const row = rows[0];
    if (!row) throw new Error(`receipt for ${wamid} not found`);
    return row;
  };

  const receiptCount = async (): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM receipt_media',
    );
    return Number(rows[0].count);
  };

  const outboxRows = async (): Promise<OutboxRow[]> =>
    (
      await pool.query<OutboxRow>(
        `SELECT dedupe_key, template_key, template_args, receipt_media_id,
                receipt_state_version, source_webhook_message_id, recipient_id
           FROM receipt_media_outbox ORDER BY created_at`,
      )
    ).rows;

  const markerRows = async (): Promise<string[]> =>
    (
      await pool.query<{ message_id: string }>(
        'SELECT message_id FROM processed_webhook_messages ORDER BY message_id',
      )
    ).rows.map((row) => row.message_id);

  const readPointer = async (
    conversations: PostgresConversationStore,
    senderId: string,
  ): Promise<ReceiptAmountPointer | null> => {
    const state = await conversations.get(senderId);
    return state?.data?.receiptAmountPointer ?? null;
  };

  const seedPlacedSale = async (
    h: Harness,
    senderId: string,
  ): Promise<void> => {
    await h.conversations.update(senderId, {
      lastMessageAt: new Date().toISOString(),
      data: { placedSaleId: PLACED_SALE_ID },
    });
  };

  const nextVersion = (version: string): string => String(BigInt(version) + 1n);

  /**
   * Drives the real store through the ingestion sequence a worker would run
   * (claim → start Meta attempt → commit download → bootstrap amount) without
   * any worker or module composition. `declared_amount_cents` from ODD-4A
   * selects the bootstrap successor (prompt vs confirmation).
   */
  const driveToBootstrap = async (
    store: PostgresReceiptMediaStore,
    receiptId: string,
    owner: string,
  ): Promise<BootstrapResult> => {
    const claimed = (await store.claimBatch(1, owner)).find(
      (row) => row.id === receiptId,
    );
    if (!claimed) throw new Error('claim did not return the receipt');
    const attempt = await store.startMetaAttempt({
      id: receiptId,
      owner,
      expectedVersion: claimed.version,
    });
    if (!attempt) throw new Error('startMetaAttempt was refused');
    const download = await store.commitDownload({
      id: receiptId,
      owner,
      expectedVersion: attempt.version,
      responseMimeType: 'image/jpeg',
      detectedMimeType: 'image/jpeg',
      byteCount: 4096,
      contentSha256: Buffer.alloc(32, 9),
    });
    if (download.kind !== 'committed')
      throw new Error(`commitDownload not committed: ${download.kind}`);
    const downloadVersion = nextVersion(attempt.version);
    const bootstrapped = await store.bootstrapAmount({
      id: receiptId,
      owner,
      expectedVersion: downloadVersion,
      objectEtag: 'etag-1',
      objectVersionId: null,
      capabilityTokenHash: Buffer.alloc(32, 11),
      capabilityKeyVersion: '1',
    });
    if (bootstrapped.kind !== 'bootstrapped')
      throw new Error(`bootstrapAmount not bootstrapped: ${bootstrapped.kind}`);
    return {
      receipt: bootstrapped.receipt,
      intent: bootstrapped.intent,
      downloadVersion,
    };
  };

  const buildHarness = async (): Promise<Harness> => {
    const store = new PostgresReceiptMediaStore(pool);
    const conversations = new PostgresConversationStore(pool);
    const dedup = new PostgresWebhookDedupStore(pool);
    const recentOutbound = new InMemoryRecentOutboundStore();
    const sent: SentText[] = [];
    const sender = {
      sendText: jest.fn<
        Promise<{ providerMessageId: string }>,
        [{ to: string; text: string }]
      >((message) => {
        const providerMessageId = `wamid.bot.${++outboundSeq}`;
        sent.push({ to: message.to, text: message.text, providerMessageId });
        return Promise.resolve({ providerMessageId });
      }),
    };
    const agentRunner = {
      handle: jest.fn<
        Promise<{ reply: string }>,
        [{ senderId: string; text: string }]
      >(() => Promise.resolve({ reply: 'AGENT-REPLY' })),
    };
    const handoff = {
      isOpsSender: jest.fn<boolean, [string]>(() => false),
      resolveReply: jest.fn<
        Promise<HumanHandoffResolveReplyResult>,
        [{ text: string; from: string }]
      >(() => Promise.resolve({ kind: 'no_pending', reply: 'ASK_FOR_REF' })),
    };

    // Real receipt ingress + real amount router over the real durable stores.
    const ingress = new ReceiptIngressService(
      { enabled: true },
      { getState: (senderId: string) => conversations.get(senderId) },
      store,
    );
    const amountRouter = new ReceiptAmountRouterService(conversations, store);

    const dispatcher = new WebhookDispatcherService(
      agentRunner as unknown as AgentRunner,
      sender,
      dedup,
      recentOutbound,
      handoff as unknown as HumanHandoffService,
      conversations,
      amountRouter,
      ingress,
    );

    // Transparent spies: the real router/ingress/store methods still execute;
    // the spies only record invocations and resolved values.
    const routeSpy = jest.spyOn(amountRouter, 'route');
    const admitSpy = jest.spyOn(ingress, 'admit');
    const storeAdmitSpy = jest.spyOn(store, 'admit');

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        SignatureGuard,
        { provide: ConfigService, useValue: configService },
        { provide: WebhookDispatcherService, useValue: dispatcher },
      ],
    }).compile();

    const app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
    };
    const harness: Harness = {
      app,
      store,
      conversations,
      dedup,
      recentOutbound,
      sent,
      routeSpy,
      admitSpy,
      storeAdmitSpy,
      sender,
      agentRunner,
      handoff,
      close,
    };
    harnesses.push(harness);
    return harness;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.close()));
    await pool.query(
      'TRUNCATE conversation_state, receipt_media_cancellation_commands,' +
        ' receipt_media_outbox, receipt_media, processed_webhook_messages',
    );
  });

  it('applies a real recent-outbound echo and a real durable marker before every downstream route', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    // No pointer yet: the ordinary text reaches the agent and the outbound id
    // is remembered in the real in-memory window.
    await postSigned(
      h.app,
      textBody('wamid.echo.source.1', CUSTOMER, 'hola'),
    ).expect(200);
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(1);
    const rememberedId = lastSent(h).providerMessageId;

    // The remembered outbound id re-delivered as an inbound is skipped by the
    // echo filter: no marker, no agent turn.
    await postSigned(h.app, textBody(rememberedId, CUSTOMER, 'hola')).expect(
      200,
    );
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(1);
    expect(await markerRows()).not.toContain(rememberedId);

    // The real durable marker short-circuits BEFORE the ops hook: an ops-sender
    // message already marked seen never reaches resolveReply.
    h.handoff.isOpsSender.mockReturnValue(true);
    await h.dedup.markSeen('wamid.pre.dedup.1');
    await postSigned(
      h.app,
      textBody('wamid.pre.dedup.1', OPS_PHONE, 'sí'),
    ).expect(200);
    expect(h.handoff.resolveReply).not.toHaveBeenCalled();
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(1);
  });

  it('runs an ops reply through the real handoff hook and bypasses router and ingress', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    // Build a genuinely active receipt with a durable pointer.
    const { wamid, mediaId } = identity('ops-media');
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, mediaId, '$1,234.50'),
    ).expect(200);
    const receiptId = (await receiptByWamid(wamid)).id;
    await driveToBootstrap(h.store, receiptId, ownerFor('ops'));
    expect((await receiptRow(receiptId)).status).toBe('AWAITING_CONFIRMATION');
    const pointerBefore = await readPointer(h.conversations, CUSTOMER);
    expect(pointerBefore).not.toBeNull();

    h.handoff.isOpsSender.mockImplementation((sender) => sender === OPS_PHONE);
    h.handoff.resolveReply.mockResolvedValue({
      kind: 'resolved',
      customerId: CUSTOMER,
      ref: 'HF-abc123abc123',
      resolution: { decision: 'GENERIC', text: 'listo' },
      syntheticUserText: 'TURNO_SINTETICO',
    });

    // Direct bypass observation: the setup media flow traversed the real
    // ingress and the real admission primitive exactly once. Capture the live
    // counts before the ops message.
    expect(h.admitSpy).toHaveBeenCalledTimes(1);
    expect(h.storeAdmitSpy).toHaveBeenCalledTimes(1);
    const routeCallsBeforeOps = h.routeSpy.mock.calls.length;
    const ingressCallsBeforeOps = h.admitSpy.mock.calls.length;
    const storeAdmitsBeforeOps = h.storeAdmitSpy.mock.calls.length;

    // The ops text would route as `sí` for the customer, but the ops hook runs
    // first: the synthetic turn reaches the agent and the reply goes to the
    // customer, while the receipt pointer is never consulted.
    await postSigned(
      h.app,
      textBody('wamid.ops.resolved.1', OPS_PHONE, 'HF-abc123abc123: sí'),
    ).expect(200);

    expect(h.handoff.resolveReply).toHaveBeenCalledTimes(1);

    // The ops branch bypassed the real router AND the real ingress/admission:
    // none of the three observed call counts moved.
    expect(h.routeSpy.mock.calls.length).toBe(routeCallsBeforeOps);
    expect(h.admitSpy.mock.calls.length).toBe(ingressCallsBeforeOps);
    expect(h.storeAdmitSpy.mock.calls.length).toBe(storeAdmitsBeforeOps);
    expect(h.agentRunner.handle).toHaveBeenCalledWith({
      senderId: CUSTOMER,
      text: 'TURNO_SINTETICO',
    });
    expect(lastSent(h)).toMatchObject({
      to: CUSTOMER,
      text: 'AGENT-REPLY',
    });

    const after = await receiptRow(receiptId);
    expect(after.status).toBe('AWAITING_CONFIRMATION');
    expect(await readPointer(h.conversations, CUSTOMER)).toEqual(pointerBefore);
    expect((await outboxRows()).map((row) => row.template_key)).toEqual([
      'RECEIPT_AMOUNT_CONFIRM',
    ]);
  });

  it('lets a durable pending-human marker win over an active receipt pointer', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    const { wamid, mediaId } = identity('pending-media');
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, mediaId, '$1,234.50'),
    ).expect(200);
    const receiptId = (await receiptByWamid(wamid)).id;
    await driveToBootstrap(h.store, receiptId, ownerFor('pending'));
    const before = await receiptRow(receiptId);
    expect(await readPointer(h.conversations, CUSTOMER)).not.toBeNull();

    const pending: PendingHumanRequest = {
      requestId: 'aaaabbbbcccc',
      ref: 'HF-aaaabbbbcccc',
      createdAt: new Date().toISOString(),
      customerNotifiedAt: new Date().toISOString(),
    };
    // The store's read-modify-write preserves the existing pointer while
    // setting the pending marker in the real `conversation_state`.
    await h.conversations.update(CUSTOMER, {
      lastMessageAt: new Date().toISOString(),
      data: { placedSaleId: PLACED_SALE_ID, pendingHumanRequest: pending },
    });
    expect(await readPointer(h.conversations, CUSTOMER)).not.toBeNull();

    await postSigned(
      h.app,
      textBody('wamid.pending.si.1', CUSTOMER, 'sí'),
    ).expect(200);

    expect(lastSent(h)).toMatchObject({
      to: CUSTOMER,
      text: PENDING_HUMAN_REQUEST_REPLY,
    });
    expect(h.agentRunner.handle).not.toHaveBeenCalled();
    const after = await receiptRow(receiptId);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(await readPointer(h.conversations, CUSTOMER)).not.toBeNull();
    expect(await markerRows()).toContain('wamid.pending.si.1');
  });

  it('routes text exclusively through the amount router and media exclusively through ingress', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    // Without a pointer, text fences and falls through to the LLM; no receipt,
    // no intent.
    await postSigned(
      h.app,
      textBody('wamid.llm.only.1', CUSTOMER, 'quiero comprar'),
    ).expect(200);
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(1);
    expect(await receiptCount()).toBe(0);
    expect(await outboxRows()).toHaveLength(0);

    // Media creates the receipt through ingress and drives to confirmation.
    const { wamid, mediaId } = identity('exclusive-media');
    await postSigned(h.app, mediaBody(wamid, CUSTOMER, mediaId, '$500')).expect(
      200,
    );
    const receiptId = (await receiptByWamid(wamid)).id;
    await driveToBootstrap(h.store, receiptId, ownerFor('exclusive'));

    // Text routes through the amount router: `no` rejects the proposal.
    await postSigned(
      h.app,
      textBody('wamid.exclusive.no.1', CUSTOMER, 'no'),
    ).expect(200);
    const rejected = await receiptRow(receiptId);
    expect(rejected.status).toBe('AWAITING_AMOUNT');
    expect(rejected.declared_amount_cents).toBeNull();

    // Media with an active receipt goes through ingress (sender-active
    // guidance) and never the router: the receipt is untouched and no row is
    // created.
    const before = await receiptRow(receiptId);
    await postSigned(
      h.app,
      mediaBody('wamid.exclusive.media.2', CUSTOMER, 'media.exclusive.media.2'),
    ).expect(200);
    expect(lastSent(h).text).toBe(ACTIVE_GUIDANCE);
    const after = await receiptRow(receiptId);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(after.declared_amount_cents).toBe(before.declared_amount_cents);
    expect(await receiptCount()).toBe(1);
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(1);
  });

  it('bootstraps a captioned receipt to confirmation and starts attachment on `sí` without duplicate replay', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    const { wamid, mediaId } = identity('caption');
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, mediaId, '$1,234.50'),
    ).expect(200);
    const reserved = await receiptByWamid(wamid);
    expect(reserved.status).toBe('RESERVED');
    expect(reserved.declared_amount_cents).toBe(123450);
    // Admission is silent for `reserved` and its marker is committed atomically.
    expect(h.sent).toHaveLength(0);
    expect(await markerRows()).toEqual([wamid]);

    const boot = await driveToBootstrap(
      h.store,
      reserved.id,
      ownerFor('caption'),
    );
    expect(boot.receipt.status).toBe('AWAITING_CONFIRMATION');
    expect(boot.intent.templateKey).toBe('RECEIPT_AMOUNT_CONFIRM');
    expect(boot.intent.templateArgs).toEqual({ amountCents: 123450 });
    expect((await outboxRows()).map((row) => row.dedupe_key)).toEqual([
      `receipt-amount-confirm:${reserved.id}:${boot.downloadVersion}:${wamid}`,
    ]);
    expect(await readPointer(h.conversations, CUSTOMER)).toMatchObject({
      receiptMediaId: reserved.id,
      receiptVersion: boot.receipt.version,
    });

    // Signed `sí` drives the real router → real startAttachment.
    await postSigned(
      h.app,
      textBody('wamid.caption.si.1', CUSTOMER, 'sí'),
    ).expect(200);
    const attaching = await receiptRow(reserved.id);
    expect(attaching.status).toBe('ATTACHING');
    expect(await readPointer(h.conversations, CUSTOMER)).toBeNull();
    expect((await outboxRows()).map((row) => row.dedupe_key)).toEqual([
      `receipt-amount-confirm:${reserved.id}:${boot.downloadVersion}:${wamid}`,
      `receipt-in-progress:${reserved.id}:${boot.receipt.version}:wamid.caption.si.1`,
    ]);

    // Successful persisted-marker replay of the same `sí`: durable dedup skips
    // it, so no second transition, intent, or agent turn.
    await postSigned(
      h.app,
      textBody('wamid.caption.si.1', CUSTOMER, 'sí'),
    ).expect(200);
    const replayed = await receiptRow(reserved.id);
    expect(replayed.status).toBe('ATTACHING');
    expect(replayed.version).toBe(attaching.version);
    expect(await outboxRows()).toHaveLength(2);
    expect(h.agentRunner.handle).not.toHaveBeenCalled();
  });

  it('bootstraps an uncaptioned receipt to the amount prompt and proposes `$500` through the real router', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    const { wamid, mediaId } = identity('nullcaption');
    await postSigned(h.app, mediaBody(wamid, CUSTOMER, mediaId)).expect(200);
    const reserved = await receiptByWamid(wamid);
    expect(reserved.status).toBe('RESERVED');
    expect(reserved.declared_amount_cents).toBeNull();

    const boot = await driveToBootstrap(
      h.store,
      reserved.id,
      ownerFor('nullcaption'),
    );
    expect(boot.receipt.status).toBe('AWAITING_AMOUNT');
    expect(boot.intent.templateKey).toBe('RECEIPT_AMOUNT_PROMPT');
    expect(boot.intent.templateArgs).toEqual({});

    await postSigned(
      h.app,
      textBody('wamid.null.amount.1', CUSTOMER, '$500'),
    ).expect(200);
    const proposed = await receiptRow(reserved.id);
    expect(proposed.status).toBe('AWAITING_CONFIRMATION');
    expect(proposed.declared_amount_cents).toBe(50000);
    const intents = await outboxRows();
    expect(intents.map((row) => row.template_key)).toEqual([
      'RECEIPT_AMOUNT_PROMPT',
      'RECEIPT_AMOUNT_CONFIRM',
    ]);
    expect(intents[1].template_args).toEqual({ amountCents: 50000 });
    expect(await readPointer(h.conversations, CUSTOMER)).toMatchObject({
      receiptMediaId: reserved.id,
      saleId: PLACED_SALE_ID,
      receiptVersion: proposed.version,
    });
  });

  it('sequences reject, re-propose, and cancel while clearing the durable pointer', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    const { wamid, mediaId } = identity('terminals');
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, mediaId, '$1,234.50'),
    ).expect(200);
    const receiptId = (await receiptByWamid(wamid)).id;
    await driveToBootstrap(h.store, receiptId, ownerFor('terminals'));

    // Reject → back to AWAITING_AMOUNT with a re-ask intent and cleared amount.
    const beforeReject = await receiptRow(receiptId);
    await postSigned(h.app, textBody('wamid.term.no.1', CUSTOMER, 'no')).expect(
      200,
    );
    const rejected = await receiptRow(receiptId);
    expect(rejected.status).toBe('AWAITING_AMOUNT');
    expect(rejected.declared_amount_cents).toBeNull();
    expect((await outboxRows()).at(-1)).toMatchObject({
      template_key: 'RECEIPT_AMOUNT_REASK',
      template_args: {},
      dedupe_key: `receipt-amount-reask:${receiptId}:${beforeReject.version}:wamid.term.no.1`,
    });

    // A later re-proposal is permitted from the re-asked state.
    const beforePropose = await receiptRow(receiptId);
    await postSigned(
      h.app,
      textBody('wamid.term.amount.1', CUSTOMER, '$700'),
    ).expect(200);
    const reproposed = await receiptRow(receiptId);
    expect(reproposed.status).toBe('AWAITING_CONFIRMATION');
    expect(reproposed.declared_amount_cents).toBe(70000);
    expect((await outboxRows()).at(-1)).toMatchObject({
      template_key: 'RECEIPT_AMOUNT_CONFIRM',
      template_args: { amountCents: 70000 },
      dedupe_key: `receipt-amount-confirm:${receiptId}:${beforePropose.version}:wamid.term.amount.1`,
    });

    // Cancel clears the durable pointer and owns the cancel intent.
    const beforeCancel = await receiptRow(receiptId);
    await postSigned(
      h.app,
      textBody('wamid.term.cancel.1', CUSTOMER, 'cancelar'),
    ).expect(200);
    const cancelled = await receiptRow(receiptId);
    expect(cancelled.status).toBe('CANCELLED');
    expect(await readPointer(h.conversations, CUSTOMER)).toBeNull();
    expect((await outboxRows()).at(-1)).toMatchObject({
      template_key: 'RECEIPT_CANCELLED',
      dedupe_key: `receipt-cancel:${receiptId}:${beforeCancel.version}:wamid.term.cancel.1`,
    });

    // With the pointer gone, a later `sí` fences through to the LLM instead of
    // transitioning the cancelled receipt.
    const callsBefore = h.agentRunner.handle.mock.calls.length;
    await postSigned(
      h.app,
      textBody('wamid.term.si.after-cancel', CUSTOMER, 'sí'),
    ).expect(200);
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(callsBefore + 1);
    const afterCancel = await receiptRow(receiptId);
    expect(afterCancel.status).toBe('CANCELLED');
    expect(afterCancel.version).toBe(cancelled.version);
  });

  it('clears the durable pointer on an attachment start so a later `sí` fences through to the LLM', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    const { wamid, mediaId } = identity('start-clear');
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, mediaId, '$1,234.50'),
    ).expect(200);
    const receiptId = (await receiptByWamid(wamid)).id;
    await driveToBootstrap(h.store, receiptId, ownerFor('start-clear'));

    await postSigned(
      h.app,
      textBody('wamid.startclear.si.1', CUSTOMER, 'sí'),
    ).expect(200);
    const attaching = await receiptRow(receiptId);
    expect(attaching.status).toBe('ATTACHING');
    expect(await readPointer(h.conversations, CUSTOMER)).toBeNull();

    const callsBefore = h.agentRunner.handle.mock.calls.length;
    await postSigned(
      h.app,
      textBody('wamid.startclear.si.2', CUSTOMER, 'sí'),
    ).expect(200);
    expect(h.agentRunner.handle).toHaveBeenCalledTimes(callsBefore + 1);
    const afterSecond = await receiptRow(receiptId);
    expect(afterSecond.status).toBe('ATTACHING');
    expect(afterSecond.version).toBe(attaching.version);
    expect((await outboxRows()).map((row) => row.template_key)).toEqual([
      'RECEIPT_AMOUNT_CONFIRM',
      'RECEIPT_IN_PROGRESS',
    ]);
  });

  it('performs no second transition, intent, guidance, or store write on successful-marker replay', async () => {
    const h = await buildHarness();
    await seedPlacedSale(h, CUSTOMER);

    const { wamid, mediaId } = identity('dup');
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, mediaId, '$1,234.50'),
    ).expect(200);
    const receiptId = (await receiptByWamid(wamid)).id;
    await driveToBootstrap(h.store, receiptId, ownerFor('dup'));
    expect((await receiptRow(receiptId)).status).toBe('AWAITING_CONFIRMATION');

    // (a) Active-image guidance, then its successful-marker replay.
    const guideWamid = 'wamid.dup.image-guide.1';
    const guideMedia = 'media.dup.image-guide.1';
    await postSigned(h.app, mediaBody(guideWamid, CUSTOMER, guideMedia)).expect(
      200,
    );
    expect(lastSent(h)).toMatchObject({ to: CUSTOMER, text: ACTIVE_GUIDANCE });
    const receiptsAfterGuide = await receiptCount();
    const sendsAfterGuide = h.sent.length;
    await postSigned(h.app, mediaBody(guideWamid, CUSTOMER, guideMedia)).expect(
      200,
    );
    expect(h.sent.length).toBe(sendsAfterGuide);
    expect(await receiptCount()).toBe(receiptsAfterGuide);

    // (b) Active-text `unrecognized` guidance, then its replay.
    const textWamid = 'wamid.dup.text-guide.1';
    await postSigned(h.app, textBody(textWamid, CUSTOMER, 'hola')).expect(200);
    expect(lastSent(h).text).toBe(ACTIVE_GUIDANCE);
    const sendsAfterText = h.sent.length;
    await postSigned(h.app, textBody(textWamid, CUSTOMER, 'hola')).expect(200);
    expect(h.sent.length).toBe(sendsAfterText);
    expect(h.agentRunner.handle).not.toHaveBeenCalled();

    // (c) Provider-media reuse retains the first durable amount. Direct
    // observation excludes ODD-4C sender-active interception: the media route
    // increments the real ingress and the real store admission exactly once,
    // the admission resolves as provider-media-reused (not sender-active), no
    // guidance is sent, and the text router is untouched.
    const reuseWamid = 'wamid.dup.reuse.1';
    const routeCallsBeforeReuse = h.routeSpy.mock.calls.length;
    const ingressCallsBeforeReuse = h.admitSpy.mock.calls.length;
    const storeAdmitsBeforeReuse = h.storeAdmitSpy.mock.calls.length;
    const sendsBeforeReuse = h.sent.length;
    await postSigned(
      h.app,
      mediaBody(reuseWamid, CUSTOMER, mediaId, '$9.99'),
    ).expect(200);
    expect(h.routeSpy.mock.calls.length).toBe(routeCallsBeforeReuse);
    expect(h.admitSpy.mock.calls.length).toBe(ingressCallsBeforeReuse + 1);
    expect(h.storeAdmitSpy.mock.calls.length).toBe(storeAdmitsBeforeReuse + 1);
    const reusePromise = h.storeAdmitSpy.mock.results[
      h.storeAdmitSpy.mock.results.length - 1
    ].value as Promise<ReservationOutcome>;
    expect((await reusePromise).kind).toBe('provider-media-reused');
    expect(h.sent.length).toBe(sendsBeforeReuse);
    expect((await receiptRow(receiptId)).declared_amount_cents).toBe(123450);
    expect(await receiptCount()).toBe(receiptsAfterGuide);

    // (d) Webhook-media conflict (a legacy markerless row) retains the first
    // durable media and amount while backfilling the marker. The same direct
    // observation excludes sender-active interception: the admission resolves
    // as webhook-media-conflict with no guidance send and no router call.
    await pool.query(
      'DELETE FROM processed_webhook_messages WHERE message_id = $1',
      [wamid],
    );
    const routeCallsBeforeConflict = h.routeSpy.mock.calls.length;
    const ingressCallsBeforeConflict = h.admitSpy.mock.calls.length;
    const storeAdmitsBeforeConflict = h.storeAdmitSpy.mock.calls.length;
    const sendsBeforeConflict = h.sent.length;
    await postSigned(
      h.app,
      mediaBody(wamid, CUSTOMER, 'media.dup.different.1'),
    ).expect(200);
    expect(h.routeSpy.mock.calls.length).toBe(routeCallsBeforeConflict);
    expect(h.admitSpy.mock.calls.length).toBe(ingressCallsBeforeConflict + 1);
    expect(h.storeAdmitSpy.mock.calls.length).toBe(
      storeAdmitsBeforeConflict + 1,
    );
    const conflictPromise = h.storeAdmitSpy.mock.results[
      h.storeAdmitSpy.mock.results.length - 1
    ].value as Promise<ReservationOutcome>;
    expect((await conflictPromise).kind).toBe('webhook-media-conflict');
    expect(h.sent.length).toBe(sendsBeforeConflict);
    const conflicted = await receiptRow(receiptId);
    expect(conflicted.provider_media_id).toBe(mediaId);
    expect(conflicted.declared_amount_cents).toBe(123450);

    // (e) Exact marker ownership: only the four processed WAMIDs exist.
    expect(await markerRows()).toEqual(
      [wamid, guideWamid, textWamid, reuseWamid].sort(),
    );

    // (f) Replay after app/adapter recreation over the same pool performs no
    // store operation and sends nothing.
    const outboxBefore = await outboxRows();
    const receiptBefore = await receiptRow(receiptId);
    await h.close();
    const rebuilt = await buildHarness();
    await postSigned(rebuilt.app, textBody(textWamid, CUSTOMER, 'hola')).expect(
      200,
    );
    expect(await outboxRows()).toEqual(outboxBefore);
    expect(await receiptRow(receiptId)).toMatchObject({
      status: receiptBefore.status,
      version: receiptBefore.version,
    });
    expect(rebuilt.sent).toHaveLength(0);
  });
});
