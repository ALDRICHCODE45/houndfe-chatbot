/** ReceiptMediaModule composition and lifecycle spec: the NestJS graph is
 * booted through the real testing module with stubbed external edges only
 * (no live PostgreSQL, Meta, backend, or outbound HTTP). Receipt media is
 * always on (receipt payment flow R3/S7): the graph composes the ingress,
 * the Meta client, the backend upload and the vision pre-fill; the
 * module-local coordinators privately own the notification drain (WU14E),
 * the ingestion drain (ODD-3A) and the outcome poller (R5), with validated
 * options/owner, drain-before-pool.end shutdown, no rearm, duplicate-import
 * singularity, and a constant non-PII exhaustion alert. */
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
import {
  ReceiptAttachmentService,
  toUploadFields,
} from './application/receipt-attachment.service';
import { CostGuardService } from '../llm-agent/application/cost-guard.service';
import { GENERATE_TEXT } from '../llm-agent/infrastructure/generate-text.provider';
import { LlmCoreModule } from '../llm-agent/infrastructure/llm-core.module';
import {
  RECEIPT_EXTRACTION,
  type ReceiptExtractionPort,
} from './domain/receipt-extraction.port';
import { ReceiptIngestionProcessor } from './application/receipt-ingestion.processor';
import { ReceiptIngressService } from './application/receipt-ingress.service';
import { META_MEDIA } from './domain/meta-media.port';
import type { ReceiptMediaRow } from './domain/receipt-media.types';
import { MetaMediaClient } from './infrastructure/meta-media.client';
import { PostgresReceiptMediaStore } from './infrastructure/postgres-receipt-media.store';
import { PostgresReceiptOutboxStore } from './infrastructure/postgres-receipt-outbox.store';
import { ReceiptMediaIngestionWorker } from './infrastructure/receipt-media-ingestion.worker';
import { ReceiptMediaNotificationWorker } from './infrastructure/receipt-media-notification.worker';
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

/** Tokens forbidden as DI registrations; the drains themselves are
 * exercised through behavior in the lifecycle describe blocks. */
const FORBIDDEN_TOKENS = [
  ReceiptMediaIngestionWorker,
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
  template_key: 'RECEIPT_PAYMENT_PARTIAL',
  template_args: { folio: 'F-1', debtCents: 123456 },
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
    .useValue(backendClient());
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

/** Validated receipt-media field set (always on). */
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

/** Backend client stub: the outcome poller reads nothing (no ATTACHED
 * rows), the upload is never reached. */
const backendClient = () => ({
  uploadReceipt: jest.fn(),
  getReceiptOutcome: jest.fn(),
});

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
    .useValue(backendClient());
  const moduleRef = await builder.compile();
  try {
    await run(moduleRef);
  } finally {
    await moduleRef.close();
  }
};

/** Instrumented fake pool for the REAL PostgresReceiptMediaStore claim
 * path: ingestion claims are recorded (limit/owner/SQL), `end` records closure, and any query after
 * closure is counted and rejected. The notification outbox drain shares this
 * pool and is deliberately neutralized (empty) so every coordinator can boot
 * together with unconflated observations. */
type IngestionPool = {
  pool: { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  claims: Array<{ limit: unknown; owner: unknown; sql: string }>;
  sequence: string[];
  queriesAfterEnd: () => number;
};

const makeIngestionPool = (
  batches: Array<Array<Record<string, unknown>>> = [],
  opts: {
    claimGate?: Promise<void>;
    failFirstClaim?: boolean;
  } = {},
): IngestionPool => {
  const pending = [...batches];
  const claims: Array<{ limit: unknown; owner: unknown; sql: string }> = [];
  const sequence: string[] = [];
  let queriesAfterEnd = 0;
  let ended = false;
  let failClaim = opts.failFirstClaim === true;
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
    sequence,
    queriesAfterEnd: () => queriesAfterEnd,
  };
};

