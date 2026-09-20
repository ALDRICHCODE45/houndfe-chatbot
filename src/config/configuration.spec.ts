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
    'RECEIPT_MEDIA_INGESTION_ENABLED',
    'RECEIPT_MEDIA_METRICS_ENABLED',
    'RECEIPT_MEDIA_METRICS_TOKEN',
    'META_SANDBOX_RECIPIENT_NORMALIZATION',
    'OPS_CHANNEL_PHONE',
    // SQ-2A shipping quotes
    'SHIPPING_QUOTES_ENABLED',
    'SKYDROPX_BASE_URL',
    'SKYDROPX_CLIENT_ID',
    'SKYDROPX_CLIENT_SECRET',
    'SKYDROPX_ORIGIN_POSTAL_CODE',
    'SKYDROPX_ORIGIN_STATE',
    'SKYDROPX_ORIGIN_MUNICIPALITY',
    'SKYDROPX_ORIGIN_NEIGHBORHOOD',
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

  it.each([
    [undefined, false],
    ['true', true],
    ['false', false],
    ['TRUE', false],
  ])('maps META_SANDBOX_RECIPIENT_NORMALIZATION=%s', (env, expected) => {
    if (env === undefined) {
      delete process.env.META_SANDBOX_RECIPIENT_NORMALIZATION;
    } else {
      process.env.META_SANDBOX_RECIPIENT_NORMALIZATION = env;
    }
    const cfg = configuration() as unknown as {
      meta: { sandboxRecipientNormalizationEnabled: boolean };
    };
    expect(cfg.meta.sandboxRecipientNormalizationEnabled).toBe(expected);
  });

  // MVP-1: the ops wa_id is retained verbatim; no boot-time rewrite.
  it('retains humanHandoff.opsChannelPhone exactly as supplied', () => {
    process.env.OPS_CHANNEL_PHONE = '5219999888777';
    const cfg = configuration() as unknown as {
      humanHandoff: { opsChannelPhone?: string };
    };
    expect(cfg.humanHandoff.opsChannelPhone).toBe('5219999888777');
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

    // R3-cleanup-rollout-gate: the ingestion rollout gate is surfaced as
    // `receiptMedia.worker.enabled` and is fail-closed: only the exact string
    // 'true' enables it; omitted, 'false', and any other casing stay false.
    it.each([
      { env: undefined, expected: false, label: 'omitted defaults false' },
      { env: 'false', expected: false, label: 'explicit false' },
      { env: 'TRUE', expected: false, label: 'non-exact casing stays false' },
      { env: 'true', expected: true, label: 'exact true enables' },
    ])('exposes worker.enabled: $label', ({ env, expected }) => {
      if (env === undefined) {
        delete process.env.RECEIPT_MEDIA_INGESTION_ENABLED;
      } else {
        process.env.RECEIPT_MEDIA_INGESTION_ENABLED = env;
      }
      const cfg = configuration() as unknown as {
        receiptMedia: { worker: { enabled: boolean } };
      };
      expect(cfg.receiptMedia.worker.enabled).toBe(expected);
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

  // SQ-2A: default-off shipping quotes; only exact 'true' enables the feature.
  describe('shippingQuotes', () => {
    type Shipping = {
      shippingQuotes: {
        enabled: boolean;
        skydropx: Record<string, string | undefined>;
      };
    };
    const shipping = () => (configuration() as Shipping).shippingQuotes;

    it('returns the typed default-off subtree when SHIPPING_QUOTES_ENABLED is absent', () => {
      delete process.env.SHIPPING_QUOTES_ENABLED;
      expect(shipping()).toEqual({
        enabled: false,
        skydropx: {
          baseUrl: 'https://api-pro.skydropx.com',
          clientId: undefined,
          clientSecret: undefined,
          originPostalCode: undefined,
          originState: undefined,
          originMunicipality: undefined,
          originNeighborhood: undefined,
        },
      });
    });

    it.each([
      [undefined, false],
      ['true', true],
      ['false', false],
      ['TRUE', false],
      ['False', false],
      ['1', false],
      [' true ', false],
    ])('maps SHIPPING_QUOTES_ENABLED=%s', (env, expected) => {
      if (env === undefined) {
        delete process.env.SHIPPING_QUOTES_ENABLED;
      } else {
        process.env.SHIPPING_QUOTES_ENABLED = env;
      }
      expect(shipping().enabled).toBe(expected);
    });

    it('passes raw Skydropx provider env values through the factory', () => {
      process.env.SHIPPING_QUOTES_ENABLED = 'true';
      process.env.SKYDROPX_BASE_URL = 'https://sandbox.skydropx.test';
      process.env.SKYDROPX_CLIENT_ID = 'client-id-raw';
      process.env.SKYDROPX_CLIENT_SECRET = 'client-secret-raw';
      process.env.SKYDROPX_ORIGIN_POSTAL_CODE = '06000';
      process.env.SKYDROPX_ORIGIN_STATE = 'CDMX';
      process.env.SKYDROPX_ORIGIN_MUNICIPALITY = 'Cuauhtemoc';
      process.env.SKYDROPX_ORIGIN_NEIGHBORHOOD = 'Centro';
      expect(shipping()).toEqual({
        enabled: true,
        skydropx: {
          baseUrl: 'https://sandbox.skydropx.test',
          clientId: 'client-id-raw',
          clientSecret: 'client-secret-raw',
          originPostalCode: '06000',
          originState: 'CDMX',
          originMunicipality: 'Cuauhtemoc',
          originNeighborhood: 'Centro',
        },
      });
    });

    // SQ-2A-H: accepted surrounding whitespace is normalized in the factory so
    // ConfigService sees the same trimmed values that Joi validated.
    it('trims surrounding whitespace on provider values', () => {
      process.env.SHIPPING_QUOTES_ENABLED = 'true';
      process.env.SKYDROPX_BASE_URL = '  https://sandbox.skydropx.test  ';
      process.env.SKYDROPX_CLIENT_ID = '  client-id  ';
      process.env.SKYDROPX_CLIENT_SECRET = '  client-secret  ';
      process.env.SKYDROPX_ORIGIN_POSTAL_CODE = ' 06000 ';
      process.env.SKYDROPX_ORIGIN_STATE = '  CDMX  ';
      process.env.SKYDROPX_ORIGIN_MUNICIPALITY = '  Cuauhtemoc  ';
      process.env.SKYDROPX_ORIGIN_NEIGHBORHOOD = '  Centro  ';
      expect(shipping()).toEqual({
        enabled: true,
        skydropx: {
          baseUrl: 'https://sandbox.skydropx.test',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          originPostalCode: '06000',
          originState: 'CDMX',
          originMunicipality: 'Cuauhtemoc',
          originNeighborhood: 'Centro',
        },
      });
    });
  });
});
