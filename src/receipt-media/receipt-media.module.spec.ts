/** WU14C composition spec, transitioned to WU14E lifecycle behavior: the
 * ReceiptMediaModule NestJS graph booted through the real testing module
 * with stubbed external edges only (no live PostgreSQL, Meta, S3, or
 * outbound HTTP). Proven: the graph boots with the full composition, the
 * RECEIPT_CAPABILITY_LOOKUP store singleton identity, and the base64
 * keyring decode at the composition boundary; enabled/disabled config
 * reaches the ingress kill switch; declared imports/dispatcher exports
 * match the contract; no ingestion worker or outbox provider is registered
 * and no ingestion/outbox-intent production runs in either mode; the graph
 * fails without ConfigService; a valid disabled environment with every
 * receipt-specific setting deleted boots inert and fails closed; enabled
 * mode still fails without the capability keyring; and the WU14E lifecycle
 * coordinator privately runs the notification drain only when enabled,
 * with validated options/owner, drain-before-pool.end shutdown, no rearm,
 * duplicate-import singularity, and a constant non-PII exhaustion alert. */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Module, Logger, type INestApplicationContext } from '@nestjs/common';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { AppConfigModule } from '../config/config.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ConversationModule } from '../conversation/conversation.module';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { CapabilityService } from './application/capability.service';
import { ReceiptAmountRouterService } from './application/receipt-amount-router.service';
import { ReceiptAttachmentService } from './application/receipt-attachment.service';
import {
  RECEIPT_CAPABILITY_LOOKUP,
  ReceiptCapabilityAuthorizerService as CapabilityAuthorizer,
} from './application/receipt-capability-authorizer.service';
import { ReceiptIngestionProcessor } from './application/receipt-ingestion.processor';
import { ReceiptIngressService } from './application/receipt-ingress.service';
import { ReceiptOutboxService } from './application/receipt-outbox.service';
import { META_MEDIA } from './domain/meta-media.port';
import { OBJECT_STORAGE_PORT } from './domain/object-storage.port';
import { MetaMediaClient } from './infrastructure/meta-media.client';
import { PostgresReceiptMediaStore } from './infrastructure/postgres-receipt-media.store';
import { PostgresReceiptOutboxStore } from './infrastructure/postgres-receipt-outbox.store';
import { ReceiptMediaIngestionWorker } from './infrastructure/receipt-media-ingestion.worker';
import { ReceiptMediaNotificationWorker } from './infrastructure/receipt-media-notification.worker';
import { S3ObjectStorageAdapter } from './infrastructure/s3-object-storage.adapter';
import { ReceiptMediaAccessController } from './presentation/receipt-media-access.controller';
import { ReceiptMediaModule } from './receipt-media.module';

/** One extra import edge over the receipt module: any duplicate import
 * still resolves to the SAME Nest module instance, so the lifecycle
 * coordinator (and its claim loop) must exist exactly once. */
@Module({ imports: [ReceiptMediaModule] })
class ReceiptMediaHostWrapper {}

/** Tokens the module must never register, in either mode: the ingestion
 * worker, the outbox service, and the outbox store stay unregistered (the
 * notification worker has no DI token either — WU14E owns it privately —
 * but token absence alone does not prove the private worker did not run,
 * so lifecycle behavior is proven separately below). */
const FORBIDDEN_NONWORKER_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptMediaNotificationWorker,
  ReceiptOutboxService,
  PostgresReceiptOutboxStore,
] as const;

/** Tokens forbidden as DI registrations; the notification drain itself is
 * exercised through behavior in the WU14E lifecycle describe block. */
const FORBIDDEN_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptOutboxService,
  PostgresReceiptOutboxStore,
] as const;

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

/** Instrumented fake pool for the REAL PostgresReceiptOutboxStore: every
 * transaction runs through connect/BEGIN/query/COMMIT/release. `end`
 * records closure in the sequence; any query performed after closure is
 * counted and rejected, so a post-close claim/mark can never pass silently. */
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

