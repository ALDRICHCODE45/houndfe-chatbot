import configuration from './configuration';

/**
 * Unit tests for the configuration() factory.
 *
 * The factory reads env vars directly (no DI), so we stub process.env
 * before each test and restore in afterEach. Task 2.3 / 2.4.
 */
describe('configuration()', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const MANAGED_KEYS = [
    'PORT',
    'META_VERIFY_TOKEN',
    'META_APP_SECRET',
    'META_ACCESS_TOKEN',
    'META_PHONE_NUMBER_ID',
    'META_GRAPH_API_BASE_URL',
    'CHATBOT_API_BASE_URL',
    'SERVICE_KEY',
    'CHATBOT_API_BRANCH_ID',
    'CHATBOT_API_CASHIER_USER_ID',
    'OPENAI_API_KEY',
    'LLM_MODEL',
    'LLM_MAX_STEPS',
    'LLM_HISTORY_TURNS',
    'LLM_MONTHLY_TOKEN_CEILING',
    'LLM_IDLE_TIMEOUT_MS',
    'DATABASE_URL',
    'DB_POOL_MAX',
  ];

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
  });

  it('exposes database.url sourced from DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d';

    const cfg = configuration() as {
      database: { url: string; poolMax: number };
    };

    expect(cfg.database.url).toBe('postgres://u:p@h:5432/d');
  });

  it('defaults database.poolMax to 5 when DB_POOL_MAX is absent', () => {
    delete process.env.DB_POOL_MAX;
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d';

    const cfg = configuration() as {
      database: { url: string; poolMax: number };
    };

    expect(cfg.database.poolMax).toBe(5);
  });

  it('honours DB_POOL_MAX when provided as an integer string', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h:5432/d';
    process.env.DB_POOL_MAX = '12';

    const cfg = configuration() as {
      database: { url: string; poolMax: number };
    };

    expect(cfg.database.poolMax).toBe(12);
  });

  // Task 1.3/1.4: cashierUserId surfaces on chatbotApi
  it('exposes chatbotApi.cashierUserId sourced from CHATBOT_API_CASHIER_USER_ID', () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    process.env.CHATBOT_API_CASHIER_USER_ID = uuid;

    const cfg = configuration() as {
      chatbotApi: { cashierUserId: string };
    };

    expect(cfg.chatbotApi.cashierUserId).toBe(uuid);
    expect(cfg.chatbotApi.cashierUserId).toBe(
      process.env.CHATBOT_API_CASHIER_USER_ID,
    );
  });
});
