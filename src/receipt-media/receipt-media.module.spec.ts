/** WU14C composition spec: the non-worker ReceiptMediaModule NestJS graph,
 * booted through the real testing module with stubbed external edges only
 * (no live PostgreSQL, Meta, S3, or outbound HTTP). Proven: the graph boots
 * with the full non-worker composition, the RECEIPT_CAPABILITY_LOOKUP store
 * singleton identity, and the base64 keyring decode at the composition
 * boundary; enabled/disabled config reaches the ingress kill switch; declared
 * imports/dispatcher exports match the contract; no worker or outbox provider
 * is registered; the graph fails without ConfigService; a valid disabled
 * environment with every receipt-specific setting deleted boots inert and
 * fails closed; and enabled mode still fails without the capability keyring. */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';
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

/** Tokens the non-worker module must never register, in either mode. */
const FORBIDDEN_NONWORKER_TOKENS = [
  ReceiptMediaIngestionWorker,
  ReceiptMediaNotificationWorker,
  ReceiptOutboxService,
  PostgresReceiptOutboxStore,
] as const;

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
      for (const absent of FORBIDDEN_NONWORKER_TOKENS)
        expect(() => {
          void moduleRef.get(absent, { strict: true });
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
});
