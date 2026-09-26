import {
  META_GRAPH_API_BASE_URL_DEFAULT,
  SKYDROPX_BASE_URL_DEFAULT,
} from './env.validation';

const csv = (v: string | undefined, def: string[] | undefined = undefined) => {
  if (!v) return def;
  const r = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return r.length ? r : def;
};
const int = (v: string | undefined) => (v ? parseInt(v, 10) : undefined);
// SQ-2A-H: normalize accepted surrounding whitespace so ConfigService sees the
// same trimmed provider values that Joi validates.
const trimmed = (v: string | undefined) => v?.trim();
// SQ-5B2A: optional private measured-demo profile JSON. It is a raw, unparsed
// passthrough so shipping can stay enabled when it is absent or invalid; the
// shipping resolver fails closed later. Whitespace-only becomes undefined.
const trimmedOrUndefined = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t : undefined;
};

const configuration = () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  meta: {
    verifyToken: process.env.META_VERIFY_TOKEN as string,
    appSecret: process.env.META_APP_SECRET as string,
    accessToken: process.env.META_ACCESS_TOKEN as string,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID as string,
    graphApiBaseUrl:
      process.env.META_GRAPH_API_BASE_URL ?? META_GRAPH_API_BASE_URL_DEFAULT,
    // Explicit, default-off sandbox compatibility mode. Only the exact
    // string 'true' enables the historical Mexican trunk-1 rewrite.
    sandboxRecipientNormalizationEnabled:
      process.env.META_SANDBOX_RECIPIENT_NORMALIZATION === 'true',
  },
  chatbotApi: {
    baseUrl: process.env.CHATBOT_API_BASE_URL as string,
    serviceKey: process.env.SERVICE_KEY as string,
    branchId: process.env.CHATBOT_API_BRANCH_ID as string,
    cashierUserId: process.env.CHATBOT_API_CASHIER_USER_ID as string,
  },
  llm: {
    openaiApiKey: process.env.OPENAI_API_KEY as string,
    model: process.env.LLM_MODEL as string,
    maxSteps: parseInt(process.env.LLM_MAX_STEPS ?? '3', 10),
    historyTurns: parseInt(process.env.LLM_HISTORY_TURNS ?? '12', 10),
    monthlyTokenCeiling: parseInt(
      process.env.LLM_MONTHLY_TOKEN_CEILING ?? '8000000',
      10,
    ),
    idleTimeoutMs: parseInt(process.env.LLM_IDLE_TIMEOUT_MS ?? '10800000', 10),
  },
  database: {
    url: process.env.DATABASE_URL as string,
    poolMax: parseInt(process.env.DB_POOL_MAX ?? '5', 10),
  },
  humanHandoff: {
    enabled: process.env.HUMAN_HANDOFF_ENABLED !== 'false',
    // Retained exactly as supplied. The recipient normalization decision is
    // applied explicitly at comparison/send time, never at boot.
    opsChannelPhone: process.env.OPS_CHANNEL_PHONE,
  },
  humanDecisions: {
    // WU2A experimental gate: ONLY the exact env string 'true' enables it.
    // Anything else (unset, 'false', a typo, upper-case, '1') stays false, so
    // there is no ambiguous activation. No consumer reads this yet.
    restockEnabled: process.env.HUMAN_DECISIONS_RESTOCK_ENABLED === 'true',
  },
  receiptMedia: {
    enabled: process.env.RECEIPT_MEDIA_ENABLED === 'true',
    maxBytes: parseInt(process.env.RECEIPT_MEDIA_MAX_BYTES ?? '10485760', 10),
    meta: {
      allowedHosts: csv(process.env.META_MEDIA_ALLOWED_HOSTS, []),
      metadataTimeoutMs: int(process.env.META_MEDIA_METADATA_TIMEOUT_MS),
      downloadTimeoutMs: int(process.env.META_MEDIA_DOWNLOAD_TIMEOUT_MS),
    },
    storage: {
      endpoint: process.env.RECEIPT_STORAGE_ENDPOINT,
      region: process.env.RECEIPT_STORAGE_REGION,
      bucket: process.env.RECEIPT_STORAGE_BUCKET,
      accessKeyId: process.env.RECEIPT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.RECEIPT_STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.RECEIPT_STORAGE_FORCE_PATH_STYLE === 'true',
    },
    publicBaseUrl: process.env.RECEIPT_MEDIA_PUBLIC_BASE_URL,
    capability: {
      keys: csv(process.env.RECEIPT_CAPABILITY_KEYS),
      activeVersion: process.env.RECEIPT_CAPABILITY_ACTIVE_VERSION,
    },
    attachTimeoutMs: int(process.env.CHATBOT_API_ATTACH_TIMEOUT_MS),
    worker: {
      // R3-cleanup-rollout-gate: dedicated, default-false ingestion rollout
      // gate. Only the exact string 'true' enables it; omitted/false stay false.
      enabled: process.env.RECEIPT_MEDIA_INGESTION_ENABLED === 'true',
      concurrency: parseInt(
        process.env.RECEIPT_MEDIA_WORKER_CONCURRENCY ?? '2',
        10,
      ),
      leaseMs: parseInt(
        process.env.RECEIPT_MEDIA_WORKER_LEASE_MS ?? '60000',
        10,
      ),
      pollIntervalMs: int(process.env.RECEIPT_MEDIA_WORKER_POLL_MS),
    },
    metricsEnabled: process.env.RECEIPT_MEDIA_METRICS_ENABLED === 'true',
    metricsToken: process.env.RECEIPT_MEDIA_METRICS_TOKEN,
  },
  // SQ-2A-H: default-off shipping quotes; provider fields are trimmed env passthrough.
  shippingQuotes: {
    enabled: process.env.SHIPPING_QUOTES_ENABLED === 'true',
    // SQ-5B2A: raw private measured-demo profile JSON, trimmed, never parsed at boot.
    measuredDemoParcelProfileJson: trimmedOrUndefined(
      process.env.SHIPPING_DEMO_PARCEL_PROFILE_JSON,
    ),
    skydropx: {
      baseUrl:
        trimmed(process.env.SKYDROPX_BASE_URL) ?? SKYDROPX_BASE_URL_DEFAULT,
      clientId: trimmed(process.env.SKYDROPX_CLIENT_ID),
      clientSecret: trimmed(process.env.SKYDROPX_CLIENT_SECRET),
      originPostalCode: trimmed(process.env.SKYDROPX_ORIGIN_POSTAL_CODE),
      originState: trimmed(process.env.SKYDROPX_ORIGIN_STATE),
      originMunicipality: trimmed(process.env.SKYDROPX_ORIGIN_MUNICIPALITY),
      originNeighborhood: trimmed(process.env.SKYDROPX_ORIGIN_NEIGHBORHOOD),
    },
  },
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;
