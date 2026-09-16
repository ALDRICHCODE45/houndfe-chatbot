/** WU14D host composition spec, transitioned to WU14E lifecycle behavior:
 * proves the real WhatsappModule graph boots through the Nest testing
 * module once ReceiptMediaModule is imported, so the
 * WebhookDispatcherService's mandatory receipt dependencies (ReceiptIngress
 * Service, ReceiptAmountRouterService) resolve. External edges are stubbed
 * only (no live PostgreSQL, backend, Meta, S3, or LLM requests). Proven: the
 * host graph composes in enabled mode with dispatcher/ingress/router all
 * resolvable and the WHATSAPP_SENDER alias intact; the same graph composes in
 * a genuinely receipt-setting-free disabled environment where the ingress
 * outcome remains `disabled`; the host registers neither the ingestion
 * worker nor the receipt-outbox path (the WU14E notification drain is
 * privately owned — no DI token — and its behavior is proven through real
 * init()/close(): claims through the SAME injected pool and drain-before
 * pool.end); and the host declares ReceiptMediaModule among its imports.
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
import { ReceiptIngressService } from '../receipt-media/application/receipt-ingress.service';
import { ReceiptOutboxService } from '../receipt-media/application/receipt-outbox.service';
import { PostgresReceiptOutboxStore } from '../receipt-media/infrastructure/postgres-receipt-outbox.store';
import { ReceiptMediaIngestionWorker } from '../receipt-media/infrastructure/receipt-media-ingestion.worker';
import { ReceiptMediaNotificationWorker } from '../receipt-media/infrastructure/receipt-media-notification.worker';
import { ReceiptMediaModule } from '../receipt-media/receipt-media.module';
import { WebhookDispatcherService } from './application/webhook-dispatcher.service';
import { WHATSAPP_SENDER } from './domain/whatsapp-sender.port';
import { WhatsappModule } from './whatsapp.module';

/** Tokens the receipt composition must never register, in either mode,
 * including when composed through the host. The WU14E notification worker
 * is also token-less (privately owned by the lifecycle coordinator) — but
 * token absence alone does not prove a privately owned worker did not
 * run, so its behavior is proven through real init()/close() below. */
const FORBIDDEN_NONWORKER_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptMediaNotificationWorker,
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
  marks: string[];
  reschedules: number[];
  sequence: string[];
  queriesAfterEnd: () => number;
};

/** Instrumented fake pool for the REAL PostgresReceiptOutboxStore (same
 * fixture family as the WU14C module spec, kept local to this spec): `end`
 * records closure in the sequence; any query performed after closure is
 * counted and rejected, so a post-close claim/mark can never pass
 * silently through the REAL host graph. */
const makeOutboxPool = (
  batches: Array<Record<string, unknown>[]> = [],
): OutboxPool => {
  const pending = [...batches];
  const claims: Array<{ limit: unknown; owner: unknown }> = [];
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
    .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
    .compile();
  try {
    await run(moduleRef);
  } finally {
    await moduleRef.close();
  }
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
    // Shutdown closed the SAME injected pool through the real lifecycle,
    // and nothing else ever touched it — only the pool.end event ran.
    expect(outbox.pool.end).toHaveBeenCalledTimes(1);
    expect(outbox.sequence).toEqual(['end']);
  });

  it('registers neither the ingestion worker nor the receipt outbox path in the host', async () => {
    await withHostModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      expectNoReceiptWorkerProviders(moduleRef);
      // The WU14E notification drain is privately owned (no DI token), but
      // token absence alone proves nothing — its enabled behavior is
      // proven through real init()/close() in the lifecycle test below.
    });
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

  it('declares ReceiptMediaModule among the host imports', () => {
    const imported = (Reflect.getMetadata('imports', WhatsappModule) ??
      []) as unknown[];
    expect(imported).toContain(ReceiptMediaModule);
  });
});
