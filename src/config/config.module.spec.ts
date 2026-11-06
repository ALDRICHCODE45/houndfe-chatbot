import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from './config.module';

/**
 * Integration tests for AppConfigModule.
 *
 * AppConfigModule.forRoot() is called INSIDE each test (after env vars are
 * set) to avoid ConfigModule validating against an empty env at import time.
 *
 * Tasks:
 *   1.8 — ConfigService returns typed values when all required env vars are valid
 *   1.9 — Module compilation throws when a required env var is missing
 */
describe('AppConfigModule integration', () => {
  const VALID_ENV: Record<string, string> = {
    META_VERIFY_TOKEN: 'test_verify_token',
    META_APP_SECRET: 'test_app_secret',
    META_ACCESS_TOKEN: 'test_access_token',
    META_PHONE_NUMBER_ID: '1234567890',
    CHATBOT_API_BASE_URL: 'https://api.houndfe.com',
    SERVICE_KEY: 'svc_test_service_key',
    CHATBOT_API_BRANCH_ID: 'branch-test-uuid',
    OPENAI_API_KEY: 'test-openai-key',
    LLM_MODEL: 'anthropic/claude-sonnet-4.5',
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    CHATBOT_API_CASHIER_USER_ID: '00000000-0000-4000-8000-000000000001',
    OPS_CHANNEL_PHONE: '5215500000000',
    // WU1B receipt media
    RECEIPT_MEDIA_MAX_BYTES: '10485760',
    RECEIPT_MEDIA_WORKER_CONCURRENCY: '2',
    RECEIPT_MEDIA_WORKER_LEASE_MS: '60000',
  };

  // Removed shipping vars (U6): managed so a leaked value never escapes a test.
  const REMOVED_SHIPPING_ENV: Record<string, string> = {
    SHIPPING_QUOTES_ENABLED: 'true',
    SHIPPING_DEMO_PARCEL_PROFILE_JSON: '{"x":1}',
    SKYDROPX_BASE_URL: 'not-a-url',
    SKYDROPX_CLIENT_ID: 'id',
    SKYDROPX_CLIENT_SECRET: 'secret',
    SKYDROPX_ORIGIN_POSTAL_CODE: 'bad',
    SKYDROPX_ORIGIN_STATE: 'x',
    SKYDROPX_ORIGIN_MUNICIPALITY: 'x',
    SKYDROPX_ORIGIN_NEIGHBORHOOD: 'x',
    MINIMAL_CATALOG_SHIPPING_ENABLED: 'false',
  };

  const MANAGED_KEYS = [
    ...Object.keys(VALID_ENV),
    ...Object.keys(REMOVED_SHIPPING_ENV),
    'LLM_MAX_STEPS',
  ];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
    delete process.env.LLM_MAX_STEPS;
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    savedEnv = {};
  });

  // ─── Task 1.8 ──────────────────────────────────────────────────────────────
  describe('when all required env vars are present and valid', () => {
    it('compiles and ConfigService returns typed values from the factory', async () => {
      Object.assign(process.env, VALID_ENV);

      const moduleRef = await Test.createTestingModule({
        imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
      }).compile();

      const config = moduleRef.get(ConfigService);

      expect(config.get<string>('meta.verifyToken')).toBe('test_verify_token');
      expect(config.get<string>('meta.appSecret')).toBe('test_app_secret');
      expect(config.get<string>('meta.accessToken')).toBe('test_access_token');
      expect(config.get<string>('meta.phoneNumberId')).toBe('1234567890');
      expect(config.get<string>('meta.graphApiBaseUrl')).toBe(
        'https://graph.facebook.com/v23.0',
      );
      expect(config.get<string>('chatbotApi.baseUrl')).toBe(
        'https://api.houndfe.com',
      );
      expect(config.get<string>('chatbotApi.serviceKey')).toBe(
        'svc_test_service_key',
      );
      expect(config.get<string>('chatbotApi.branchId')).toBe(
        'branch-test-uuid',
      );
      expect(config.get<string>('llm.openaiApiKey')).toBe('test-openai-key');
      expect(config.get<string>('llm.model')).toBe(
        'anthropic/claude-sonnet-4.5',
      );
      expect(config.get<number>('llm.maxSteps')).toBe(4);
      expect(config.get<number>('llm.historyTurns')).toBe(12);
      expect(config.get<number>('llm.monthlyTokenCeiling')).toBe(8_000_000);
      expect(config.get<number>('llm.idleTimeoutMs')).toBe(10_800_000);

      await moduleRef.close();
    });
  });

  it.each(['1', '3', '6'])(
    'keeps the explicit step cap %s through validation and factory wiring',
    async (steps) => {
      Object.assign(process.env, VALID_ENV, { LLM_MAX_STEPS: steps });
      const moduleRef = await Test.createTestingModule({
        imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
      }).compile();
      try {
        expect(moduleRef.get(ConfigService).get<number>('llm.maxSteps')).toBe(
          Number(steps),
        );
      } finally {
        await moduleRef.close();
      }
    },
  );

  // ─── Task 1.9 ──────────────────────────────────────────────────────────────
  describe('when a required env var is missing', () => {
    it('throws a configuration error when META_VERIFY_TOKEN is absent', async () => {
      Object.assign(process.env, VALID_ENV);
      delete process.env.META_VERIFY_TOKEN;

      await expect(
        Test.createTestingModule({
          imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
        }).compile(),
      ).rejects.toThrow();
    });

    it('throws a configuration error when SERVICE_KEY has wrong format', async () => {
      Object.assign(process.env, VALID_ENV);
      process.env.SERVICE_KEY = 'bad_key_without_svc_prefix';

      await expect(
        Test.createTestingModule({
          imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
        }).compile(),
      ).rejects.toThrow();
    });

    it('throws a configuration error when OPENAI_API_KEY is missing', async () => {
      Object.assign(process.env, VALID_ENV);
      delete process.env.OPENAI_API_KEY;

      await expect(
        Test.createTestingModule({
          imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
        }).compile(),
      ).rejects.toThrow();
    });

    it('throws a configuration error when LLM_MODEL is missing', async () => {
      Object.assign(process.env, VALID_ENV);
      delete process.env.LLM_MODEL;

      await expect(
        Test.createTestingModule({
          imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
        }).compile(),
      ).rejects.toThrow();
    });
  });

  // R3/S7: receipt media is always on; its knobs boot from defaults and the
  // removed flag vars have no effect.
  describe('receiptMedia always-on defaults', () => {
    it.each([
      { flag: undefined, label: 'no removed flag' },
      { flag: 'false', label: 'removed RECEIPT_MEDIA_ENABLED=false' },
    ])(
      '$label boots and ConfigService returns the default receiptMedia',
      async ({ flag }) => {
        Object.assign(process.env, VALID_ENV);
        if (flag === undefined) delete process.env.RECEIPT_MEDIA_ENABLED;
        else process.env.RECEIPT_MEDIA_ENABLED = flag;

        const moduleRef = await Test.createTestingModule({
          imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
        }).compile();

        const config = moduleRef.get(ConfigService);

        expect(config.get('receiptMedia')).toEqual({
          maxBytes: 10_485_760,
          meta: {
            allowedHosts: ['lookaside.fbsbx.com'],
            metadataTimeoutMs: 10_000,
            downloadTimeoutMs: 30_000,
          },
          worker: {
            concurrency: 2,
            leaseMs: 60_000,
            pollIntervalMs: 5_000,
          },
          metricsToken: undefined,
        });

        await moduleRef.close();
      },
    );
  });

  // U6: chatbot-side carrier quoting is gone; its env vars have no effect.
  it('boots and exposes no shipping config when the removed shipping vars are set', async () => {
    Object.assign(process.env, VALID_ENV, REMOVED_SHIPPING_ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })],
    }).compile();
    const config = moduleRef.get(ConfigService);
    expect(config.get('shippingQuotes')).toBeUndefined();
    expect(config.get('minimalCatalogAgent')).toBeUndefined();
    await moduleRef.close();
  });
});
