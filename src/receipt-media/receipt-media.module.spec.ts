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
 * duplicate-import singularity, and a constant non-PII exhaustion alert.
 * ODD-3A transitions the stale "no ingestion worker exists" assumption to
 * the exact intended contract: the ingestion worker still has no DI token
 * (the module-local lifecycle coordinator privately owns it and the
 * dispatcher), while enabled/disabled ingestion runtime behavior — claim
 * timing, the 50 ms poll floor, concurrency mapping, one stable owner,
 * abort propagation, graceful drain before pool.end, contained claim/
 * dispatch failures, and the distinct ingestion claim (no outbox/STORED
 * work) — is proven through that coordinator. ODD-3B adds the co-active
 * cleanup lifecycle: a second module-local coordinator privately owns the
 * ODD-2D2b `ReceiptCleanupService` and `ReceiptCleanupWorker` (no DI token),
 * starts only under the same `receiptMedia.enabled` + rollout-gate
 * predicate, maps concurrency to the cleanup batch size, reuses the poll
 * floor, re-drains immediately on a non-empty batch, contains claim/store
 * failures, latches destroy-before-bootstrap, and drains the active batch
 * before pool.end. Its claim is observed on a separate channel and proven
 * to target only cleanup backlog rows — never STORED or accepted media. */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  Inject,
  Injectable,
  Module,
  Logger,
  type INestApplicationContext,
} from '@nestjs/common';
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
import { ReceiptCleanupService } from './application/receipt-cleanup.service';
import { ReceiptIngestionProcessor } from './application/receipt-ingestion.processor';
import { ReceiptIngressService } from './application/receipt-ingress.service';
import { ReceiptOutboxService } from './application/receipt-outbox.service';
import { META_MEDIA } from './domain/meta-media.port';
import { OBJECT_STORAGE_PORT } from './domain/object-storage.port';
import type { ReceiptMediaRow } from './domain/receipt-media.types';
import { MetaMediaClient } from './infrastructure/meta-media.client';
import { PostgresReceiptMediaStore } from './infrastructure/postgres-receipt-media.store';
import { PostgresReceiptOutboxStore } from './infrastructure/postgres-receipt-outbox.store';
import { ReceiptCleanupWorker } from './infrastructure/receipt-cleanup.worker';
import { ReceiptMediaIngestionWorker } from './infrastructure/receipt-media-ingestion.worker';
import { ReceiptMediaNotificationWorker } from './infrastructure/receipt-media-notification.worker';
import { S3ObjectStorageAdapter } from './infrastructure/s3-object-storage.adapter';
import { ReceiptMediaAccessController } from './presentation/receipt-media-access.controller';
import { ReceiptMetricsController } from './presentation/receipt-metrics.controller';
import {
  PrometheusReceiptTelemetry,
  RECEIPT_TELEMETRY,
} from './infrastructure/prometheus-receipt-telemetry';
import { ReceiptMediaModule } from './receipt-media.module';

/** One extra import edge over the receipt module: any duplicate import
 * still resolves to the SAME Nest module instance, so the lifecycle
 * coordinator (and its claim loop) must exist exactly once. */
const DIRECT_TELEMETRY_CONSUMER = Symbol('DIRECT_TELEMETRY_CONSUMER');

@Injectable()
class TelemetryConsumer {
  constructor(
    @Inject(RECEIPT_TELEMETRY) readonly telemetry: PrometheusReceiptTelemetry,
  ) {}
}

@Module({ imports: [ReceiptMediaModule], providers: [TelemetryConsumer] })
class ReceiptMediaHostWrapper {}

/** Tokens the module must never register, in either mode: the ingestion
 * worker, the outbox service, and the outbox store stay unregistered (the
 * notification worker has no DI token either — WU14E owns it privately —
 * but token absence alone does not prove the private worker did not run,
 * so lifecycle behavior is proven separately below). */
const FORBIDDEN_NONWORKER_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptMediaNotificationWorker,
  ReceiptCleanupWorker,
  ReceiptCleanupService,
  ReceiptOutboxService,
  PostgresReceiptOutboxStore,
] as const;

/** Tokens forbidden as DI registrations; the notification drain itself is
 * exercised through behavior in the WU14E lifecycle describe block. */
const FORBIDDEN_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptCleanupWorker,
  ReceiptCleanupService,
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
      // ODD-3A: the ingestion claim shares this injected pool but is NOT
      // the notification path under test, so it is neutralized (empty)
      // without touching the notification sequence or claim list.
      if (!/receipt_media_outbox/.test(sql)) return { rows: [], rowCount: 0 };
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
  RECEIPT_MEDIA_INGESTION_ENABLED: 'true',
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

/** Instrumented fake pool for the REAL PostgresReceiptMediaStore claim
 * path: ingestion claims are recorded (limit/owner/SQL), cleanup claims are
 * recorded on their own channel, `end` records closure, and any query after
 * closure is counted and rejected. The notification outbox drain shares this
 * pool and is deliberately neutralized (empty) so every coordinator can boot
 * together with unconflated observations. */
