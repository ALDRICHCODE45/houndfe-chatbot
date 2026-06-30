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
  };

  const MANAGED_KEYS = Object.keys(VALID_ENV);
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
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
        imports: [AppConfigModule.forRoot()],
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

      await moduleRef.close();
    });
  });

  // ─── Task 1.9 ──────────────────────────────────────────────────────────────
  describe('when a required env var is missing', () => {
    it('throws a configuration error when META_VERIFY_TOKEN is absent', async () => {
      Object.assign(process.env, VALID_ENV);
      delete process.env.META_VERIFY_TOKEN;

      await expect(
        Test.createTestingModule({
          imports: [AppConfigModule.forRoot()],
        }).compile(),
      ).rejects.toThrow();
    });

    it('throws a configuration error when SERVICE_KEY has wrong format', async () => {
      Object.assign(process.env, VALID_ENV);
      process.env.SERVICE_KEY = 'bad_key_without_svc_prefix';

      await expect(
        Test.createTestingModule({
          imports: [AppConfigModule.forRoot()],
        }).compile(),
      ).rejects.toThrow();
    });
  });
});
