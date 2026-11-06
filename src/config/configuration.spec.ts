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
    'RECEIPT_MEDIA_METRICS_TOKEN',
    'META_SANDBOX_RECIPIENT_NORMALIZATION',
    'OPS_CHANNEL_PHONE',
    // Removed shipping vars (U6): kept here so the test restores them.
    'SHIPPING_QUOTES_ENABLED',
    'SKYDROPX_BASE_URL',
    'SKYDROPX_CLIENT_ID',
    'SKYDROPX_CLIENT_SECRET',
    'SKYDROPX_ORIGIN_POSTAL_CODE',
    'SKYDROPX_ORIGIN_STATE',
    'SKYDROPX_ORIGIN_MUNICIPALITY',
    'SKYDROPX_ORIGIN_NEIGHBORHOOD',
    'SHIPPING_DEMO_PARCEL_PROFILE_JSON',
    'MINIMAL_CATALOG_SHIPPING_ENABLED',
    // Removed always-on flags: kept here so the test restores them.
    'MINIMAL_CATALOG_AGENT_ENABLED',
    'MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS',
    'MINIMAL_CATALOG_ORDER_ENABLED',
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

  it('S2: the removed atomic checkout flag no longer configures anything', () => {
    process.env.MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED = 'true';
    expect(configuration()).not.toHaveProperty('minimalCatalogAgent');
    delete process.env.MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED;
  });

  describe('LLM step budget', () => {
    it('defaults to four steps when LLM_MAX_STEPS is absent', () => {
      delete process.env.LLM_MAX_STEPS;
      expect(configuration().llm.maxSteps).toBe(4);
    });

    it.each(['1', '3', '4', '6'])(
      'preserves the explicit LLM_MAX_STEPS=%s without raising it',
      (steps) => {
        process.env.LLM_MAX_STEPS = steps;
        expect(configuration().llm.maxSteps).toBe(Number(steps));
      },
    );
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
    it('derives the always-on receipt knobs from defaults', () => {
      for (const key of [
        'META_MEDIA_ALLOWED_HOSTS',
        'META_MEDIA_METADATA_TIMEOUT_MS',
        'META_MEDIA_DOWNLOAD_TIMEOUT_MS',
        'RECEIPT_MEDIA_WORKER_POLL_MS',
      ])
        delete process.env[key];
      const cfg = configuration();
      expect(cfg.receiptMedia.maxBytes).toBe(10_485_760);
      expect(cfg.receiptMedia.meta).toEqual({
        allowedHosts: ['lookaside.fbsbx.com'],
        metadataTimeoutMs: 10_000,
        downloadTimeoutMs: 30_000,
      });
      expect(cfg.receiptMedia.worker).toEqual({
        concurrency: 2,
        leaseMs: 60_000,
        pollIntervalMs: 5_000,
      });
    });

    it('reads explicit receipt knobs', () => {
      process.env.META_MEDIA_ALLOWED_HOSTS = 'a.example.com, .b.example';
      process.env.META_MEDIA_METADATA_TIMEOUT_MS = '5000';
      process.env.META_MEDIA_DOWNLOAD_TIMEOUT_MS = '20000';
      process.env.RECEIPT_MEDIA_WORKER_POLL_MS = '1000';
      const { meta, worker } = configuration().receiptMedia;
      expect(meta).toEqual({
        allowedHosts: ['a.example.com', '.b.example'],
        metadataTimeoutMs: 5000,
        downloadTimeoutMs: 20000,
      });
      expect(worker.pollIntervalMs).toBe(1000);
    });

    // R3/S4: the removed flag, storage and capability vars configure nothing.
    it('ignores the removed receipt flag, storage and capability vars', () => {
      Object.assign(process.env, {
        RECEIPT_MEDIA_ENABLED: 'true',
        RECEIPT_MEDIA_INGESTION_ENABLED: 'true',
        RECEIPT_STORAGE_ENDPOINT: 'https://s3.example.com',
        RECEIPT_STORAGE_BUCKET: 'bucket',
        RECEIPT_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
        RECEIPT_CAPABILITY_KEYS: '1:key',
        RECEIPT_CAPABILITY_ACTIVE_VERSION: '1',
        CHATBOT_API_ATTACH_TIMEOUT_MS: '30000',
      });
      const receiptMedia = configuration().receiptMedia as Record<
        string,
        unknown
      >;
      for (const removed of [
        'enabled',
        'storage',
        'publicBaseUrl',
        'capability',
        'attachTimeoutMs',
      ])
        expect(receiptMedia).not.toHaveProperty(removed);
      expect(receiptMedia.worker).not.toHaveProperty('enabled');
      expect(JSON.stringify(receiptMedia)).not.toMatch(/s3\.example|bucket/);
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
  });

  // U6: the backend quotes carriers; the removed chatbot-side shipping vars
  // (Skydropx, demo parcel profile, both shipping flags) configure nothing.
  describe('removed shipping vars', () => {
    it.each(['true', 'false'])('have no effect when set (flags=%s)', (flag) => {
      process.env.SHIPPING_QUOTES_ENABLED = flag;
      process.env.MINIMAL_CATALOG_SHIPPING_ENABLED = flag;
      process.env.SHIPPING_DEMO_PARCEL_PROFILE_JSON = '{"x":1}';
      process.env.SKYDROPX_BASE_URL = 'https://sandbox.skydropx.test';
      process.env.SKYDROPX_CLIENT_ID = 'id';
      process.env.SKYDROPX_CLIENT_SECRET = 'secret';
      process.env.SKYDROPX_ORIGIN_POSTAL_CODE = '06000';
      const cfg = configuration() as unknown as Record<string, unknown>;
      expect(cfg).not.toHaveProperty('shippingQuotes');
      expect(cfg).not.toHaveProperty('minimalCatalogAgent');
      expect(JSON.stringify(cfg)).not.toMatch(/skydropx|sandbox\.skydropx/i);
    });
  });

  // The minimal SDK catalog route is always on for every sender; its former
  // enable/allowlist/order/shipping env vars are removed and have no effect.
  it('ignores the removed minimal-route enable, allowlist and order env vars', () => {
    process.env.MINIMAL_CATALOG_AGENT_ENABLED = 'false';
    process.env.MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS = '5215550001111';
    process.env.MINIMAL_CATALOG_ORDER_ENABLED = 'false';
    expect(configuration()).not.toHaveProperty('minimalCatalogAgent');
  });
});