type IngestionPool = {
  pool: { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  claims: Array<{ limit: unknown; owner: unknown; sql: string }>;
  cleanupClaims: Array<{ limit: unknown; owner: unknown; sql: string }>;
  sequence: string[];
  queriesAfterEnd: () => number;
};

const makeIngestionPool = (
  batches: Array<Array<Record<string, unknown>>> = [],
  opts: {
    claimGate?: Promise<void>;
    failFirstClaim?: boolean;
    failFirstCleanupClaim?: boolean;
    cleanupBatches?: Array<Array<Record<string, unknown>>>;
  } = {},
): IngestionPool => {
  const pending = [...batches];
  const cleanupPending = [...(opts.cleanupBatches ?? [])];
  const cleanupRows = new Map<string, Record<string, unknown>>();
  const claims: Array<{ limit: unknown; owner: unknown; sql: string }> = [];
  const cleanupClaims: Array<{
    limit: unknown;
    owner: unknown;
    sql: string;
  }> = [];
  const sequence: string[] = [];
  let queriesAfterEnd = 0;
  let ended = false;
  let failClaim = opts.failFirstClaim === true;
  let failCleanupClaim = opts.failFirstCleanupClaim === true;
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
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
      // The notification drain shares this pool; its outbox claim is
      // neutralized so it never enters the ingestion observations.
      if (/receipt_media_outbox/.test(sql)) return { rows: [], rowCount: 0 };
      // ODD-3B: the cleanup claim shares this pool too. It is recorded on
      // its own channel and never in `sequence`, so ingestion observations
      // stay unconflated while the cleanup drain stays observable.
      if (/cleanup_pending = true/.test(sql)) {
        cleanupClaims.push({ limit: params?.[0], owner: params?.[1], sql });
        if (failCleanupClaim) {
          failCleanupClaim = false;
          throw new Error('receipt-media test: injected cleanup claim failure');
        }
        const rows =
          cleanupPending.length > 0
            ? (cleanupPending.shift() as Array<Record<string, unknown>>)
            : [];
        for (const row of rows) cleanupRows.set(String(row.id), row);
        return { rows, rowCount: rows.length };
      }
      // Recorded BEFORE the optional gate so an in-flight claim is
      // observable while it is still unresolved.
      sequence.push('claim');
      await opts.claimGate;
      if (failClaim) {
        failClaim = false;
        throw new Error('receipt-media test: injected claim failure');
      }
      claims.push({ limit: params?.[0], owner: params?.[1], sql });
      const rows = pending.length > 0 ? (pending.shift() as unknown[]) : [];
      return { rows, rowCount: rows.length };
    }
    // ODD-3B cleanup disposition SQL, only reached for a claimed cleanup
    // row; it is neutralized onto its own channel and never pushes
    // `sequence` entries, so the no-other-work evidence stays intact.
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
    cleanupClaims,
    sequence,
    queriesAfterEnd: () => queriesAfterEnd,
  };
};

/** Builds (not compiles) the receipt graph with stubbed edges plus optional
 * instrumented ingestion/cleanup collaborators. The dispatcher must be
 * constructed from the REAL injected processor/attachment, so the fakes are
 * injected at their DI tokens and never at the dispatcher. */
const buildIngestionModule = (
  env: Record<string, string>,
  pool: unknown,
  overrides: {
    processor?: unknown;
    attachment?: unknown;
    storage?: unknown;
  } = {},
): ReturnType<typeof Test.createTestingModule> => {
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
    .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
    .overrideProvider(WHATSAPP_SENDER)
    .useValue({
      sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid' }),
    });
  if (overrides.processor)
    builder
      .overrideProvider(ReceiptIngestionProcessor)
      .useValue(overrides.processor);
  if (overrides.attachment)
    builder
      .overrideProvider(ReceiptAttachmentService)
      .useValue(overrides.attachment);
  if (overrides.storage)
    builder.overrideProvider(OBJECT_STORAGE_PORT).useValue(overrides.storage);
  return builder;
};

