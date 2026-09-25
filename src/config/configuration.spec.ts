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
    // WU1B receipt media
    'RECEIPT_MEDIA_ENABLED',
    'RECEIPT_MEDIA_MAX_BYTES',
    'META_MEDIA_ALLOWED_HOSTS',
    'META_MEDIA_METADATA_TIMEOUT_MS',
    'META_MEDIA_DOWNLOAD_TIMEOUT_MS',
    'RECEIPT_STORAGE_ENDPOINT',
    'RECEIPT_STORAGE_REGION',
    'RECEIPT_STORAGE_BUCKET',
    'RECEIPT_STORAGE_ACCESS_KEY_ID',
    'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
    'RECEIPT_STORAGE_FORCE_PATH_STYLE',
    'RECEIPT_MEDIA_PUBLIC_BASE_URL',
    'RECEIPT_CAPABILITY_KEYS',
    'RECEIPT_CAPABILITY_ACTIVE_VERSION',
    'CHATBOT_API_ATTACH_TIMEOUT_MS',
    'RECEIPT_MEDIA_WORKER_CONCURRENCY',
    'RECEIPT_MEDIA_WORKER_LEASE_MS',
    'RECEIPT_MEDIA_WORKER_POLL_MS',
    'RECEIPT_MEDIA_METRICS_ENABLED',
    'RECEIPT_MEDIA_METRICS_TOKEN',
    // WU2A experimental human-decisions gate
    'HUMAN_DECISIONS_RESTOCK_ENABLED',
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
  it('exposes chatbotApi.cashashierUserId from CHATBOT_API_CASHIER_USER_ID', () => {
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

  // WU1B
  describe('receiptMedia', () => {
    it.each([
      { env: undefined, expected: false, label: 'omitted defaults' },
      { env: 'false', expected: false, label: 'explicit false' },
      { env: 'true', expected: true, label: 'exact true' },
    ])('$label', ({ env, expected }) => {
      if (env === undefined) {
        delete process.env.RECEIPT_MEDIA_ENABLED;
      } else {
        process.env.RECEIPT_MEDIA_ENABLED = env;
      }
      const cfg = configuration() as unknown as {
        receiptMedia: {
          enabled: boolean;
          maxBytes: number;
          meta: { allowedHosts: string[] };
          storage: { forcePathStyle: boolean };
          worker: { concurrency: number; leaseMs: number };
          metricsEnabled: boolean;
        };
      };
      expect(cfg.receiptMedia.enabled).toBe(expected);
      expect(cfg.receiptMedia.maxBytes).toBe(10_485_760);
      expect(cfg.receiptMedia.meta.allowedHosts).toEqual([]);
      expect(cfg.receiptMedia.storage.forcePathStyle).toBe(false);
      expect(cfg.receiptMedia.worker.concurrency).toBe(2);
      expect(cfg.receiptMedia.worker.leaseMs).toBe(60_000);
      expect(cfg.receiptMedia.metricsEnabled).toBe(false);
    });

    // WU15-1: metricsToken surfaces independently on receiptMedia
    it('exposes metricsToken from RECEIPT_MEDIA_METRICS_TOKEN', () => {
      process.env.RECEIPT_MEDIA_METRICS_TOKEN = 'abc123-token-value';
      const cfg = configuration() as unknown as {
        receiptMedia: { metricsToken: string | undefined };
      };
      expect(cfg.receiptMedia.metricsToken).toBe('abc123-token-value');
    });

    it('defaults metricsToken to undefined when absent', () => {
      delete process.env.RECEIPT_MEDIA_METRICS_TOKEN;
      const cfg = configuration() as unknown as {
        receiptMedia: { metricsToken: string | undefined };
      };
      expect(cfg.receiptMedia.metricsToken).toBeUndefined();
    });

    // WU15-1: metricsToken is independent of receiptMedia.enabled
    it('exposes metricsToken when receiptMedia is disabled', () => {
      process.env.RECEIPT_MEDIA_ENABLED = 'false';
      process.env.RECEIPT_MEDIA_METRICS_TOKEN = 'independent-token';
      const cfg = configuration() as unknown as {
        receiptMedia: {
          enabled: boolean;
          metricsToken: string | undefined;
        };
      };
      expect(cfg.receiptMedia.enabled).toBe(false);
      expect(cfg.receiptMedia.metricsToken).toBe('independent-token');
    });

    // WU14B: capability versions are canonical decimal strings of arbitrary
    // magnitude; configuration passes the raw env string through verbatim
    // (never numeric, never bounded by Number.MAX_SAFE_INTEGER).
    it.each([
      '1',
      '2147483647',
      '2147483648',
      '9007199254740991',
      '9007199254740992',
      '9223372036854775808',
    ])(
      'passes RECEIPT_CAPABILITY_ACTIVE_VERSION %s through verbatim',
      (env) => {
        process.env.RECEIPT_CAPABILITY_ACTIVE_VERSION = env;
        const cfg = configuration() as {
          receiptMedia: {
            capability: { activeVersion: string; keys?: string[] };
          };
        };
        expect(cfg.receiptMedia.capability.activeVersion).toBe(env);
      },
    );
  });

  // WU2A: explicit experimental RESTOCK gate. The configuration function is
  // the real activation boundary, so only the exact env string 'true' turns it
  // on; unset, 'false', and every malformed value stay false. No implicit or
  // case-insensitive activation is possible here.
  describe('humanDecisions.restockEnabled', () => {
    const restockEnabled = () =>
      (
        configuration() as {
          humanDecisions: { restockEnabled: boolean };
        }
      ).humanDecisions.restockEnabled;

    it('defaults false when HUMAN_DECISIONS_RESTOCK_ENABLED is absent', () => {
      delete process.env.HUMAN_DECISIONS_RESTOCK_ENABLED;
      expect(restockEnabled()).toBe(false);
    });

    it('is false for the explicit env string "false"', () => {
      process.env.HUMAN_DECISIONS_RESTOCK_ENABLED = 'false';
      expect(restockEnabled()).toBe(false);
    });

    it.each(['FALSE', 'True', 'TRUE', '1', '0', 'yes', 'on', '', ' true'])(
      'stays false for the non-exact value %p',
      (value) => {
        process.env.HUMAN_DECISIONS_RESTOCK_ENABLED = value;
        expect(restockEnabled()).toBe(false);
      },
    );

    it('is true only for the exact env string "true"', () => {
      process.env.HUMAN_DECISIONS_RESTOCK_ENABLED = 'true';
      expect(restockEnabled()).toBe(true);
    });
  });
});
