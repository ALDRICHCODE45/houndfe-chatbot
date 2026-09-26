/** WU14D host composition spec, transitioned to WU14E/ODD-3A/ODD-3B lifecycle
 * behavior: proves the real WhatsappModule graph boots through the Nest
 * testing module once ReceiptMediaModule is imported, so the
 * WebhookDispatcherService's mandatory receipt dependencies (ReceiptIngress
 * Service, ReceiptAmountRouterService) resolve. External edges are stubbed
 * only (no live PostgreSQL, backend, Meta, S3, or LLM requests). Proven: the
 * host graph composes in enabled mode with dispatcher/ingress/router all
 * resolvable and the WHATSAPP_SENDER alias intact; the same graph composes in
 * a genuinely receipt-setting-free disabled environment where the ingress
 * outcome remains `disabled`; the host registers none of the private receipt
 * workers/services (the ODD-3A ingestion, WU14E notification, and ODD-3B
 * cleanup lifecycles are privately owned — no DI token — and their behavior
 * is proven through real init()/close(): claims through the SAME injected
 * pool and drain-before pool.end, including the cleanup abort-identity
 * through the held delete seam); and the host declares ReceiptMediaModule
 * among its imports.
 * The full ReceiptMediaModule-internal graph contract (singleton lookup
 * aliasing, keyring rejection, inert disabled seams, validated worker
 * options/owner, duplicate-import singularity, exhaustion alert) stays
 * covered by the WU14C module spec and is not duplicated here. */
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { AppConfigModule } from '../config/config.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { ReceiptAmountRouterService } from '../receipt-media/application/receipt-amount-router.service';
import { ReceiptCleanupService } from '../receipt-media/application/receipt-cleanup.service';
import { ReceiptIngestionProcessor } from '../receipt-media/application/receipt-ingestion.processor';
import { ReceiptIngressService } from '../receipt-media/application/receipt-ingress.service';
import { ReceiptOutboxService } from '../receipt-media/application/receipt-outbox.service';
import { OBJECT_STORAGE_PORT } from '../receipt-media/domain/object-storage.port';
import { PostgresReceiptOutboxStore } from '../receipt-media/infrastructure/postgres-receipt-outbox.store';
import { ReceiptCleanupWorker } from '../receipt-media/infrastructure/receipt-cleanup.worker';
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
  ReceiptCleanupWorker,
  ReceiptCleanupService,
  ReceiptOutboxService,
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
  HUMAN_DECISIONS_RESTOCK_ENABLED: 'false',
};

/** Enabled receipt environment over the validated WU1C field set. */
const RECEIPT_ENABLED_ENV: Record<string, string> = {
  ...BASE_ENV,
  RECEIPT_MEDIA_ENABLED: 'true',
  RECEIPT_MEDIA_MAX_BYTES: '10485760',
  META_MEDIA_ALLOWED_HOSTS: 'graph.facebook.com,.meta.com',
  META_MEDIA_METADATA_TIMEOUT_MS: '5000',
  META_MEDIA_DOWNLOAD_TIMEOUT_MS: '30000',
  RECEIPT_STORAGE_ENDPOINT: 'https://s3.example.com',
  RECEIPT_STORAGE_REGION: 'us-east-1',
  RECEIPT_STORAGE_BUCKET: 'houndfe-receipts',
  RECEIPT_STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  RECEIPT_STORAGE_SECRET_ACCESS_KEY: 'redacted-secret-value',
  RECEIPT_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
  RECEIPT_MEDIA_WORKER_CONCURRENCY: '2',
  RECEIPT_MEDIA_WORKER_LEASE_MS: '60000',
  RECEIPT_MEDIA_WORKER_POLL_MS: '1000',
  RECEIPT_MEDIA_INGESTION_ENABLED: 'true',
  CHATBOT_API_ATTACH_TIMEOUT_MS: '30000',
  RECEIPT_CAPABILITY_KEYS:
    '1:QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=,2:QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
  RECEIPT_CAPABILITY_ACTIVE_VERSION: '2',
};