const makeOutboxPool = (
  batches: Array<Record<string, unknown>[]> = [],
  opts: { claimGate?: Promise<void> } = {},
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
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    // The optional claim gate doubles as the single await this fixture needs;
    // awaiting `undefined` costs exactly one harmless microtask hop.
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
      // Recorded BEFORE the optional gate so an in-flight claim is
      // observable while it is still unresolved.
      sequence.push('claim');
      await opts.claimGate;
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

/** Applies deterministic clear-then-overlay receipt env isolation. */
const applyEnv = (env: Record<string, string>): void => {
  for (const key of Object.keys(RECEIPT_ENABLED_ENV))
    if (!(key in BASE_ENV)) delete process.env[key];
  Object.assign(process.env, env);
};

/** Builds (not compiles) the receipt module graph with stubbed edges. */
const buildModule = (
  env: Record<string, string>,
  pool: unknown,
  sendText?: ReturnType<typeof jest.fn>,
): {
  builder: ReturnType<typeof Test.createTestingModule>;
} => {
  applyEnv(env);
  const builder = Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot({ ignoreEnvFile: true }),
      ReceiptMediaModule,
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(CONVERSATION_STORE)
    .useValue({ get: jest.fn().mockResolvedValue(null) })
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) });
  if (sendText)
    builder.overrideProvider(WHATSAPP_SENDER).useValue({ sendText });
  return { builder };
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

/** WU1C validated receipt-media field set; keyring v1/v2 = "A"/"B" keys. */
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

/** WU14C-R1: valid disabled environment — only the kill switch over the
 * pristine base environment; every receipt-specific setting is deleted. */
const RECEIPT_DISABLED_ENV: Record<string, string> = {
  ...BASE_ENV,
  RECEIPT_MEDIA_ENABLED: 'false',
};

/** Snapshot of the pristine worker environment, restored after each test. */
const baseEnv: Record<string, string | undefined> = { ...process.env };

/** Stubs the pg pool: wiring only, never connects. */
const stubPool = () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
});

/** Boots the module with stubbed edges, runs the test, then closes it. */
const withModule = async (
  env: Record<string, string>,
  run: (moduleRef: INestApplicationContext) => Promise<void> | void,
  pool: ReturnType<typeof stubPool> = stubPool(),
): Promise<void> => {
  for (const key of Object.keys(RECEIPT_ENABLED_ENV))
    if (!(key in BASE_ENV)) delete process.env[key];
  Object.assign(process.env, env);
  const builder = Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot({ ignoreEnvFile: true }),
      ReceiptMediaModule,
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(CONVERSATION_STORE)
    .useValue({ get: jest.fn().mockResolvedValue(null) })
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) });
  const moduleRef = await builder.compile();
  try {
    await run(moduleRef);
  } finally {
    await moduleRef.close();
  }
};

