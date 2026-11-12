import {
  META_GRAPH_API_BASE_URL_DEFAULT,
  META_MEDIA_ALLOWED_HOSTS_DEFAULT,
} from './env.validation';

const csv = (v: string | undefined, def: string[] | undefined = undefined) => {
  if (!v) return def;
  const r = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return r.length ? r : def;
};
const int = (v: string | undefined, def?: number) =>
  v ? parseInt(v, 10) : def;
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
  conversationMirror: {
    // Default off: only the exact string 'true' sends mirror rows to the
    // backend (unit 9). Capture and enqueue are unaffected.
    deliveryEnabled:
      process.env.CONVERSATION_MIRROR_DELIVERY_ENABLED === 'true',
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
    maxSteps: parseInt(process.env.LLM_MAX_STEPS ?? '4', 10),
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
    // Retained exactly as supplied. The recipient normalization decision is
    // applied explicitly at comparison/send time, never at boot.
    opsChannelPhone: process.env.OPS_CHANNEL_PHONE,
  },
  receiptMedia: {
    // Always on (receipt payment flow R3/S7); defaults mirror env.validation.
    maxBytes: parseInt(process.env.RECEIPT_MEDIA_MAX_BYTES ?? '10485760', 10),
    meta: {
      allowedHosts: csv(
        process.env.META_MEDIA_ALLOWED_HOSTS,
        csv(META_MEDIA_ALLOWED_HOSTS_DEFAULT),
      ),
      metadataTimeoutMs: int(
        process.env.META_MEDIA_METADATA_TIMEOUT_MS,
        10_000,
      ),
      downloadTimeoutMs: int(
        process.env.META_MEDIA_DOWNLOAD_TIMEOUT_MS,
        30_000,
      ),
    },
    worker: {
      concurrency: parseInt(
        process.env.RECEIPT_MEDIA_WORKER_CONCURRENCY ?? '2',
        10,
      ),
      leaseMs: parseInt(
        process.env.RECEIPT_MEDIA_WORKER_LEASE_MS ?? '60000',
        10,
      ),
      pollIntervalMs: int(process.env.RECEIPT_MEDIA_WORKER_POLL_MS, 5_000),
    },
    metricsToken: process.env.RECEIPT_MEDIA_METRICS_TOKEN,
  },
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;
