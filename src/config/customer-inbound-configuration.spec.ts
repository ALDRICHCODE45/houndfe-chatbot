import configuration from './configuration';
import { envValidationSchema } from './env.validation';

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

// Human decisions are always on: the former opt-in flags are unknown env vars
// that neither validation nor configuration reads.
const REMOVED = [
  'HUMAN_HANDOFF_ENABLED',
  'HUMAN_DECISIONS_RESTOCK_ENABLED',
  'HUMAN_DECISIONS_EXPIRATION_ENABLED',
  'HUMAN_DECISIONS_CUSTOMER_INBOUND_ENABLED',
] as const;
const original = Object.fromEntries(REMOVED.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const key of REMOVED) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

it.each(['false', 'true', 'garbage'])(
  'ignores removed human-decision flags set to %p',
  (value) => {
    const env = Object.fromEntries(REMOVED.map((k) => [k, value]));
    const result = envValidationSchema.validate(
      { ...validEnv, ...env },
      { abortEarly: false },
    );
    expect(result.error).toBeUndefined();
    const validated = result.value as Record<string, unknown>;
    for (const key of REMOVED) {
      expect(validated[key]).toBe(value);
      process.env[key] = value;
    }
    const cfg = configuration() as unknown as Record<string, unknown>;
    expect(cfg.humanDecisions).toBeUndefined();
    expect(cfg.humanHandoff).toEqual({
      opsChannelPhone: process.env.OPS_CHANNEL_PHONE,
    });
  },
);
