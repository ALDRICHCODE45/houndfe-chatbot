import { META_GRAPH_API_BASE_URL_DEFAULT } from './env.validation';

/**
 * Typed configuration factory loaded by ConfigModule.
 *
 * All values come from environment variables already validated by
 * envValidationSchema (Joi). By the time this factory runs, every
 * required var is guaranteed to be present and correctly formatted.
 */
const configuration = () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),

  meta: {
    /** Token used to verify the GET webhook challenge from Meta */
    verifyToken: process.env.META_VERIFY_TOKEN as string,
    /** App secret used for HMAC-SHA256 signature verification */
    appSecret: process.env.META_APP_SECRET as string,
    /** Bearer token for outbound calls to Meta Graph API */
    accessToken: process.env.META_ACCESS_TOKEN as string,
    /** WhatsApp phone number id used by the Graph send endpoint */
    phoneNumberId: process.env.META_PHONE_NUMBER_ID as string,
    /** Graph API base URL */
    graphApiBaseUrl:
      process.env.META_GRAPH_API_BASE_URL ?? META_GRAPH_API_BASE_URL_DEFAULT,
  },

  chatbotApi: {
    /** Base URL of the houndfe-backend /chatbot-api/* endpoints */
    baseUrl: process.env.CHATBOT_API_BASE_URL as string,
    /** Raw service credential key (starts with "svc_") */
    serviceKey: process.env.SERVICE_KEY as string,
    /** Branch ID sent as X-Branch-Id on every chatbot-api request */
    branchId: process.env.CHATBOT_API_BRANCH_ID as string,
  },

  llm: {
    /** OpenAI API key. */
    openaiApiKey: process.env.OPENAI_API_KEY as string,
    /** Model identifier (e.g. gpt-4o-mini). */
    model: process.env.LLM_MODEL as string,
    /** Hard cap on agent step loops (one tool round-trip + final answer). */
    maxSteps: parseInt(process.env.LLM_MAX_STEPS ?? '3', 10),
    /** Number of recent user/assistant turns forwarded in the prompt. */
    historyTurns: parseInt(process.env.LLM_HISTORY_TURNS ?? '12', 10),
    /** Soft monthly token aggregate; warn at 80% / 100% (never hard-fail). */
    monthlyTokenCeiling: parseInt(
      process.env.LLM_MONTHLY_TOKEN_CEILING ?? '8000000',
      10,
    ),
    /** Idle window before a sender's history is reset (3h default). */
    idleTimeoutMs: parseInt(
      process.env.LLM_IDLE_TIMEOUT_MS ?? '10800000',
      10,
    ),
  },

  database: {
    /** Postgres connection string for the durable conversation store. */
    url: process.env.DATABASE_URL as string,
    /** Maximum pool size; tune per VPS resource budget. */
    poolMax: parseInt(process.env.DB_POOL_MAX ?? '5', 10),
  },
});

export default configuration;

/** Inferred return type — use for typed `ConfigService.get<AppConfig['meta']>()` calls */
export type AppConfig = ReturnType<typeof configuration>;
