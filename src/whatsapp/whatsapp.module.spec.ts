/** WU14D host composition spec: proves the real WhatsappModule graph boots
 * through the Nest testing module with ReceiptMediaModule imported, so the
 * WebhookDispatcherService's mandatory receipt dependency (ReceiptIngress
 * Service) resolves. External edges are stubbed only (no live PostgreSQL,
 * backend, Meta or LLM requests). Proven: the host graph composes with
 * dispatcher/ingress resolvable and the WHATSAPP_SENDER alias intact, also
 * without any receipt-specific setting (always on, R3/S7); the host
 * registers none of the private receipt workers (the ingestion and
 * notification drains are privately owned — no DI token — and their behavior
 * is proven through real init()/close(): claims through the SAME injected
 * pool and drain-before pool.end); and the host declares ReceiptMediaModule
 * among its imports. The ReceiptMediaModule-internal graph contract stays
 * covered by the module spec and is not duplicated here. */
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { AppConfigModule } from '../config/config.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { ReceiptIngestionProcessor } from '../receipt-media/application/receipt-ingestion.processor';
import { ReceiptIngressService } from '../receipt-media/application/receipt-ingress.service';
import { PostgresReceiptOutboxStore } from '../receipt-media/infrastructure/postgres-receipt-outbox.store';
import { ReceiptMediaIngestionWorker } from '../receipt-media/infrastructure/receipt-media-ingestion.worker';
import { ReceiptMediaNotificationWorker } from '../receipt-media/infrastructure/receipt-media-notification.worker';
import { ReceiptMediaModule } from '../receipt-media/receipt-media.module';
import { bindRestockInboundEvidence } from '../human-decisions/domain/restock-inbound-evidence';
import { RestockInboundCapture } from './application/restock-inbound-capture';
import {
  RECENT_OUTBOUND,
  type RecentOutboundStore,
} from './domain/recent-outbound.store';
import { WebhookDispatcherService } from './application/webhook-dispatcher.service';
import { WHATSAPP_SENDER } from './domain/whatsapp-sender.port';
import { MetaWhatsappSender } from './infrastructure/meta-whatsapp.sender';
import { WhatsappModule } from './whatsapp.module';

/** Tokens the receipt composition must never register, in either mode,
 * including when composed through the host. Both the ODD-3A ingestion worker
 * and the WU14E notification worker are token-less (privately owned by their
 * module-local lifecycle coordinators) — but token absence alone does not
 * prove a privately owned worker did not run, so their behavior is proven
 * through real init()/close() below. */
const FORBIDDEN_NONWORKER_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptMediaNotificationWorker,
  PostgresReceiptOutboxStore,
] as const;

/** Full-graph absence guard: non-strict Nest lookup searches the WHOLE
 * application context (every imported module), so a forbidden token
 * registered anywhere in the host graph — not just the testing root — makes
 * this guard fail. */
const expectNoReceiptWorkerProviders = (
  moduleRef: INestApplicationContext,
): void => {
  for (const absent of FORBIDDEN_NONWORKER_TOKENS)
    expect(() => {
      void moduleRef.get(absent);
    }).toThrow();
};

const BASE_ENV: Record<string, string> = {
  META_VERIFY_TOKEN: 't',
  META_APP_SECRET: 's',
  META_ACCESS_TOKEN: 'a',
  META_PHONE_NUMBER_ID: '1',
  CHATBOT_API_BASE_URL: 'https://api.example.com',
  SERVICE_KEY: 'svc_x',
  CHATBOT_API_BRANCH_ID: 'b',
  CHATBOT_API_CASHIER_USER_ID: '00000000-0000-4000-8000-000000000001',
  OPENAI_API_KEY: 'g',
  LLM_MODEL: 'm',
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  OPS_CHANNEL_PHONE: '5215500000000',
};