/** Valid disabled environment: only the kill switch over the pristine base
 * environment; every receipt-specific setting is deleted (WU14C-R1 recipe). */
const RECEIPT_DISABLED_ENV: Record<string, string> = {
  ...BASE_ENV,
  RECEIPT_MEDIA_ENABLED: 'false',
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
  template_key: 'RECEIPT_AMOUNT_CONFIRM',
  template_args: { amountCents: 123456 },
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
  cleanupClaims: Array<{ limit: unknown; owner: unknown; sql: string }>;
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
 * can still be observed. ODD-3B: the cleanup claim shares this pool too and
 * is recorded on its own `cleanupClaims` channel, with its disposition SQL
 * neutralized so the drain can complete without real object storage. */
const makeOutboxPool = (
  batches: Array<Record<string, unknown>[]> = [],
  opts: {
    ingestion?: Array<Array<Record<string, unknown>>>;
    cleanup?: Array<Array<Record<string, unknown>>>;
  } = {},
): OutboxPool => {
  const pending = [...batches];
  const ingestionPending = [...(opts.ingestion ?? [])];
  const cleanupPending = [...(opts.cleanup ?? [])];
  const cleanupRows = new Map<string, Record<string, unknown>>();
  const claims: Array<{ limit: unknown; owner: unknown }> = [];
  const ingestionClaims: Array<{
    limit: unknown;
    owner: unknown;
    sql: string;
  }> = [];
  const cleanupClaims: Array<{
    limit: unknown;
    owner: unknown;
    sql: string;
  }> = [];
  const marks: string[] = [];
  const reschedules: number[] = [];
  const sequence: string[] = [];
  let queriesAfterEnd = 0;
  let ended = false;
  const cleanupUpdated = (
    row: Record<string, unknown>,
    over: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...row,
    ...over,
    version: Number(row.version) + 1,
  });
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
        // ODD-3B cleanup claim: recorded on its own channel and never in the
        // notification sequence.
        if (/cleanup_pending = true/.test(sql)) {
          cleanupClaims.push({ limit: params?.[0], owner: params?.[1], sql });
          const rows =
            cleanupPending.length > 0
              ? (cleanupPending.shift() as Array<Record<string, unknown>>)
              : [];
          for (const row of rows) cleanupRows.set(String(row.id), row);
          return { rows, rowCount: rows.length };
        }
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
    // ODD-3B cleanup disposition SQL, only reached for a claimed cleanup row;
    // it never pushes `sequence` entries, so the host notification evidence
    // stays intact while the cleanup drain completes.
    if (/cleanup_attempts BETWEEN 1 AND 3 FOR UPDATE/.test(sql)) {
      const row = cleanupRows.get(String(params?.[0]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SET cleanup_pending = false/.test(sql)) {
      const row = cleanupRows.get(String(params?.[0]));
      if (!row) return { rows: [], rowCount: 0 };
      const updated = cleanupUpdated(row, {
        cleanup_pending: false,
        lease_owner: null,
        lease_expires_at: null,
      });
      cleanupRows.set(String(row.id), updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (/SET last_error_category = \$5/.test(sql)) {
      const row = cleanupRows.get(String(params?.[0]));
      if (!row) return { rows: [], rowCount: 0 };
      const updated = cleanupUpdated(row, {
        last_error_category: params?.[4],
        last_error_code: params?.[5],
        lease_owner: null,
        lease_expires_at: null,
      });
      cleanupRows.set(String(row.id), updated);
      return { rows: [updated], rowCount: 1 };
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
    query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
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
    cleanupClaims,
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
    attachReceipt: jest.fn().mockResolvedValue(undefined),
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
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
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

  it('composes the host graph so dispatcher, ingress, and router resolve', async () => {
    await withHostModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      expect(moduleRef.get(WebhookDispatcherService)).toBeInstanceOf(
        WebhookDispatcherService,
      );
      expect(moduleRef.get(ReceiptIngressService)).toBeInstanceOf(
        ReceiptIngressService,
      );
      expect(moduleRef.get(ReceiptAmountRouterService)).toBeInstanceOf(
        ReceiptAmountRouterService,
      );
      // The outbound sender alias keeps resolving through the sender module.
      expect(moduleRef.get(WHATSAPP_SENDER)).toBeDefined();
    });
  });

  it('composes the host graph in a receipt-setting-free disabled environment', async () => {
    const outbox = makeOutboxPool();
    await withHostModule(
      RECEIPT_DISABLED_ENV,
      async (moduleRef) => {
        // The host still composes: every mandatory dispatcher dependency,
        // including the receipt services, resolves.
        expect(moduleRef.get(WebhookDispatcherService)).toBeInstanceOf(
          WebhookDispatcherService,
        );
        expect(moduleRef.get(ReceiptIngressService)).toBeInstanceOf(
          ReceiptIngressService,
        );
        expect(moduleRef.get(ReceiptAmountRouterService)).toBeInstanceOf(
          ReceiptAmountRouterService,
        );
        // The ingress kill switch stays disabled with no receipt settings.
        expect(
          await moduleRef.get(ReceiptIngressService).admit({
            senderId: 's1',
            webhookMessageId: 'w1',
            providerMediaId: 'm1',
            declaredMimeType: 'image/jpeg',
          }),
        ).toEqual({ kind: 'disabled' });
        // No receipt worker/outbox provider is reachable in the full host
        // graph in disabled mode either.
        expectNoReceiptWorkerProviders(moduleRef);
      },
      outbox.pool,
    );
    // Boot performed no database work, no notification claims, and no
    // sends; shutdown closed the SAME injected pool
    // (PostgresPoolLifecycle.onModuleDestroy). The pool passed to
    // withHostModule is the one the graph actually received.
    expect(outbox.pool.query).not.toHaveBeenCalled();
    expect(outbox.pool.connect).not.toHaveBeenCalled();
    expect(outbox.claims).toHaveLength(0); // disabled lifecycle is fully inert
    expect(outbox.cleanupClaims).toHaveLength(0); // cleanup stays inert too
    // Shutdown closed the SAME injected pool through the real lifecycle,
    // and nothing else ever touched it — only the pool.end event ran.
    expect(outbox.pool.end).toHaveBeenCalledTimes(1);
    expect(outbox.sequence).toEqual(['end']);
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
        setReceiptAmountPointer: jest.fn(),
        clearReceiptAmountPointer: jest.fn(),
      })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
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

  it('keeps the host ingestion drain inert when the rollout gate is off', async () => {
    jest.useFakeTimers();
    const outbox = makeOutboxPool([], {
      ingestion: [[{ id: 'r1', status: 'RESERVED' }]],
    });
    // Broad receipt media stays enabled; only the dedicated ingestion gate is
    // omitted, so the host must not construct or start the ingestion drain.
    const env = { ...RECEIPT_ENABLED_ENV };
    delete env.RECEIPT_MEDIA_INGESTION_ENABLED;
    try {
      await withHostModule(
        env,
        async (moduleRef) => {
          await moduleRef.init();
          await jest.advanceTimersByTimeAsync(3_600_000);
          await drainMicrotasks();
          expect(outbox.ingestionClaims).toHaveLength(0);
          expect(outbox.cleanupClaims).toHaveLength(0);
        },
        outbox.pool,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts the enabled cleanup drain through the host graph and drains it before pool.end', async () => {
    jest.useFakeTimers();
    const cleanupRow: Record<string, unknown> = {
      id: '00000000-0000-4000-8000-0000000000c1',
      object_key: 'receipts/00000000-0000-4000-8000-0000000000c1',
      status: 'FAILED',
      failure_stage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      version: '4',
      cleanup_attempts: 1,
      cleanup_pending: true,
    };
    const outbox = makeOutboxPool([], { cleanup: [[cleanupRow]] });
    // Held real delete seam: the shutdown must abort this exact signal and
    // drain the complete delete-plus-disposition batch before pool.end.
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>(
      (resolve) => (releaseDelete = resolve),
    );
    const signals: AbortSignal[] = [];
    const storage = {
      deleteTechnicalObject: jest.fn((input: { abortSignal: AbortSignal }) => {
        signals.push(input.abortSignal);
        return deleteGate.then(() => undefined);
      }),
    };
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
        setReceiptAmountPointer: jest.fn(),
        clearReceiptAmountPointer: jest.fn(),
      })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(WHATSAPP_SENDER)
      .useValue({
        sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid' }),
      })
      .overrideProvider(OBJECT_STORAGE_PORT)
      .useValue(storage)
      .compile();
    try {
      await moduleRef.init();
      await untilMicrotask(() => signals.length >= 1);
      // The host graph's private cleanup lifecycle claimed the backlog row
      // through the SAME injected PG_POOL and reached the delete seam.
      expect(outbox.cleanupClaims).toHaveLength(1);
      const closing = moduleRef.close(); // destroy waits for the drain
      await drainMicrotasks();
      // CRITICAL SHUTDOWN-ORDERING PROOF: while the delete is held, the REAL
      // host lifecycle has NOT ended the pool.
      expect(outbox.sequence).not.toContain('end');
      // Abort identity through delete: the cleanup batch signal handed to the
      // delete is the exact one aborted by shutdown.
      expect(signals[0]?.aborted).toBe(true);
      releaseDelete();
      await closing;
      await drainMicrotasks();
      // Drain-before-pool.end: the cleanup disposition completes strictly
      // BEFORE the real PostgresPoolLifecycle closes the pool.
      expect(outbox.sequence[outbox.sequence.length - 1]).toBe('end');
      expect(outbox.queriesAfterEnd()).toBe(0);
    } finally {
      releaseDelete();
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
        setReceiptAmountPointer: jest.fn(),
        clearReceiptAmountPointer: jest.fn(),
      })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(WHATSAPP_SENDER)
      .useValue({ sendText })
      .compile();
    try {
      await moduleRef.init();
      await untilMicrotask(() => outbox.claims.length >= 1);
      // The host graph's private lifecycle claimed through the SAME
      // injected PG_POOL (single in-flight claim; its by-design wake
      // re-poll follows once the gated send below resolves).
      expect(outbox.claims).toHaveLength(1);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith({
        to: '+525500000000',
        text: 'Detectamos 1234.56 MXN. Responde CONFIRMAR o CANCELAR.',
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

  it('resolves an inert disabled restock capture before parsing a snapshot', async () => {
    const pool = stubPool();
    await withHostModule(
      RECEIPT_DISABLED_ENV,
      async (moduleRef) => {
        await moduleRef.init();
        const capture = moduleRef.get(RestockInboundCapture);
        expect(capture).toBeInstanceOf(RestockInboundCapture);
        expect(await capture.capture(null)).toEqual({ action: 'disabled' });
        expect(pool.query).not.toHaveBeenCalled();
        expect(pool.connect).not.toHaveBeenCalled();
      },
      pool,
    );
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('wires enabled capture to the same pool, configured channel, ops and echo filter', async () => {
    const pool = stubPool();
    pool.query.mockImplementation((_sql: string, params: unknown[]) =>
      Promise.resolve({
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
      { ...RECEIPT_DISABLED_ENV, HUMAN_DECISIONS_RESTOCK_ENABLED: 'true' },
      async (moduleRef) => {
        await moduleRef.init();
        const capture = moduleRef.get(RestockInboundCapture);
        expect(capture).toBeInstanceOf(RestockInboundCapture);
        expect(pool.query).not.toHaveBeenCalled();
        expect(pool.connect).not.toHaveBeenCalled();
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
        expect(pool.query).not.toHaveBeenCalled();
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
        expect(pool.query).toHaveBeenCalledTimes(1);
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
        expect(pool.query).toHaveBeenCalledTimes(1);
        expect(pool.connect).not.toHaveBeenCalled();
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
