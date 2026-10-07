import configuration from './configuration';
import { envValidationSchema } from './env.validation';

const FLAG = 'HUMAN_DECISIONS_CUSTOMER_INBOUND_ENABLED';
const RESTOCK = 'HUMAN_DECISIONS_RESTOCK_ENABLED';
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

// Read the public projection without requiring the new field at compile time.
const flags = () => configuration().humanDecisions as Record<string, unknown>;
const original = { [FLAG]: process.env[FLAG], [RESTOCK]: process.env[RESTOCK] };
afterEach(() => {
  for (const key of [FLAG, RESTOCK] as const) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

it.each([undefined, 'false', 'true'])(
  'validates and projects canonical customer flag %p independently of RESTOCK',
  (input) => {
    if (input === undefined) delete process.env[FLAG];
    else process.env[FLAG] = input;
    const result = envValidationSchema.validate(
      { ...validEnv, ...(input === undefined ? {} : { [FLAG]: input }) },
      { abortEarly: false },
    );
    expect(result.error).toBeUndefined();
    expect((result.value as Record<string, unknown>)[FLAG]).toBe(
      input ?? 'false',
    );
    for (const restock of ['true', 'false']) {
      process.env[RESTOCK] = restock;
      expect(flags()).toEqual({
        restockEnabled: restock === 'true',
        customerInboundEnabled: input === 'true',
      });
    }
  },
);
it.each(['TRUE', 'True', '1', '0', 'yes', '', 'true ', ' true'])(
  'rejects ambiguous flag %p at boot and never activates it in the factory',
  (input) => {
    process.env[FLAG] = input;
    const { error } = envValidationSchema.validate(
      { ...validEnv, [FLAG]: input },
      { abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error?.details.some((detail) => detail.path.includes(FLAG))).toBe(
      true,
    );
    expect(flags().customerInboundEnabled).toBe(false);
  },
);
