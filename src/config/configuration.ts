import {
  META_GRAPH_API_BASE_URL_DEFAULT,
  META_MEDIA_ALLOWED_HOSTS_DEFAULT,
} from './env.validation';
import { envBoolean } from './env-boolean';

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
const num = (v: string | undefined, def: number) =>
  v === undefined || v.trim() === '' ? def : Number(v);
const configuration = () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  meta: {
    verifyToken: process.env.META_VERIFY_TOKEN as string,
    appSecret: process.env.META_APP_SECRET as string,
    accessToken: process.env.META_ACCESS_TOKEN as string,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID as string,
    graphApiBaseUrl:
      process.env.META_GRAPH_API_BASE_URL ?? META_GRAPH_API_BASE_URL_DEFAULT,
    // Explicit, default-off sandbox compatibility mode. Any value
    // Joi.boolean() accepts as true (true/TRUE/True) enables the historical
    // Mexican trunk-1 rewrite.
    sandboxRecipientNormalizationEnabled: envBoolean(
      process.env.META_SANDBOX_RECIPIENT_NORMALIZATION,
    ),
  },
  conversationMirror: {
    // Default off: any value Joi.boolean() accepts as true sends mirror
    // rows to the backend (unit 9). Capture and enqueue are unaffected.
    deliveryEnabled: envBoolean(
      process.env.CONVERSATION_MIRROR_DELIVERY_ENABLED,
    ),
  },
  payInStore: {
    // Default off: only a value Joi.boolean() accepts as true enables the
    // «Pagar en tienda» button and the sale.pickup_* notices (S3).
    enabled: envBoolean(process.env.PAY_IN_STORE_ENABLED),
    // Default off (pay-in-store-templates S4): the owner turns it on once
    // Meta approved apartado_recordatorio / apartado_vencido /
    // apartado_plazo_actualizado. Off → a closed window stays STALE.
    templatesEnabled: envBoolean(process.env.PAY_IN_STORE_TEMPLATES_ENABLED),
  },
  backorder: {
    // Default off (restock backorder T5a, S9): the owner turns it on once
    // Meta approved the four pedido_reposicion_* templates. Off → reserved /
    // reminder outside the 24 h window are PROVIDER_REJECTED
    // TEMPLATE_NOT_APPROVED (staff calls), the other notices STALE.
    templatesEnabled: envBoolean(process.env.BACKORDER_TEMPLATES_ENABLED),
    // Approved template names (`es_MX`); defaults are the proposed ones.
    templateNames: {
      reserved:
        process.env.BACKORDER_TEMPLATE_RESERVED || 'pedido_reposicion_llego',
      reminder:
        process.env.BACKORDER_TEMPLATE_REMINDER ||
        'pedido_reposicion_recordatorio',
      expired:
        process.env.BACKORDER_TEMPLATE_EXPIRED || 'pedido_reposicion_vencido',
      lost: process.env.BACKORDER_TEMPLATE_LOST || 'pedido_reposicion_lote',
    },
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
    idleTimeoutMs: parseInt(process.env.LLM_IDLE_TIMEOUT_MS ?? '10800000', 10),
    // Cost protection phase 1; defaults mirror env.validation.
    maxOutputTokens: int(process.env.LLM_MAX_OUTPUT_TOKENS, 600)!,
    inboundTextMaxChars: int(process.env.INBOUND_TEXT_MAX_CHARS, 1000)!,
    costGuard: {
      priceInputUsdPerMtok: num(process.env.LLM_PRICE_INPUT_USD_PER_MTOK, 0.15),
      priceOutputUsdPerMtok: num(
        process.env.LLM_PRICE_OUTPUT_USD_PER_MTOK,
        0.6,
      ),
      dailyBudgetUsd: num(process.env.LLM_DAILY_BUDGET_USD, 10),
      monthlyBudgetUsd: num(process.env.LLM_MONTHLY_BUDGET_USD, 200),
      senderLimitPerHour: int(process.env.SENDER_LLM_LIMIT_PER_HOUR, 40)!,
      senderLimitPerDay: int(process.env.SENDER_LLM_LIMIT_PER_DAY, 120)!,
    },
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
    // N18 kill switch, default on (backend aebb60ef is deployed): false
    // sends none of the destination/origin keys inside `extracted`.
    destinationFieldsEnabled: envBoolean(
      process.env.RECEIPT_DESTINATION_FIELDS_ENABLED,
      true,
    ),
  },
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;