/** Boots through real init(), runs the test, and always closes. */
const runIngestion = async (
  env: Record<string, string>,
  pool: IngestionPool,
  overrides: {
    processor?: unknown;
    attachment?: unknown;
    storage?: unknown;
  },
  run: (moduleRef: INestApplicationContext) => Promise<void> | void,
): Promise<void> => {
  const moduleRef = await buildIngestionModule(
    env,
    pool.pool,
    overrides,
  ).compile();
  try {
    await moduleRef.init();
    await run(moduleRef);
  } finally {
    await moduleRef.close().catch(() => undefined);
    await drainMicrotasks();
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

  describe('ReceiptMediaModule attachment capability composition (ODD-5A)', () => {
    it('injects the module capability so the composed attachment service posts the reconstructed token URL without the private object key', async () => {
      const receiptId = '11111111-1111-4111-8111-111111111111';
      const privateObjectKey = 'receipts/private-object-key';
      const attachReceipt = jest.fn<
        Promise<{ receiptId: string; status: string }>,
        [string, { mediaUrl: string; declaredAmountCents: number }]
      >(() => Promise.resolve({ receiptId: 'backend-1', status: 'PENDING' }));
      const startAttachRequest = jest.fn().mockResolvedValue({
        kind: 'started',
        version: '8',
        receipt: {
          id: receiptId,
          capturedSaleId: 'sale-1',
          objectKey: privateObjectKey,
          version: '8',
          declaredAmountCents: 15000,
        },
      });
      // Broad enablement keeps the real CapabilityService alive while the
      // dedicated ingestion rollout gate stays off, so no worker claims run.
      const env = { ...RECEIPT_ENABLED_ENV };
      delete env.RECEIPT_MEDIA_INGESTION_ENABLED;
      applyEnv(env);
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot({ ignoreEnvFile: true }),
          ReceiptMediaModule,
        ],
      })
        .overrideProvider(PG_POOL)
        .useValue(makeOutboxPool().pool)
        .overrideProvider(CONVERSATION_STORE)
        .useValue({ get: jest.fn().mockResolvedValue(null) })
        .overrideProvider(CHATBOT_API_CLIENT)
        .useValue({ attachReceipt })
        .overrideProvider(PostgresReceiptMediaStore)
        .useValue({
          startAttachRequest,
          commitAttachSuccess: jest.fn().mockResolvedValue({
            kind: 'committed',
          }),
          commitAttachDefiniteFailure: jest.fn(),
          commitAttachUnknownOutcome: jest.fn(),
        })
        .overrideProvider(WHATSAPP_SENDER)
        .useValue({
          sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid' }),
        })
        .compile();
      try {
        const issued = moduleRef.get(CapabilityService).issue(receiptId);
        const report = await moduleRef.get(ReceiptAttachmentService).attach({
          receipt: {
            id: receiptId,
            capturedSaleId: 'sale-1',
            objectKey: privateObjectKey,
            version: '7',
            declaredAmountCents: 15000,
            capabilityTokenHash: issued.tokenHash,
            capabilityKeyVersion: issued.keyVersion,
          } as unknown as ReceiptMediaRow,
          owner: 'owner-1',
        });
        expect(report).toEqual({
          kind: 'attached',
          backendReceiptId: 'backend-1',
        });
        const [saleId, body] = attachReceipt.mock.calls[0];
        expect(saleId).toBe('sale-1');
        expect(body.mediaUrl).toBe(
          `https://media.example.com/media/receipts/${issued.token}`,
        );
        expect(body.mediaUrl).not.toContain(privateObjectKey);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });
  });

  describe('ReceiptMediaModule WU15-2 telemetry composition', () => {
    it('registers the metrics controller', async () => {
      await withModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
        expect(moduleRef.get(ReceiptMetricsController)).toBeInstanceOf(
          ReceiptMetricsController,
        );
      });
    });

    it('registers the telemetry adapter as RECEIPT_TELEMETRY', async () => {
      await withModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
        const adapter =
          moduleRef.get<PrometheusReceiptTelemetry>(RECEIPT_TELEMETRY);
        expect(adapter).toBeInstanceOf(PrometheusReceiptTelemetry);
        expect(typeof adapter.record).toBe('function');
        expect(typeof adapter.metrics).toBe('function');
      });
    });

    it('exports RECEIPT_TELEMETRY from the module', () => {
      const meta = (key: string): unknown[] =>
        (Reflect.getMetadata(key, ReceiptMediaModule) as unknown[]) ?? [];
      expect(meta('exports')).toContain(RECEIPT_TELEMETRY);
    });

    it('the telemetry adapter is a singleton — duplicate module imports resolve the same instance', async () => {
      const pool = stubPool();
      applyEnv({
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_METRICS_ENABLED: 'true',
        RECEIPT_MEDIA_METRICS_TOKEN: 'a'.repeat(64),
      });
      const builder = Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot({ ignoreEnvFile: true }),
          ReceiptMediaModule,
          ReceiptMediaHostWrapper,
        ],
        providers: [
          { provide: DIRECT_TELEMETRY_CONSUMER, useClass: TelemetryConsumer },
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
        const direct = moduleRef.get<TelemetryConsumer>(
          DIRECT_TELEMETRY_CONSUMER,
        );
        const wrapped = moduleRef
          .select(ReceiptMediaHostWrapper)
          .get(TelemetryConsumer, { strict: true });
        expect(direct).not.toBe(wrapped);
        expect(direct.telemetry).toBe(wrapped.telemetry);
        direct.telemetry.record('receipt_outbox_tx2_committed');
        wrapped.telemetry.record('receipt_outbox_tx2_committed');
        expect((await direct.telemetry.metrics()).split('\n')).toContain(
          'receipt_outbox_tx2_committed_total 2',
        );
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });
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

    it('latches shutdown before any bootstrap so a later bootstrap cannot start a notification drain', async () => {
      const outbox = makeOutboxPool([[outboxRow()]]);
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
        const coordinator = resolveLifecycleCoordinator(moduleRef);
        // Destruction happens BEFORE any bootstrap: the coordinator must
        // latch terminated independently of whether a worker ever existed.
        await coordinator.onModuleDestroy();
        // Safe repeated destroy before bootstrap.
        await coordinator.onModuleDestroy();
        // A later bootstrap must NOT construct/start a worker: no claim, no
        // timer/rearm, no send.
        coordinator.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(0);
        expect(sendText).not.toHaveBeenCalled();
        // No notification claim/mark SQL ran before the pool lifecycle
        // ended it: the sequence holds only the eventual `end` marker.
        expect(outbox.sequence).toEqual([]);
        expect(outbox.marks).toEqual([]);
        // Still inert after another destroy and time advance.
        await coordinator.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(outbox.claims).toHaveLength(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
      // The real pool lifecycle closed the pool last; nothing ran after.
      expect(outbox.queriesAfterEnd()).toBe(0);
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

  describe('ReceiptMediaModule ingestion lifecycle (ODD-3A)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const OWNER_RE =
      /^receipt-media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    type IngestionLifecycleHooks = {
      onApplicationBootstrap(): void;
      onModuleDestroy(): Promise<void>;
    };

    /** Resolves the module-local ingestion coordinator WITHOUT exporting the
     * internal class: it is read from the module's DECLARED provider metadata
     * (a public contract of ReceiptMediaModule) and resolved through real
     * Nest DI, so tests can drive its hooks directly where Nest suppresses a
     * repeated bootstrap hook. */
    const resolveIngestionLifecycle = (
      moduleRef: INestApplicationContext,
    ): IngestionLifecycleHooks => {
      const providers = (Reflect.getMetadata('providers', ReceiptMediaModule) ??
        []) as unknown[];
      const ctor = providers.find(
        (provider) =>
          typeof provider === 'function' &&
          (provider as { name?: string }).name ===
            'ReceiptMediaIngestionLifecycle',
      ) as abstract new (...args: never[]) => IngestionLifecycleHooks;
      expect(ctor).toBeDefined();
      return moduleRef.get(ctor);
    };

    const makeProcessor = (): {
      process: jest.Mock<Promise<unknown>, [unknown, string, AbortSignal?]>;
    } => ({
      process: jest.fn<Promise<unknown>, [unknown, string, AbortSignal?]>(() =>
        Promise.resolve({ kind: 'downloaded' }),
      ),
    });

    it('claims nothing while only compiled and begins claiming exactly at bootstrap', async () => {
      const pool = makeIngestionPool();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
      ).compile();
      try {
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(0);
        expect(pool.sequence).toEqual([]);
        await moduleRef.init();
        await untilMicrotask(() => pool.claims.length >= 1);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(1);
        expect(pool.claims[0]?.limit).toBe(2); // default concurrency
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('is fully inert when disabled: no claim, no timer, no external call, only pool.end', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const moduleRef = await buildIngestionModule(
        RECEIPT_DISABLED_ENV,
        pool.pool,
      ).compile();
      try {
        await moduleRef.init();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(0);
        expect(pool.sequence).toEqual([]);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
      expect(pool.sequence).toEqual(['end']);
      expect(pool.queriesAfterEnd()).toBe(0);
    });

    it.each(['omitted', 'false'] as const)(
      'stays fully inert while receipt media is enabled but the ingestion gate is %s',
      async (gate) => {
        const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
        const processor = makeProcessor();
        // Broad receipt media stays enabled (notification still runs); only
        // the dedicated ingestion rollout gate is absent/false.
        const env = { ...RECEIPT_ENABLED_ENV };
        if (gate === 'omitted') delete env.RECEIPT_MEDIA_INGESTION_ENABLED;
        else env.RECEIPT_MEDIA_INGESTION_ENABLED = 'false';
        const moduleRef = await buildIngestionModule(env, pool.pool, {
          processor,
        }).compile();
        try {
          await moduleRef.init();
          await jest.advanceTimersByTimeAsync(3_600_000);
          await drainMicrotasks();
          expect(pool.claims).toHaveLength(0);
          expect(pool.sequence).toEqual([]);
          expect(processor.process).not.toHaveBeenCalled();
        } finally {
          await moduleRef.close().catch(() => undefined);
          await drainMicrotasks();
        }
      },
    );

    it('keeps the worker unexposed as a DI token and latches one worker/owner on repeated bootstrap', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const processor = makeProcessor();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { processor },
      ).compile();
      try {
        expect(() => {
          void moduleRef.get(ReceiptMediaIngestionWorker, { strict: true });
        }).toThrow();
        const coordinator = resolveIngestionLifecycle(moduleRef);
        coordinator.onApplicationBootstrap();
        // ACTUAL second bootstrap on the SAME coordinator (Nest suppresses
        // the hook on re-init, so it is invoked directly). It must be a
        // no-op, not a second worker loop with a new owner.
        coordinator.onApplicationBootstrap();
        // Exactly one loop: the row claim plus the dispatch-settle wake
        // re-poll; a duplicated worker would add at least one more claim.
        await untilMicrotask(() => pool.claims.length >= 2);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(2);
        expect(
          new Set(pool.claims.map((claim) => String(claim.owner))).size,
        ).toBe(1);
        expect(String(pool.claims[0]?.owner)).toMatch(OWNER_RE);
        expect(processor.process).toHaveBeenCalledTimes(1);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('runs exactly one ingestion loop under duplicate module imports', async () => {
      const pool = makeIngestionPool();
      applyEnv(RECEIPT_ENABLED_ENV);
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot({ ignoreEnvFile: true }),
          ReceiptMediaModule,
          ReceiptMediaHostWrapper,
        ],
      })
        .overrideProvider(PG_POOL)
        .useValue(pool.pool)
        .overrideProvider(CONVERSATION_STORE)
        .useValue({ get: jest.fn().mockResolvedValue(null) })
        .overrideProvider(CHATBOT_API_CLIENT)
        .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
        .overrideProvider(WHATSAPP_SENDER)
        .useValue({
          sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid' }),
        })
        .compile();
      try {
        await moduleRef.init();
        await drainMicrotasks();
        // Any duplicate import resolves to the SAME Nest module instance, so
        // the single private coordinator claims exactly once.
        expect(pool.claims).toHaveLength(1);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('is idempotent on shutdown and never rearms on a post-shutdown bootstrap', async () => {
      const pool = makeIngestionPool();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
      ).compile();
      try {
        const coordinator = resolveIngestionLifecycle(moduleRef);
        coordinator.onApplicationBootstrap();
        await untilMicrotask(() => pool.claims.length >= 1);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(1);
        await coordinator.onModuleDestroy();
        await drainMicrotasks();
        const stopped = pool.claims.length;
        // ACTUAL post-shutdown bootstrap: it must NOT create a new worker.
        coordinator.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(stopped);
        // Repeated close must not rearm polling either.
        await coordinator.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(stopped);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('latches shutdown before any bootstrap so a later bootstrap cannot start a worker', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const processor = makeProcessor();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { processor },
      ).compile();
      try {
        const coordinator = resolveIngestionLifecycle(moduleRef);
        // Destruction happens BEFORE any bootstrap: the coordinator must
        // latch terminated independently of whether a worker ever existed.
        await coordinator.onModuleDestroy();
        // Safe repeated destroy before bootstrap.
        await coordinator.onModuleDestroy();
        // A later bootstrap must NOT construct/start a worker: no claim, no
        // timer/rearm, no external call.
        coordinator.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(0);
        expect(pool.sequence).toEqual([]);
        expect(processor.process).not.toHaveBeenCalled();
        // Still inert after another destroy and time advance.
        await coordinator.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('uses one stable, well-formed owner across every claim of one coordinator', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const processor = makeProcessor();
      await runIngestion(RECEIPT_ENABLED_ENV, pool, { processor }, async () => {
        await untilMicrotask(() => pool.claims.length >= 2);
        await drainMicrotasks();
        const owner = pool.claims[0]?.owner;
        expect(String(owner)).toMatch(OWNER_RE);
        expect(pool.claims.every((claim) => claim.owner === owner)).toBe(true);
      });
    });

    it.each([
      [1, 50],
      [49, 50],
      [50, 50],
      [2000, 2000],
    ] as const)(
      'polls at its effective interval: configured %i ms -> effective %i ms',
      async (configured, effective) => {
        const pool = makeIngestionPool();
        const env = {
          ...RECEIPT_ENABLED_ENV,
          RECEIPT_MEDIA_WORKER_POLL_MS: String(configured),
        };
        await runIngestion(env, pool, {}, async () => {
          await drainMicrotasks();
          expect(pool.claims).toHaveLength(1);
          await jest.advanceTimersByTimeAsync(effective - 1);
          await drainMicrotasks();
          expect(pool.claims).toHaveLength(1);
          await jest.advanceTimersByTimeAsync(1);
          await untilMicrotask(() => pool.claims.length >= 2);
          await drainMicrotasks();
          expect(pool.claims).toHaveLength(2);
        });
      },
    );

    it('maps configured concurrency to both batch size and max concurrency', async () => {
      const pool = makeIngestionPool([
        [
          { id: 'r1', status: 'RESERVED' },
          { id: 'r2', status: 'RESERVED' },
          { id: 'r3', status: 'RESERVED' },
        ],
      ]);
      const gates: Array<() => void> = [];
      const processor = {
        process: jest.fn<Promise<unknown>, [unknown, string, AbortSignal?]>(
          (_receipt, _owner, signal) =>
            new Promise((resolve) => {
              const done = (): void => resolve({ kind: 'downloaded' });
              gates.push(done);
              signal?.addEventListener('abort', done, { once: true });
            }),
        ),
      };
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_CONCURRENCY: '3',
      };
      await runIngestion(env, pool, { processor }, async () => {
        await untilMicrotask(() => processor.process.mock.calls.length >= 3);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(1);
        expect(pool.claims[0]?.limit).toBe(3);
        // Capacity fully consumed: no claim while three dispatches are held.
        await jest.advanceTimersByTimeAsync(10_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(1);
        expect(gates).toHaveLength(3);
      });
    });

    it('re-polls immediately when an in-flight dispatch settles, before the poll elapses', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const processor = makeProcessor();
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_POLL_MS: '30000',
      };
      await runIngestion(env, pool, { processor }, async () => {
        // The second claim is the dispatch-settle wake, reached with NO
        // timer advance (poll interval is 30s; the poll path cannot fire).
        await untilMicrotask(() => pool.claims.length >= 2);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(2);
      });
    });

    it('aborts the same signal handed to an active processor collaborator on shutdown', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const signals: AbortSignal[] = [];
      const processor = {
        process: jest.fn<Promise<unknown>, [unknown, string, AbortSignal?]>(
          (_receipt, _owner, signal) =>
            new Promise((resolve) => {
              if (signal) signals.push(signal);
              signal?.addEventListener(
                'abort',
                () => resolve({ kind: 'aborted', stage: 'meta' }),
                { once: true },
              );
            }),
        ),
      };
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { processor },
      ).compile();
      try {
        await moduleRef.init();
        await untilMicrotask(() => signals.length >= 1);
        const closing = moduleRef.close();
        await drainMicrotasks();
        expect(signals[0]?.aborted).toBe(true);
        await closing;
        await drainMicrotasks();
        expect(pool.queriesAfterEnd()).toBe(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('aborts the same signal handed to an active attachment collaborator on shutdown', async () => {
      const pool = makeIngestionPool([[{ id: 'a1', status: 'ATTACHING' }]]);
      const signals: AbortSignal[] = [];
      const attachment = {
        attach: jest.fn<
          Promise<unknown>,
          [{ receipt: unknown; owner: string; signal?: AbortSignal }]
        >(
          (input) =>
            new Promise((resolve) => {
              if (input.signal) signals.push(input.signal);
              input.signal?.addEventListener(
                'abort',
                () => resolve({ kind: 'skipped', reason: 'fenced' }),
                { once: true },
              );
            }),
        ),
      };
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { attachment },
      ).compile();
      try {
        await moduleRef.init();
        await untilMicrotask(() => signals.length >= 1);
        const closing = moduleRef.close();
        await drainMicrotasks();
        expect(signals[0]?.aborted).toBe(true);
        await closing;
        await drainMicrotasks();
        expect(pool.queriesAfterEnd()).toBe(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('drains a held in-flight dispatch before the pool closes and issues no query after end', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const completed: string[] = [];
      const processor = {
        process: jest.fn<Promise<unknown>, [unknown, string, AbortSignal?]>(
          () =>
            gate.then(() => {
              completed.push('r1');
              return { kind: 'downloaded' };
            }),
        ),
      };
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { processor },
      ).compile();
      try {
        await moduleRef.init();
        await untilMicrotask(() => processor.process.mock.calls.length >= 1);
        await drainMicrotasks();
        const closing = moduleRef.close();
        await drainMicrotasks();
        // Still draining: the dispatch is held and the pool is NOT ended.
        expect(pool.sequence).not.toContain('end');
        expect(completed).toEqual([]);
        release();
        await closing;
        await drainMicrotasks();
        expect(completed).toEqual(['r1']);
        expect(pool.sequence[pool.sequence.length - 1]).toBe('end');
        expect(pool.queriesAfterEnd()).toBe(0);
      } finally {
        release();
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('dispatches nothing when an in-flight claim resolves after shutdown and does not rearm', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]], {
        claimGate: gate,
      });
      const processor = makeProcessor();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { processor },
      ).compile();
      try {
        await moduleRef.init();
        await drainMicrotasks();
        expect(pool.sequence).toEqual(['claim']);
        expect(pool.claims).toHaveLength(0);
        const closing = moduleRef.close(); // waits for the claim, not the poll
        await drainMicrotasks();
        expect(pool.sequence).not.toContain('end'); // pool NOT ended yet
        release();
        await closing;
        await drainMicrotasks();
        // The claim resolved after running=false: nothing is dispatched.
        expect(processor.process).not.toHaveBeenCalled();
        expect(pool.claims).toHaveLength(1);
        const afterClose = pool.claims.length;
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(afterClose); // no rearm
        expect(pool.queriesAfterEnd()).toBe(0);
      } finally {
        release();
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('contains a claim failure and keeps polling on the next interval', async () => {
      const pool = makeIngestionPool([], { failFirstClaim: true });
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_POLL_MS: '1000',
      };
      await runIngestion(env, pool, {}, async () => {
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(0); // first claim threw
        await jest.advanceTimersByTimeAsync(1000);
        await untilMicrotask(() => pool.claims.length >= 1);
        await drainMicrotasks();
        expect(pool.claims).toHaveLength(1);
      });
    });

    it('frees capacity after a dispatcher rejection and dispatches later claimed work', async () => {
      const pool = makeIngestionPool([
        [{ id: 'r1', status: 'RESERVED' }],
        [{ id: 'r2', status: 'RESERVED' }],
      ]);
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_CONCURRENCY: '1',
      };
      const processor = {
        process: jest
          .fn<Promise<unknown>, [unknown, string, AbortSignal?]>()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValue({ kind: 'downloaded' }),
      };
      await runIngestion(env, pool, { processor }, async () => {
        await untilMicrotask(() => processor.process.mock.calls.length >= 2);
        await drainMicrotasks();
        // Two dispatches plus the post-settle wake re-poll (empty).
        expect(pool.claims).toHaveLength(3);
        expect(processor.process.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({ id: 'r1' }),
        );
        expect(processor.process.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({ id: 'r2' }),
        );
      });
    });

    it('runs only the existing ingestion and cleanup claims: no STORED, outbox intent, or generic work', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const processor = makeProcessor();
      await runIngestion(RECEIPT_ENABLED_ENV, pool, { processor }, async () => {
        await untilMicrotask(() => pool.claims.length >= 1);
        await untilMicrotask(() => pool.cleanupClaims.length >= 1);
        await drainMicrotasks();
        const sql = String(pool.claims[0]?.sql);
        expect(sql).toMatch(/status = 'RESERVED'/);
        expect(sql).not.toMatch(/STORED/);
        expect(sql).not.toMatch(/cleanup/i);
        expect(sql).not.toMatch(/delete/i);
        expect(sql).not.toMatch(/receipt_media_outbox/);
        // The co-active ODD-3B cleanup claim is a distinct bounded claim over
        // ONLY durable cleanup backlog rows: never STORED, never accepted
        // media, and never a generic delete.
        const cleanupSql = String(pool.cleanupClaims[0]?.sql);
        expect(cleanupSql).toMatch(/status = 'FAILED'/);
        expect(cleanupSql).toMatch(
          /failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'/,
        );
        expect(cleanupSql).toMatch(/cleanup_pending = true/);
        expect(cleanupSql).not.toMatch(/STORED/);
        expect(cleanupSql).not.toMatch(/delete/i);
        expect(cleanupSql).not.toMatch(/receipt_media_outbox/);
        // No generic outbox intent production and no unaccounted SQL.
        expect(
          pool.sequence.filter(
            (entry) => entry === 'insert' || entry === 'other',
          ),
        ).toEqual([]);
      });
    });
  });

  describe('ReceiptMediaModule cleanup lifecycle (ODD-3B)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const OWNER_RE =
      /^receipt-media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    type CleanupLifecycleHooks = {
      onApplicationBootstrap(): void;
      onModuleDestroy(): Promise<void>;
    };

    /** Resolves the module-local cleanup coordinator WITHOUT exporting the
     * internal class: it is read from the module's DECLARED provider metadata
     * (a public contract of ReceiptMediaModule) and resolved through real
     * Nest DI, so tests can drive its hooks directly. */
    const resolveCleanupLifecycle = (
      moduleRef: INestApplicationContext,
    ): CleanupLifecycleHooks => {
      const providers = (Reflect.getMetadata('providers', ReceiptMediaModule) ??
        []) as unknown[];
      const ctor = providers.find(
        (provider) =>
          typeof provider === 'function' &&
          (provider as { name?: string }).name === 'ReceiptCleanupLifecycle',
      ) as abstract new (...args: never[]) => CleanupLifecycleHooks;
      expect(ctor).toBeDefined();
      return moduleRef.get(ctor);
    };

    /** Snake_case FAILED cleanup backlog row exactly as pg would deliver it. */
    const cleanupRow = (
      over: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id: '00000000-0000-4000-8000-0000000000c1',
      object_key: 'receipts/00000000-0000-4000-8000-0000000000c1',
      status: 'FAILED',
      failure_stage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      version: '4',
      cleanup_attempts: 1,
      cleanup_pending: true,
      ...over,
    });

    it('keeps the cleanup worker and service unexposed and claims with one stable owner', async () => {
      const pool = makeIngestionPool();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
      ).compile();
      try {
        // Neither the cleanup worker nor the cleanup service is a DI token:
        // the private module-local lifecycle owns both.
        expect(() => {
          void moduleRef.get(ReceiptCleanupWorker, { strict: true });
        }).toThrow();
        expect(() => {
          void moduleRef.get(ReceiptCleanupService, { strict: true });
        }).toThrow();
        const coordinator = resolveCleanupLifecycle(moduleRef);
        coordinator.onApplicationBootstrap();
        // A second bootstrap on the SAME coordinator is a no-op: no second
        // loop and no second owner.
        coordinator.onApplicationBootstrap();
        await untilMicrotask(() => pool.cleanupClaims.length >= 1);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(1);
        expect(pool.cleanupClaims[0]?.limit).toBe(2); // default concurrency
        expect(String(pool.cleanupClaims[0]?.owner)).toMatch(OWNER_RE);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('maps configured concurrency to the cleanup batch size', async () => {
      const pool = makeIngestionPool();
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_CONCURRENCY: '3',
      };
      const moduleRef = await buildIngestionModule(env, pool.pool).compile();
      try {
        resolveCleanupLifecycle(moduleRef).onApplicationBootstrap();
        await untilMicrotask(() => pool.cleanupClaims.length >= 1);
        await drainMicrotasks();
        expect(pool.cleanupClaims[0]?.limit).toBe(3);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it.each(['omitted', 'false'] as const)(
      'stays fully inert while the ingestion rollout gate is %s',
      async (gate) => {
        const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
        const env = { ...RECEIPT_ENABLED_ENV };
        if (gate === 'omitted') delete env.RECEIPT_MEDIA_INGESTION_ENABLED;
        else env.RECEIPT_MEDIA_INGESTION_ENABLED = 'false';
        const moduleRef = await buildIngestionModule(env, pool.pool).compile();
        try {
          resolveCleanupLifecycle(moduleRef).onApplicationBootstrap();
          await jest.advanceTimersByTimeAsync(3_600_000);
          await drainMicrotasks();
          expect(pool.cleanupClaims).toHaveLength(0);
          expect(pool.claims).toHaveLength(0); // ingestion stays inert too
        } finally {
          await moduleRef.close().catch(() => undefined);
          await drainMicrotasks();
        }
      },
    );

    it('stays fully inert when receipt media is broadly disabled', async () => {
      const pool = makeIngestionPool();
      const moduleRef = await buildIngestionModule(
        RECEIPT_DISABLED_ENV,
        pool.pool,
      ).compile();
      try {
        resolveCleanupLifecycle(moduleRef).onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it.each([
      [1, 50],
      [49, 50],
      [50, 50],
      [2000, 2000],
    ] as const)(
      'polls cleanup at its effective interval: configured %i ms -> effective %i ms',
      async (configured, effective) => {
        const pool = makeIngestionPool();
        const env = {
          ...RECEIPT_ENABLED_ENV,
          RECEIPT_MEDIA_WORKER_POLL_MS: String(configured),
        };
        const moduleRef = await buildIngestionModule(env, pool.pool).compile();
        try {
          resolveCleanupLifecycle(moduleRef).onApplicationBootstrap();
          await drainMicrotasks();
          expect(pool.cleanupClaims).toHaveLength(1);
          await jest.advanceTimersByTimeAsync(effective - 1);
          await drainMicrotasks();
          expect(pool.cleanupClaims).toHaveLength(1);
          await jest.advanceTimersByTimeAsync(1);
          await untilMicrotask(() => pool.cleanupClaims.length >= 2);
          await drainMicrotasks();
          expect(pool.cleanupClaims).toHaveLength(2);
        } finally {
          await moduleRef.close().catch(() => undefined);
          await drainMicrotasks();
        }
      },
    );

    it('re-drains immediately after a non-empty cleanup batch with no poll wait', async () => {
      const pool = makeIngestionPool([], { cleanupBatches: [[cleanupRow()]] });
      const storage = {
        deleteTechnicalObject: jest
          .fn<Promise<void>, [{ key: string; abortSignal: AbortSignal }]>()
          .mockResolvedValue(undefined),
      };
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { storage },
      ).compile();
      try {
        resolveCleanupLifecycle(moduleRef).onApplicationBootstrap();
        // The non-empty batch drains back-to-back with no timer advance.
        await untilMicrotask(() => pool.cleanupClaims.length >= 2);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(2);
        expect(storage.deleteTechnicalObject).toHaveBeenCalledTimes(1);
        const request = storage.deleteTechnicalObject.mock.calls[0]?.[0];
        expect(request?.key).toBe(
          'receipts/00000000-0000-4000-8000-0000000000c1',
        );
        expect(request?.abortSignal).toBeInstanceOf(AbortSignal);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('contains a cleanup claim failure and keeps polling on the next interval', async () => {
      const pool = makeIngestionPool([], { failFirstCleanupClaim: true });
      const env = {
        ...RECEIPT_ENABLED_ENV,
        RECEIPT_MEDIA_WORKER_POLL_MS: '1000',
      };
      const moduleRef = await buildIngestionModule(env, pool.pool).compile();
      try {
        resolveCleanupLifecycle(moduleRef).onApplicationBootstrap();
        await drainMicrotasks();
        // The first cleanup claim threw; the loop contained it and is now
        // waiting rather than terminating.
        expect(pool.cleanupClaims).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1000);
        await untilMicrotask(() => pool.cleanupClaims.length >= 2);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(2);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('is idempotent on shutdown and never rearms on a post-shutdown bootstrap', async () => {
      const pool = makeIngestionPool();
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
      ).compile();
      try {
        const coordinator = resolveCleanupLifecycle(moduleRef);
        coordinator.onApplicationBootstrap();
        await untilMicrotask(() => pool.cleanupClaims.length >= 1);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(1);
        await coordinator.onModuleDestroy();
        await drainMicrotasks();
        const stopped = pool.cleanupClaims.length;
        coordinator.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(stopped);
        await coordinator.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(stopped);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });

    it('latches shutdown before any bootstrap so a later bootstrap cannot start cleanup', async () => {
      const pool = makeIngestionPool([], {
        cleanupBatches: [[cleanupRow()]],
      });
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
      ).compile();
      try {
        const coordinator = resolveCleanupLifecycle(moduleRef);
        await coordinator.onModuleDestroy();
        await coordinator.onModuleDestroy(); // safe repeated destroy
        coordinator.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(3_600_000);
        await drainMicrotasks();
        expect(pool.cleanupClaims).toHaveLength(0);
      } finally {
        await moduleRef.close().catch(() => undefined);
        await drainMicrotasks();
      }
    });
  });
});
