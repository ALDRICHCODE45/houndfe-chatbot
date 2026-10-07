import configuration from './configuration';
import { envValidationSchema } from './env.validation';

const FLAG = 'HUMAN_DECISIONS_EXPIRATION_ENABLED';
const validEnv = {
  META_VERIFY_TOKEN: 'test-token',
  META_APP_SECRET: 'test-secret',
  META_ACCESS_TOKEN: 'test-access',
  META_PHONE_NUMBER_ID: '1234567890',
  CHATBOT_API_BASE_URL: 'https://api.example.com',
  SERVICE_KEY: 'svc_test',
  CHATBOT_API_BRANCH_ID: 'branch',
  CHATBOT_API_CASHIER_USER_ID: '00000000-0000-4000-8000-000000000001',
  OPENAI_API_KEY: 'test-key',
  LLM_MODEL: 'test-model',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  OPS_CHANNEL_PHONE: '5219999888777',
};

// E1: the EXPIRATION capability is default-off; only the exact env string
// 'true' enables it, and every malformed value is rejected at boot.
const enabled = (): boolean =>
  (
    configuration() as unknown as {
      minimalCatalogAgent: { expirationEnabled: boolean };
    }
  ).minimalCatalogAgent.expirationEnabled;
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

it('defaults the EXPIRATION flag off and validates canonical values', () => {
  delete process.env[FLAG];
  expect(enabled()).toBe(false);
  expect(
    (envValidationSchema.validate(validEnv).value as Record<string, unknown>)[
      FLAG
    ],
  ).toBe('false');
  process.env[FLAG] = 'true';
  expect(enabled()).toBe(true);
});

it.each(['TRUE', 'True', '1', '0', 'yes', '', ' true'])(
  'rejects ambiguous flag %p and never activates it',
  (input) => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      [FLAG]: input,
    });
    expect(error).toBeDefined();
    process.env[FLAG] = input;
    expect(enabled()).toBe(false);
  },
);