/** Receipt environment over the validated field set (always on). */
const RECEIPT_ENABLED_ENV: Record<string, string> = {
  ...BASE_ENV,
  RECEIPT_MEDIA_MAX_BYTES: '10485760',
  META_MEDIA_ALLOWED_HOSTS: 'graph.facebook.com,.meta.com',
  META_MEDIA_METADATA_TIMEOUT_MS: '5000',
  META_MEDIA_DOWNLOAD_TIMEOUT_MS: '30000',
  RECEIPT_MEDIA_WORKER_CONCURRENCY: '2',
  RECEIPT_MEDIA_WORKER_LEASE_MS: '60000',
  RECEIPT_MEDIA_WORKER_POLL_MS: '1000',
};

/** Snapshot of the pristine environment, restored after each test. */
const baseEnv: Record<string, string | undefined> = { ...process.env };

/** Stubs the pg pool: wiring only, never connects. */
const stubPool = () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
});

/** Bounded microtask drain: deterministic, no real timers/sleeps. */
const drainMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** Waits (microtask hops only, bounded) until a condition holds. */
const untilMicrotask = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !condition(); i++) await Promise.resolve();
};

/** Snake_case receipt_media_outbox row exactly as pg would deliver it. */
const outboxRow = (
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  recipient_id: '+525500000000',
  template_key: 'RECEIPT_PAYMENT_PARTIAL',
  template_args: { folio: 'F-1', debtCents: 123456 },
  status: 'PENDING',
  attempts: 0,
  lease_expires_at: new Date(1_700_000_000_000),
  ...over,
});

type OutboxPool = {
  pool: {
    query: jest.Mock;
    connect: jest.Mock;
    end: jest.Mock;
  };
  claims: Array<{ limit: unknown; owner: unknown }>;
  ingestionClaims: Array<{ limit: unknown; owner: unknown; sql: string }>;
  marks: string[];
  reschedules: number[];
  sequence: string[];
  queriesAfterEnd: () => number;
};

/** Instrumented fake pool for the REAL PostgresReceiptOutboxStore (same
 * fixture family as the WU14C module spec, kept local to this spec): `end`
 * records closure in the sequence; any query performed after closure is
 * counted and rejected, so a post-close claim/mark can never pass
 * silently through the REAL host graph. ODD-3A: the ingestion claim shares
 * this pool and is recorded separately (never in `sequence`) so the host
 * notification observations stay unconflated while the host ingestion drain
 * can still be observed. */