/** Builds (not compiles) the receipt graph with stubbed edges plus optional
 * instrumented ingestion collaborators. The dispatcher must be
 * constructed from the REAL injected processor/attachment, so the fakes are
 * injected at their DI tokens and never at the dispatcher. */
const buildIngestionModule = (
  env: Record<string, string>,
  pool: unknown,
  overrides: {
    processor?: unknown;
    attachment?: unknown;
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
    .useValue(backendClient())
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
  return builder;
};

/** Boots through real init(), runs the test, and always closes. */
const runIngestion = async (
  env: Record<string, string>,
  pool: IngestionPool,
  overrides: {
    processor?: unknown;
    attachment?: unknown;
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
        [ReceiptAttachmentService, ReceiptAttachmentService],
        [ReceiptIngestionProcessor, ReceiptIngestionProcessor],
        [META_MEDIA, MetaMediaClient],
        [PostgresReceiptMediaStore, PostgresReceiptMediaStore],
      ];
      for (const [token, ctor] of members)
        expect(moduleRef.get(token as never)).toBeInstanceOf(ctor);
    });
  });

  // R3/S7: no kill switch; even the removed flag set to false changes nothing.
  it.each([
    ['always-on', RECEIPT_ENABLED_ENV],
    [
      'removed flag',
      { ...RECEIPT_ENABLED_ENV, RECEIPT_MEDIA_ENABLED: 'false' },
    ],
  ] as const)('admits through the %s ingress service', async (_label, env) => {
    await withModule(env, async (moduleRef) => {
      expect(
        await moduleRef.get(ReceiptIngressService).admit({
          senderId: 's1',
          webhookMessageId: 'w1',
          providerMediaId: 'm1',
          declaredMimeType: 'image/webp',
        }),
      ).toEqual({ kind: 'unsupported-media' });
    });
  });

  it('boots with the receipt knobs from defaults (no receipt-specific settings)', async () => {
    await withModule(BASE_ENV, (moduleRef) => {
      expect(moduleRef.get(META_MEDIA)).toBeInstanceOf(MetaMediaClient);
    });
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
      LlmCoreModule,
    ])
      expect(meta('imports')).toContain(required);
    expect(meta('exports')).toEqual([ReceiptIngressService, RECEIPT_TELEMETRY]);
  });

  it('registers neither receipt worker nor the receipt outbox composition', async () => {
    await withModule(RECEIPT_ENABLED_ENV, (moduleRef) => {
      // The ingestion worker and the outbox store stay unregistered; the
      // drains are proven through behavior below.
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

  describe('ReceiptMediaModule backend upload composition (R2)', () => {
    it('wires the backend upload client and the vision pre-fill over the shared LLM seams', async () => {
      const uploadReceipt = jest.fn().mockResolvedValue({
        receiptId: '33333333-3333-4333-8333-333333333333',
        status: 'PENDING',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        sha256: 'ab',
        previewStatus: 'READY',
      });
      const commitUploadSuccess = jest
        .fn()
        .mockResolvedValue({ kind: 'committed' });
      const generateText = jest.fn().mockResolvedValue({
        output: {
          isReceipt: true,
          amountCents: 15000,
          date: null,
          reference: null,
          bank: null,
          confidence: 'high',
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      applyEnv(RECEIPT_ENABLED_ENV);
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
        .useValue({ uploadReceipt })
        .overrideProvider(PostgresReceiptMediaStore)
        .useValue({
          commitUploadSuccess,
          claimBatch: jest.fn().mockResolvedValue([]),
          listOutcomeDue: jest.fn().mockResolvedValue([]),
        })
        .overrideProvider(GENERATE_TEXT)
        .useValue(generateText)
        .overrideProvider(WHATSAPP_SENDER)
        .useValue({
          sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid' }),
        })
        .compile();
      try {
        const costGuard = moduleRef.get(CostGuardService);
        const record = jest.spyOn(costGuard, 'record');
        const extraction = await moduleRef
          .get<ReceiptExtractionPort>(RECEIPT_EXTRACTION)
          .extract({
            bytes: Buffer.from('img'),
            mimeType: 'image/jpeg',
            expectedAmountCents: 15000,
          });
        expect(extraction).toMatchObject({
          kind: 'receipt',
          amountCents: 15000,
        });
        expect(generateText).toHaveBeenCalledWith(
          expect.objectContaining({
            model: expect.objectContaining({ modelId: 'm' }) as unknown,
          }),
        );
        expect(record).toHaveBeenCalledWith({
          promptTokens: 10,
          completionTokens: 5,
        });
        const report = await moduleRef.get(ReceiptAttachmentService).upload({
          receipt: {
            id: '11111111-1111-4111-8111-111111111111',
            capturedSaleId: 'sale-1',
            providerMediaId: 'wa-media-1',
            declaredAmountCents: null,
          } as unknown as ReceiptMediaRow,
          fence: {
            id: '11111111-1111-4111-8111-111111111111',
            owner: 'o',
            expectedVersion: '7',
          },
          file: { bytes: Buffer.from('img'), mimeType: 'image/jpeg' },
          fields: toUploadFields(
            { declaredAmountCents: null } as ReceiptMediaRow,
            extraction,
          ),
          order: null,
        });
        expect(report.kind).toBe('uploaded');
        expect(uploadReceipt).toHaveBeenCalledWith(
          'sale-1',
          expect.anything(),
          expect.anything(),
          'wa-media-1',
          expect.anything(),
        );
        expect(commitUploadSuccess).toHaveBeenCalledTimes(1);
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
        .useValue(backendClient());
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
          text: 'Confirmamos un pago de su pedido F-1. Queda un saldo pendiente de $1,234.56 MXN; puede enviarnos el comprobante del resto cuando lo tenga.',
        });
        // The fenced CAS marks the provider wamid exactly once.
        expect(outbox.marks).toEqual(['wamid.OK']);
        // Only notification-drain SQL ran: no ingestion storage writes and
        // no outbox intent production (no INSERT into the outbox table).
        // The one pool read is the G2 send-time 24 h window check.
        expect(outbox.pool.query).toHaveBeenCalledTimes(1);
        expect(outbox.pool.query).toHaveBeenCalledWith(
          expect.stringContaining('FROM customer_inbound_observations'),
          ['+525500000000', '1'],
        );
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
        .useValue(backendClient())
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
        expect(logged).not.toContain('RECEIPT_PAYMENT_PARTIAL');
        expect(outbox.queriesAfterEnd()).toBe(0);
      });
    });

    it('runs no ingestion storage work and produces no outbox intents', async () => {
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
      expect(sendText).toHaveBeenCalledTimes(1);
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
        .useValue(backendClient())
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

    it('never dispatches a non-ingestion (ATTACHED) row', async () => {
      const pool = makeIngestionPool([[{ id: 'a1', status: 'ATTACHED' }]]);
      const processor = { process: jest.fn() };
      const moduleRef = await buildIngestionModule(
        RECEIPT_ENABLED_ENV,
        pool.pool,
        { processor },
      ).compile();
      try {
        await moduleRef.init();
        await untilMicrotask(() => pool.claims.length >= 1);
        await drainMicrotasks();
        expect(processor.process).not.toHaveBeenCalled();
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

    it('runs only the ingestion claim: no outbox intent or generic work', async () => {
      const pool = makeIngestionPool([[{ id: 'r1', status: 'RESERVED' }]]);
      const processor = makeProcessor();
      await runIngestion(RECEIPT_ENABLED_ENV, pool, { processor }, async () => {
        await untilMicrotask(() => pool.claims.length >= 1);
        await drainMicrotasks();
        const sql = String(pool.claims[0]?.sql);
        expect(sql).toMatch(/status = 'RESERVED'/);
        expect(sql).not.toMatch(/delete/i);
        expect(sql).not.toMatch(/receipt_media_outbox/);
        // No generic outbox intent production and no unaccounted SQL.
        expect(
          pool.sequence.filter(
            (entry) => entry === 'insert' || entry === 'other',
          ),
        ).toEqual([]);
      });
    });
  });
});