describe('ReceiptMediaModule composition (WU14C)', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in baseEnv)) delete process.env[key];
    Object.assign(process.env, baseEnv);
  });

  it('composes the full non-worker graph from existing adapters and services', async () => {
    await withModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      const members: Array<
        [unknown, abstract new (...args: never[]) => unknown]
      > = [
        [ReceiptIngressService, ReceiptIngressService],
        [ReceiptAmountRouterService, ReceiptAmountRouterService],
        [ReceiptAttachmentService, ReceiptAttachmentService],
        [ReceiptIngestionProcessor, ReceiptIngestionProcessor],
        [CapabilityAuthorizer, CapabilityAuthorizer],
        [ReceiptMediaAccessController, ReceiptMediaAccessController],
        [META_MEDIA, MetaMediaClient],
        [OBJECT_STORAGE_PORT, S3ObjectStorageAdapter],
        [CapabilityService, CapabilityService],
        [PostgresReceiptMediaStore, PostgresReceiptMediaStore],
      ];
      for (const [token, ctor] of members)
        expect(moduleRef.get(token as never)).toBeInstanceOf(ctor);
      expect(moduleRef.get(RECEIPT_CAPABILITY_LOOKUP)).toBe(
        moduleRef.get(PostgresReceiptMediaStore),
      );
      const capability = moduleRef.get(CapabilityService);
      const first = capability.issue('00000000-0000-4000-8000-0000000000ab');
      const second = capability.issue('00000000-0000-4000-8000-0000000000ab');
      expect(first.token).toBe(second.token);
      expect(first.keyVersion).toBe('2');
      expect(capability.parseToken(first.token)).toBe(first.token);
    });
  });

  it.each([
    ['enabled', RECEIPT_ENABLED_ENV, 'unsupported-media'],
    [
      'disabled',
      { ...RECEIPT_ENABLED_ENV, RECEIPT_MEDIA_ENABLED: 'false' },
      'disabled',
    ],
  ] as const)(
    'threads the %s kill switch into the ingress service',
    async (_label, env, kind) => {
      await withModule(env, async (moduleRef) => {
        expect(
          await moduleRef.get(ReceiptIngressService).admit({
            senderId: 's1',
            webhookMessageId: 'w1',
            providerMediaId: 'm1',
            declaredMimeType: 'image/webp',
          }),
        ).toEqual({ kind });
      });
    },
  );

  it('boots the valid disabled environment without receipt-specific settings', async () => {
    const pool = stubPool();
    await withModule(
      RECEIPT_DISABLED_ENV,
      async (moduleRef) => {
        // Store singleton + alias stay available for dispatcher DI.
        const store = moduleRef.get(PostgresReceiptMediaStore);
        expect(moduleRef.get(RECEIPT_CAPABILITY_LOOKUP)).toBe(store);
        // The mounted access controller stays registered.
        expect(moduleRef.get(ReceiptMediaAccessController)).toBeInstanceOf(
          ReceiptMediaAccessController,
        );
        // Ingress remains disabled.
        expect(
          await moduleRef.get(ReceiptIngressService).admit({
            senderId: 's1',
            webhookMessageId: 'w1',
            providerMediaId: 'm1',
            declaredMimeType: 'image/jpeg',
          }),
        ).toEqual({ kind: 'disabled' });
        // No real configured Meta/S3 adapter is constructed.
        expect(moduleRef.get(META_MEDIA)).not.toBeInstanceOf(MetaMediaClient);
        expect(moduleRef.get(OBJECT_STORAGE_PORT)).not.toBeInstanceOf(
          S3ObjectStorageAdapter,
        );
        // Authorization fails closed to the existing unavailable result.
        const authorizer = moduleRef.get(CapabilityAuthorizer);
        const token = moduleRef
          .get(CapabilityService)
          .issue('00000000-0000-4000-8000-0000000000ab').token;
        expect(await authorizer.authorize(token)).toEqual({
          kind: 'unavailable',
        });
        expect(await authorizer.authorize('malformed')).toEqual({
          kind: 'denied',
        });
        // Neither worker nor outbox path registers in disabled mode either.
        for (const absent of FORBIDDEN_NONWORKER_TOKENS)
          expect(() => {
            void moduleRef.get(absent, { strict: true });
          }).toThrow();
      },
      pool,
    );
    // Boot performed no database work.
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('still fails closed at boot when enabled mode lacks the keyring', async () => {
    const env = { ...RECEIPT_ENABLED_ENV };
    delete env.RECEIPT_CAPABILITY_KEYS;
    await expect(withModule(env, () => undefined)).rejects.toThrow(
      /RECEIPT_CAPABILITY_KEYS/,
    );
  });

  it('declares the required imports and dispatcher exports', () => {
    const meta = (key: string): unknown[] =>
      (Reflect.getMetadata(key, ReceiptMediaModule) as unknown[]) ?? [];
    for (const required of [
      ConfigModule,
      DatabaseModule,
      ConversationModule,
      ChatbotApiModule,
      WhatsappSenderModule,
    ])
      expect(meta('imports')).toContain(required);
    expect(meta('exports')).toContain(ReceiptIngressService);
    expect(meta('exports')).toContain(ReceiptAmountRouterService);
  });

  it('registers neither receipt worker nor the receipt outbox composition', async () => {
    await withModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      // The ingestion worker, outbox service, and outbox store stay
      // unregistered in enabled mode; only the notification drain claims
      // anything, and its behavior is proven below (WU14E).
      for (const absent of FORBIDDEN_TOKENS)
        expect(() => {
          void moduleRef.get(absent, { strict: true });
        }).toThrow();
      // The notification worker is privately owned (WU14E): no DI token
      // either — but token absence alone proves nothing, so the lifecycle
      // behavior (real claims through the store) is proven in the WU14E
      // block below via real init()/close().
      expect(() => {
        void moduleRef.get(ReceiptMediaNotificationWorker, { strict: true });
      }).toThrow();
    });
  });

  it('fails the graph when a required token (ConfigService) is absent', async () => {
    const builder = Test.createTestingModule({
      imports: [ReceiptMediaModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(stubPool());
    Object.assign(process.env, RECEIPT_ENABLED_ENV);
    await expect(builder.compile()).rejects.toThrow(/ConfigService/);
  });

  describe('ReceiptMediaModule notification lifecycle (WU14E)', () => {
    let loggerError: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      loggerError = jest
        .spyOn(Logger, 'error')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
      loggerError.mockRestore();
    });

    const OWNER_RE =
      /^receipt-media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    /** Lifecycle surface the tests drive: the coordinator's own hooks. */
    type LifecycleCoordinatorHooks = {
      onApplicationBootstrap(): void;
      onModuleDestroy(): Promise<void>;
    };

    /** Resolves the module-local lifecycle coordinator WITHOUT exporting
     * the internal class or patching any production lifecycle: the
     * coordinator is read from the module's DECLARED provider metadata
     * (a public contract of ReceiptMediaModule) and resolved through real
     * Nest DI, so tests can invoke its hooks directly — which Nest alone
     * cannot do twice (init() suppresses repeated bootstrap hooks). */
    const resolveLifecycleCoordinator = (
      moduleRef: INestApplicationContext,
    ): LifecycleCoordinatorHooks => {
      const providers = (Reflect.getMetadata('providers', ReceiptMediaModule) ??
        []) as unknown[];
      const ctor = providers.find(
        (provider) =>
          typeof provider === 'function' &&
          (provider as { name?: string }).name ===
            'ReceiptMediaNotificationLifecycle',
      ) as abstract new (...args: never[]) => LifecycleCoordinatorHooks;
      expect(ctor).toBeDefined();
      return moduleRef.get(ctor);
    };

    /** Boots through real init(), runs the test, and always closes —
     * a deterministic safe-close that never leaks a hanging drain into
     * another test, even on failed assertions. */
    const runLifecycle = async (
      env: Record<string, string>,
      outbox: ReturnType<typeof makeOutboxPool>,
      sendText: ReturnType<typeof jest.fn>,
      run: (moduleRef: INestApplicationContext) => Promise<void> | void,
    ): Promise<void> => {
      const { builder } = buildModule(env, outbox.pool, sendText);
      const moduleRef = await builder.compile();
      try {
        await moduleRef.init();
        await run(moduleRef);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    };

    it('runs exactly one worker and owner across repeated coordinator bootstrap', async () => {
      const outbox = makeOutboxPool([[outboxRow()]]);
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.OK' }),
      );
      const { builder } = buildModule(
        RECEIPT_ENABLED_ENV,
        outbox.pool,
        sendText,
      );
      const moduleRef = await builder.compile();
      try {
        const coordinator = resolveLifecycleCoordinator(moduleRef);
        coordinator.onApplicationBootstrap();
        // ACTUAL second bootstrap invocation on the SAME coordinator:
        // Nest suppresses this hook on re-init, so it is invoked directly.
        // It must be a no-op, not a second worker loop with a new owner.
        coordinator.onApplicationBootstrap();
        // Each loop claims at least once (one loop: row + wake re-poll =
        // 2; a duplicated worker adds at least one more claim of its own).
        await untilMicrotask(() => outbox.claims.length >= 3);
        await drainMicrotasks();
        // Exactly one worker: one claim loop, one stable owner, one send.
        expect(outbox.claims).toHaveLength(2);
        expect(
          new Set(outbox.claims.map((claim) => String(claim.owner))).size,
        ).toBe(1);
        expect(sendText).toHaveBeenCalledTimes(1);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('never restarts after shutdown and repeated close does not rearm', async () => {
      const outbox = makeOutboxPool();
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.0' }),
      );
      const { builder } = buildModule(
        RECEIPT_ENABLED_ENV,
        outbox.pool,
        sendText,
      );
      const moduleRef = await builder.compile();
      try {
        const coordinator = resolveLifecycleCoordinator(moduleRef);
        coordinator.onApplicationBootstrap();
        await untilMicrotask(() => outbox.claims.length >= 1);
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(1);
        await coordinator.onModuleDestroy();
        await drainMicrotasks();
        const claimsAtStop = outbox.claims.length;
        // ACTUAL post-shutdown bootstrap invocation: it must NOT create a
        // new worker (which would restart the claim loop with a new owner
        // and orphan the drained lifecycle).
        coordinator.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(claimsAtStop); // no restart
        // Repeated close must not rearm polling.
        await coordinator.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(claimsAtStop); // no rearm
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('claims committed intents only after real init() through the real outbox store', async () => {
      const outbox = makeOutboxPool([[outboxRow()]]);
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.OK' }),
      );
      const { builder } = buildModule(
        RECEIPT_ENABLED_ENV,
        outbox.pool,
        sendText,
      );
      const moduleRef = await builder.compile();
      try {
        await drainMicrotasks();
        // Nothing runs before initialization: no claims, no sends, no SQL.
        expect(outbox.claims).toHaveLength(0);
        expect(outbox.sequence).toEqual([]);
        // Claims begin only during real init() (onApplicationBootstrap).
        await moduleRef.init();
        // The first claim consumes the committed row; the worker then
        // wakes and re-polls (one empty claim), returning to its poll
        // sleep — exactly one loop, two deterministic claims.
        await untilMicrotask(() => outbox.claims.length >= 2);
        expect(outbox.claims).toHaveLength(2);
        expect(outbox.claims[0]?.limit).toBe(2);
        expect(sendText).toHaveBeenCalledTimes(1);
        expect(sendText).toHaveBeenCalledWith({
          to: '+525500000000',
          text: 'Detectamos 1234.56 MXN. Responde CONFIRMAR o CANCELAR.',
        });
        // The fenced CAS marks the provider wamid exactly once.
        expect(outbox.marks).toEqual(['wamid.OK']);
        // Only notification-drain SQL ran: no ingestion storage writes and
        // no outbox intent production (no INSERT into the outbox table).
        expect(outbox.pool.query).not.toHaveBeenCalled();
        expect(
          outbox.sequence.filter(
            (entry) => entry === 'insert' || entry === 'other',
          ),
        ).toEqual([]);
        expect(outbox.queriesAfterEnd()).toBe(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('uses validated options and one stable owner across claims of one coordinator', async () => {
      const outbox = makeOutboxPool();
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.X' }),
      );
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_CONCURRENCY: '1',
        RECEIPT_MEDIA_WORKER_POLL_MS: '2000',
      };
      await runLifecycle(env, outbox, sendText, async () => {
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(1);
        expect(outbox.claims[0]).toEqual({
          limit: 1,
          // `expect.stringMatching` is typed `any` in @types/jest; keep the
          // comparison literal explicitly unknown for the type-aware rule.
          owner: expect.stringMatching(OWNER_RE) as unknown,
        });
        const owner = outbox.claims[0]?.owner;
        await jest.advanceTimersByTimeAsync(1999);
        // The validated poll interval has not elapsed yet: no second claim.
        expect(outbox.claims).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(outbox.claims).toHaveLength(2);
        // One process-instance coordinator: the owner is stable across claims.
        expect(outbox.claims[1]?.owner).toBe(owner);
        // Validated concurrency supplies BOTH batch size and max concurrency:
        // one in-flight slot caps the claim limit at 1.
        expect(outbox.claims[1]?.limit).toBe(1);
        expect(sendText).not.toHaveBeenCalled();
      });
    });

    it.each([
      [1, 50],
      [49, 50],
      [50, 50],
      [2000, 2000],
    ] as const)(
      'polls exactly at its effective interval: configured %i ms -> effective %i ms',
      async (configured, effective) => {
        // Maintainer-approved minimum-polling semantics, observed through
        // real claim TIMING under fake timers — not by reading constants:
        // configured 1–49 ms polls at the approved 50 ms floor; configured
        // values at or above 50 ms keep their own interval.
        const outbox = makeOutboxPool(); // always empty batches
        const sendText = jest.fn(() =>
          Promise.resolve({ providerMessageId: 'wamid.0' }),
        );
        const env = {
          ...RECEIPT_ENABLED_ENV,
          RECEIPT_MEDIA_WORKER_POLL_MS: String(configured),
        };
        await runLifecycle(env, outbox, sendText, async () => {
          await drainMicrotasks();
          // The first claim runs at bootstrap; then the loop sleeps.
          expect(outbox.claims).toHaveLength(1);
          // Strictly BELOW the effective interval: no second claim. An
          // unclamped sub-floor value (1 or 49 ms) would already have
          // polled again here — the boundary catches that defect.
          await jest.advanceTimersByTimeAsync(effective - 1);
          await drainMicrotasks();
          expect(outbox.claims).toHaveLength(1);
          // Exactly AT the effective interval: the second claim happens.
          await jest.advanceTimersByTimeAsync(1);
          await untilMicrotask(() => outbox.claims.length >= 2);
          await drainMicrotasks();
          expect(outbox.claims).toHaveLength(2);
          expect(sendText).not.toHaveBeenCalled();
        });
      },
    );

    it('drains the in-flight send and marks SENT before the real pool lifecycle ends the pool', async () => {
      const outbox = makeOutboxPool([[outboxRow()]]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const sendText = jest.fn(() =>
        gate.then(() => ({ providerMessageId: 'wamid.GATE' })),
      );
      const { builder } = buildModule(
        RECEIPT_ENABLED_ENV,
        outbox.pool,
        sendText,
      );
      const moduleRef = await builder.compile();
      try {
        await moduleRef.init();
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(1);
        expect(sendText).toHaveBeenCalledTimes(1);
        const closing = moduleRef.close(); // destroy waits for the drain
        await drainMicrotasks();
        // Still draining: the send is NOT marked and the pool is NOT ended.
        expect(outbox.sequence).not.toContain('mark');
        expect(outbox.sequence).not.toContain('end');
        release();
        await closing;
        await drainMicrotasks();
        expect(outbox.sequence).toEqual(['claim', 'mark', 'end']);
        expect(outbox.marks).toEqual(['wamid.GATE']);
        expect(outbox.queriesAfterEnd()).toBe(0);
      } finally {
        release();
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('does not dispatch an in-flight claim resolved after shutdown and does not rearm', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const outbox = makeOutboxPool([[outboxRow()]], { claimGate: gate });
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.NEVER' }),
      );
      const { builder } = buildModule(
        RECEIPT_ENABLED_ENV,
        outbox.pool,
        sendText,
      );
      const moduleRef = await builder.compile();
      try {
        await moduleRef.init();
        await drainMicrotasks();
        // The first claim is in flight behind the gate.
        expect(outbox.sequence).toEqual(['claim']);
        expect(outbox.claims).toHaveLength(0);
        const closing = moduleRef.close(); // waits for the claim, not the next poll
        await drainMicrotasks();
        expect(outbox.sequence).not.toContain('end'); // pool NOT ended yet
        release();
        await closing;
        await drainMicrotasks();
        // The claim resolved after running=false: nothing is sent or marked.
        expect(sendText).not.toHaveBeenCalled();
        expect(outbox.marks).toEqual([]);
        expect(outbox.sequence).toEqual(['claim', 'end']);
        // The single in-flight claim completed with the row — but no
        // dispatch, so exactly one claim entry, and NO rearm afterward.
        const claimsAfterClose = outbox.claims.length;
        expect(claimsAfterClose).toBe(1);
        await jest.advanceTimersByTimeAsync(3_600_000);
        expect(outbox.claims).toHaveLength(claimsAfterClose); // no rearm
        expect(outbox.queriesAfterEnd()).toBe(0);
      } finally {
        release();
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('stops polling on shutdown with no timer rearm (sleeping shutdown)', async () => {
      const outbox = makeOutboxPool(); // always empty batches
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.0' }),
      );
      await runLifecycle(RECEIPT_ENABLED_ENV, outbox, sendText, async () => {
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(1); // one claim, then the poll sleep
        expect(sendText).not.toHaveBeenCalled();
      });
      await drainMicrotasks();
      const claimsAfterClose = outbox.claims.length;
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(outbox.claims).toHaveLength(claimsAfterClose); // no rearm after close
      expect(outbox.sequence.filter((entry) => entry === 'end')).toHaveLength(
        1,
      );
      expect(outbox.queriesAfterEnd()).toBe(0);
    });

    it('runs exactly one coordinator and one claim loop under duplicate module imports', async () => {
      const outbox = makeOutboxPool();
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.ONE' }),
      );
      applyEnv(RECEIPT_ENABLED_ENV);
      const builder = Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot({ ignoreEnvFile: true }),
          ReceiptMediaModule,
          ReceiptMediaHostWrapper,
        ],
      })
        .overrideProvider(PG_POOL)
        .useValue(outbox.pool)
        .overrideProvider(CONVERSATION_STORE)
        .useValue({ get: jest.fn().mockResolvedValue(null) })
        .overrideProvider(CHATBOT_API_CLIENT)
        .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
        .overrideProvider(WHATSAPP_SENDER)
        .useValue({ sendText });
      const moduleRef = await builder.compile();
      try {
        await moduleRef.init();
        await drainMicrotasks();
        // Exactly one claim loop across BOTH import edges of the module.
        expect(outbox.claims).toHaveLength(1);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('alerts exhaustion with a constant non-PII message only', async () => {
      const row = outboxRow({ template_args: {} });
      const outbox = makeOutboxPool([[row], [row], [row]]);
      const sendText = jest.fn(() =>
        Promise.reject(new Error('meta transport down')),
      );
      await runLifecycle(RECEIPT_ENABLED_ENV, outbox, sendText, async () => {
        await untilMicrotask(() => outbox.claims.length >= 3);
        await drainMicrotasks();
        expect(sendText).toHaveBeenCalledTimes(3);
        expect(outbox.reschedules).toEqual([1, 2, 3]);
        expect(loggerError).toHaveBeenCalledTimes(1);
        // The jest mock call list is typed `any[][]`; read the first alert
        // through an explicit cast so no unsafe member access remains.
        const firstAlert = (loggerError.mock.calls as unknown[][])[0]?.[0];
        expect(firstAlert).toBe(
          'receipt-media: notification intent exhausted after max attempts',
        );
        // No row, sender, or provider/error content in the alert — ever.
        const logged = loggerError.mock.calls
          .map((call) => JSON.stringify(call))
          .join('');
        expect(logged).not.toContain('+525500000000');
        expect(logged).not.toContain('RECEIPT_AMOUNT_CONFIRM');
        expect(outbox.queriesAfterEnd()).toBe(0);
      });
    });

    it('runs no ingestion storage work and produces no outbox intents in either mode', async () => {
      const sendText = jest.fn(() =>
        Promise.resolve({ providerMessageId: 'wamid.OK' }),
      );
      // Enabled: the drain runs, but ONLY claim/mark SQL — never ingestion
      // storage queries and never an outbox intent INSERT. One claim loop:
      // the row claim plus its by-design wake re-poll (empty).
      const enabled = makeOutboxPool([[outboxRow()]]);
      await runLifecycle(RECEIPT_ENABLED_ENV, enabled, sendText, async () => {
        await untilMicrotask(() => enabled.claims.length >= 2);
        expect(enabled.claims).toHaveLength(2);
      });
      expect(
        enabled.sequence.filter(
          (entry) => entry !== 'claim' && entry !== 'mark' && entry !== 'end',
        ),
      ).toEqual([]);
      expect(enabled.pool.query).not.toHaveBeenCalled();
      // Disabled: the lifecycle stays fully inert — no claims, timers,
      // sends, alerts, or SQL; only the real pool lifecycle closes the pool.
      const disabled = makeOutboxPool();
      await runLifecycle(RECEIPT_DISABLED_ENV, disabled, sendText, async () => {
        await jest.advanceTimersByTimeAsync(3_600_000);
        expect(disabled.claims).toHaveLength(0);
      });
      expect(disabled.sequence).toEqual(['end']);
      expect(disabled.pool.query).not.toHaveBeenCalled();
      expect(disabled.pool.connect).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledTimes(1); // only the enabled-mode send
    });
  });
});