/** G2: the customer wrote within the 24 h window, so outcome intents send. */
const openWindowQuery = (text: unknown, params?: unknown[]) =>
  Promise.resolve(
    typeof text === 'string' &&
      text.includes('FROM customer_inbound_observations')
      ? {
          rows: [
            {
              receivingPhoneNumberId: params?.[1],
              senderId: params?.[0],
              messageId: 'wamid.inbound',
              providerTimestampSeconds: String(
                Math.floor(Date.now() / 1000) - 60,
              ),
              observedAt: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 },
  );

const makeOutboxPool = (
  batches: Array<Record<string, unknown>[]> = [],
  opts: {
    ingestion?: Array<Array<Record<string, unknown>>>;
  } = {},
): OutboxPool => {
  const pending = [...batches];
  const ingestionPending = [...(opts.ingestion ?? [])];
  const claims: Array<{ limit: unknown; owner: unknown }> = [];
  const ingestionClaims: Array<{
    limit: unknown;
    owner: unknown;
    sql: string;
  }> = [];
  const marks: string[] = [];
  const reschedules: number[] = [];
  const sequence: string[] = [];
  let queriesAfterEnd = 0;
  let ended = false;
  const clientQuery = async (
    text: unknown,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (ended) {
      queriesAfterEnd++;
      throw new Error('receipt-media test: pool already ended');
    }
    const sql =
      typeof text === 'string'
        ? text
        : ((text as { text?: string }).text ?? '');
    // One deterministic microtask hop per query keeps this async fixture
    // honest and satisfies the require-await invariant.
    await Promise.resolve();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
      if (!/receipt_media_outbox/.test(sql)) {
        // ODD-3A ingestion claim: recorded on its own channel and never in
        // the notification sequence.
        ingestionClaims.push({ limit: params?.[0], owner: params?.[1], sql });
        const rows =
          ingestionPending.length > 0
            ? (ingestionPending.shift() as unknown[])
            : [];
        return { rows, rowCount: rows.length };
      }
      sequence.push('claim');
      claims.push({ limit: params?.[0], owner: params?.[1] });
      const rows = pending.length > 0 ? (pending.shift() as unknown[]) : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("status = 'SENT'")) {
      sequence.push('mark');
      marks.push(String(params?.[2]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('attempts = attempts + 1')) {
      sequence.push('reschedule');
      reschedules.push(reschedules.length + 1);
      return { rows: [{ attempts: reschedules.length }], rowCount: 1 };
    }
    if (/INSERT\s+INTO\s+receipt_media_outbox/i.test(sql)) {
      sequence.push('insert');
      return { rows: [], rowCount: 0 };
    }
    sequence.push('other');
    return { rows: [], rowCount: 0 };
  };
  const client = { query: jest.fn(clientQuery), release: jest.fn() };
  const pool = {
    query: jest.fn(openWindowQuery),
    connect: jest.fn(() => Promise.resolve(client)),
    end: jest.fn(() => {
      sequence.push('end');
      ended = true;
      return Promise.resolve();
    }),
  };
  return {
    pool,
    claims,
    ingestionClaims,
    marks,
    reschedules,
    sequence,
    queriesAfterEnd: () => queriesAfterEnd,
  };
};

/** Boots the real host module with stubbed edges, runs the test, closes it.
 * An explicit pool may be passed so the caller can observe the SAME injected
 * PG_POOL instance (boot work and shutdown) instead of an unrelated stub. */
const withHostModule = async (
  env: Record<string, string>,
  run: (moduleRef: INestApplicationContext) => Promise<void> | void,
  pool: ReturnType<typeof stubPool> = stubPool(),
): Promise<void> => {
  // Deterministic clear-then-overlay isolation (WU14C fix): receipt-specific
  // leftovers never leak between scenarios.
  for (const key of Object.keys(RECEIPT_ENABLED_ENV))
    if (!(key in BASE_ENV)) delete process.env[key];
  Object.assign(process.env, env);
  // Capture-only composition must bind every enabled RESTOCK external edge
  // without invoking backend or Meta. Keep the real runtime and sender alias.
  const client = {
    uploadReceipt: jest.fn(),
    getReceiptOutcome: jest.fn(),
    submitRestockIntake: jest
      .fn()
      .mockRejectedValue(new Error('unexpected intake')),
    getRestockDecision: jest
      .fn()
      .mockRejectedValue(new Error('unexpected poll')),
    recordRestockApplicationOutcome: jest
      .fn()
      .mockRejectedValue(new Error('unexpected outcome')),
  };
  const sender = {
    sendText: jest.fn().mockRejectedValue(new Error('unexpected outbound')),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.forRoot({ ignoreEnvFile: true }), WhatsappModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(CONVERSATION_STORE)
    .useValue({
      get: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    })
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue(client)
    .overrideProvider(MetaWhatsappSender)
    .useValue(sender)
    .compile();
  try {
    expect(moduleRef.get(WHATSAPP_SENDER)).toBe(sender);
    await run(moduleRef);
  } finally {
    await moduleRef.close();
  }
  expect(client.submitRestockIntake).not.toHaveBeenCalled();
  expect(client.getRestockDecision).not.toHaveBeenCalled();
  expect(client.recordRestockApplicationOutcome).not.toHaveBeenCalled();
  expect(sender.sendText).not.toHaveBeenCalled();
};

describe('WhatsappModule composition with ReceiptMediaModule (WU14D)', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in baseEnv)) delete process.env[key];
    Object.assign(process.env, baseEnv);
  });

  it('composes the host graph so dispatcher and ingress resolve', async () => {
    await withHostModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      expect(moduleRef.get(WebhookDispatcherService)).toBeInstanceOf(
        WebhookDispatcherService,
      );
      expect(moduleRef.get(ReceiptIngressService)).toBeInstanceOf(
        ReceiptIngressService,
      );
      // The outbound sender alias keeps resolving through the sender module.
      expect(moduleRef.get(WHATSAPP_SENDER)).toBeDefined();
    });
  });

  it('composes the host graph without any receipt-specific setting (always on)', async () => {
    await withHostModule(BASE_ENV, async (moduleRef) => {
      expect(moduleRef.get(WebhookDispatcherService)).toBeInstanceOf(
        WebhookDispatcherService,
      );
      // No kill switch: unsupported media is gated, never "disabled".
      expect(
        await moduleRef.get(ReceiptIngressService).admit({
          senderId: 's1',
          webhookMessageId: 'w1',
          providerMediaId: 'm1',
          declaredMimeType: 'image/webp',
        }),
      ).toEqual({ kind: 'unsupported-media' });
      expectNoReceiptWorkerProviders(moduleRef);
    });
  });

  it('registers neither the ingestion worker nor the receipt outbox path in the host', async () => {
    await withHostModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      expectNoReceiptWorkerProviders(moduleRef);
      // Both the ODD-3A ingestion drain and the WU14E notification drain are
      // privately owned (no DI token), but token absence alone proves nothing
      // — their enabled behavior is proven through real init()/close() in the
      // lifecycle tests below.
    });
  });

  it('starts the enabled ingestion drain through the host graph and drains it before pool.end', async () => {
    jest.useFakeTimers();
    const outbox = makeOutboxPool([], {
      ingestion: [[{ id: 'r1', status: 'RESERVED' }]],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const processed: string[] = [];
    const processor = {
      process: jest.fn<Promise<unknown>, [unknown, string, AbortSignal?]>(() =>
        gate.then(() => {
          processed.push('r1');
          return { kind: 'downloaded' };
        }),
      ),
    };
    const sendText = jest.fn(() =>
      Promise.resolve({ providerMessageId: 'wamid.OK' }),
    );
    // Deterministic clear-then-overlay receipt env isolation (WU14C fix).
    for (const key of Object.keys(RECEIPT_ENABLED_ENV))
      if (!(key in BASE_ENV)) delete process.env[key];
    Object.assign(process.env, RECEIPT_ENABLED_ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot({ ignoreEnvFile: true }),
        WhatsappModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(outbox.pool)
      .overrideProvider(CONVERSATION_STORE)
      .useValue({
        get: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        // Proactive notices hold while a person attends; BOT lets them send.
        getHandoff: jest.fn().mockResolvedValue({
          mode: 'BOT',
          epoch: 0,
          requestId: null,
          updatedAt: null,
        }),
      })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue({
        uploadReceipt: jest.fn(),
        getReceiptOutcome: jest.fn(),
        // Human decisions are always on; their runtimes bind these edges.
        recordRestockApplicationOutcome: jest.fn(),
      })
      .overrideProvider(WHATSAPP_SENDER)
      .useValue({ sendText })
      .overrideProvider(ReceiptIngestionProcessor)
      .useValue(processor)
      .compile();
    try {
      await moduleRef.init();
      await untilMicrotask(() => processor.process.mock.calls.length >= 1);
      // The host graph's private ingestion lifecycle claimed through the SAME
      // injected PG_POOL and dispatched the RESERVED row.
      expect(outbox.ingestionClaims).toHaveLength(1);
      const closing = moduleRef.close(); // destroy waits for the drain
      await drainMicrotasks();
      // CRITICAL SHUTDOWN-ORDERING PROOF: while the dispatch is held, the
      // REAL host lifecycle has NOT ended the pool.
      expect(outbox.sequence).not.toContain('end');
      expect(processed).toEqual([]);
      release();
      await closing;
      await drainMicrotasks();
      // Drain-before-pool.end: the held dispatch completes strictly BEFORE
      // the real PostgresPoolLifecycle closes the pool.
      expect(processed).toEqual(['r1']);
      expect(outbox.sequence[outbox.sequence.length - 1]).toBe('end');
      expect(outbox.queriesAfterEnd()).toBe(0);
    } finally {
      release();
      jest.useRealTimers();
      await moduleRef.close().catch(() => undefined);
      await drainMicrotasks();
    }
  });

  it('starts the enabled notification drain through the host graph and drains it before pool.end', async () => {
    jest.useFakeTimers();
    const outbox = makeOutboxPool([[outboxRow()]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sendText = jest.fn(() =>
      gate.then(() => ({ providerMessageId: 'wamid.GATE' })),
    );
    // Deterministic clear-then-overlay receipt env isolation (WU14C fix).
    for (const key of Object.keys(RECEIPT_ENABLED_ENV))
      if (!(key in BASE_ENV)) delete process.env[key];
    Object.assign(process.env, RECEIPT_ENABLED_ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot({ ignoreEnvFile: true }),
        WhatsappModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(outbox.pool)
      .overrideProvider(CONVERSATION_STORE)
      .useValue({
        get: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        // Proactive notices hold while a person attends; BOT lets them send.
        getHandoff: jest.fn().mockResolvedValue({
          mode: 'BOT',
          epoch: 0,
          requestId: null,
          updatedAt: null,
        }),
      })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue({
        uploadReceipt: jest.fn(),
        getReceiptOutcome: jest.fn(),
        // Human decisions are always on; their runtimes bind these edges.
        recordRestockApplicationOutcome: jest.fn(),
      })
      .overrideProvider(WHATSAPP_SENDER)
      .useValue({ sendText })
      .compile();
    try {
      await moduleRef.init();
      // The S7 handoff read sits between the claim and the send.
      await untilMicrotask(
        () => outbox.claims.length >= 1 && sendText.mock.calls.length >= 1,
      );
      // The host graph's private lifecycle claimed through the SAME
      // injected PG_POOL (single in-flight claim; its by-design wake
      // re-poll follows once the gated send below resolves).
      expect(outbox.claims).toHaveLength(1);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith({
        to: '+525500000000',
        text: 'Confirmamos un pago de su pedido F-1. Queda un saldo pendiente de $1,234.56 MXN; puede enviarnos el comprobante del resto cuando lo tenga.',
      });
      const closing = moduleRef.close(); // destroy waits for the drain
      await drainMicrotasks();
      // CRITICAL SHUTDOWN-ORDERING PROOF (WU14E gate): while the send is
      // still in flight, the REAL host lifecycle has NOT ended the pool.
      expect(outbox.sequence).not.toContain('end');
      release();
      await closing;
      await drainMicrotasks();
      // Drain-before-pool.end: the fenced CAS mark happens strictly
      // BEFORE the real PostgresPoolLifecycle closes the pool.
      expect(outbox.sequence).toEqual(['claim', 'mark', 'end']);
      expect(outbox.marks).toEqual(['wamid.GATE']);
      // No notification transaction ever ran against a closed pool.
      expect(outbox.queriesAfterEnd()).toBe(0);
    } finally {
      release();
      jest.useRealTimers();
      await moduleRef.close().catch(() => undefined);
      await drainMicrotasks();
    }
  });

  it('wires capture to the same pool, configured channel, ops and echo filter', async () => {
    const pool = stubPool();
    // The always-on receipt drains share this pool (R3/S7): their reads are
    // answered empty and left out of the capture evidence below.
    const isReceiptSql = (sql: unknown) => /receipt_media/.test(String(sql));
    const captureQueries = (): unknown[][] =>
      (pool.query.mock.calls as unknown[][]).filter(
        ([sql]) => !isReceiptSql(sql),
      );
    pool.query.mockImplementation((sql: string, params: unknown[]) =>
      isReceiptSql(sql)
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : Promise.resolve({
            rows: [
              {
                sourceRequestId: params[0],
                receivingPhoneNumberId: params[1],
                senderId: params[2],
                messageId: params[3],
                providerTimestampSeconds: params[4],
                observedAt: params[5],
                version: params[6],
              },
            ],
            rowCount: 1,
          }),
    );
    await withHostModule(
      BASE_ENV,
      async (moduleRef) => {
        await moduleRef.init();
        await drainMicrotasks();
        // Transactions opened so far belong to the receipt drains' boot pass.
        const drainConnects = pool.connect.mock.calls.length;
        const capture = moduleRef.get(RestockInboundCapture);
        expect(capture).toBeInstanceOf(RestockInboundCapture);
        expect(captureQueries()).toHaveLength(0);
        // Synthetic composition input, not proof of HTTP authentication.
        const observedAt = '2026-06-22T12:00:00.000Z';
        const message = {
          id: 'wamid.module-capture',
          from: '525511111111',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'Restock please' },
        };
        const event = (phone: string, from = message.from) => ({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: {
                      phone_number_id: phone,
                      display_phone_number: BASE_ENV.META_PHONE_NUMBER_ID,
                    },
                    messages: [{ ...message, from }],
                  },
                },
              ],
            },
          ],
        });
        const snapshot = (phone: string, from = message.from) => ({
          rawBodyBase64: Buffer.from(
            JSON.stringify(event(phone, from)),
          ).toString('base64'),
          observedAt,
        });
        expect(await capture.capture(snapshot('wrong-channel'))).toEqual({
          action: 'hold',
        });
        expect(
          await capture.capture(
            snapshot(BASE_ENV.META_PHONE_NUMBER_ID, BASE_ENV.OPS_CHANNEL_PHONE),
          ),
        ).toMatchObject({ action: 'captured', evidence: [] });
        expect(captureQueries()).toHaveLength(0);
        const result = await capture.capture(
          snapshot(BASE_ENV.META_PHONE_NUMBER_ID),
        );
        const expected = bindRestockInboundEvidence(
          {
            event: {
              receivingPhoneNumberId: BASE_ENV.META_PHONE_NUMBER_ID,
              senderId: message.from,
              messageId: message.id,
            },
            providerTimestampSeconds: message.timestamp,
            observedAt,
          },
          BASE_ENV.META_PHONE_NUMBER_ID,
        );
        expect(expected).not.toBeNull();
        expect(result).toEqual({
          action: 'captured',
          event: event(BASE_ENV.META_PHONE_NUMBER_ID),
          evidence: [expected],
        });
        if (result.action !== 'captured')
          throw new Error('capture did not record');
        expect(Object.isFrozen(result.evidence)).toBe(true);
        expect(Object.isFrozen(result.evidence[0])).toBe(true);
        expect(captureQueries()).toHaveLength(1);
        expect(pool.query).toHaveBeenCalledWith(
          expect.stringMatching(/INSERT INTO restock_inbound_evidence/),
          [
            expected?.sourceRequestId,
            BASE_ENV.META_PHONE_NUMBER_ID,
            message.from,
            message.id,
            message.timestamp,
            observedAt,
            1,
          ],
        );
        moduleRef
          .get<RecentOutboundStore>(RECENT_OUTBOUND)
          .remember(message.id);
        expect(
          await capture.capture(snapshot(BASE_ENV.META_PHONE_NUMBER_ID)),
        ).toMatchObject({ action: 'captured', evidence: [] });
        expect(captureQueries()).toHaveLength(1);
        expect(pool.connect).toHaveBeenCalledTimes(drainConnects);
      },
      pool,
    );
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('declares ReceiptMediaModule among the host imports', () => {
    const imported = (Reflect.getMetadata('imports', WhatsappModule) ??
      []) as unknown[];
    expect(imported).toContain(ReceiptMediaModule);
  });
});
