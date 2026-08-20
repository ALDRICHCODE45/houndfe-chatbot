import * as Joi from 'joi';

export const META_GRAPH_API_BASE_URL_DEFAULT =
  'https://graph.facebook.com/v23.0';

/**
 * Joi validation schema for all required environment variables.
 *
 * Validation options (applied by ConfigModule):
 *   abortEarly: false  — collect ALL errors before throwing, not just the first
 *   allowUnknown: true — Node.js process.env contains OS and platform vars; ignore them
 *
 * Required vars:
 *   META_VERIFY_TOKEN      — webhook challenge token (shared with Meta dashboard)
 *   META_APP_SECRET        — HMAC-SHA256 secret for signature verification
 *   META_ACCESS_TOKEN      — Graph API access token for sending messages
 *   META_PHONE_NUMBER_ID   — WhatsApp phone number id used by Graph send endpoint
 *   CHATBOT_API_BASE_URL   — base URL of the houndfe-backend chatbot-api
 *   SERVICE_KEY            — ServiceCredential raw key; MUST start with "svc_"
 *   CHATBOT_API_BRANCH_ID  — tenant branch id sent as X-Branch-Id header
 *
 * Optional vars:
 *   META_GRAPH_API_BASE_URL — Graph API base URL, defaults to v23.0
 *   PORT                    — HTTP listening port, defaults to 3000
 *   DB_POOL_MAX             — Postgres pool size, defaults to 5
 */
export const envValidationSchema = Joi.object({
  META_VERIFY_TOKEN: Joi.string().required(),
  META_APP_SECRET: Joi.string().required(),
  META_ACCESS_TOKEN: Joi.string().required(),
  META_PHONE_NUMBER_ID: Joi.string().required(),
  META_GRAPH_API_BASE_URL: Joi.string()
    .uri()
    .default(META_GRAPH_API_BASE_URL_DEFAULT),
  CHATBOT_API_BASE_URL: Joi.string().uri().required(),
  SERVICE_KEY: Joi.string().pattern(/^svc_/).required().messages({
    'string.pattern.base': '"SERVICE_KEY" must start with "svc_"',
  }),
  CHATBOT_API_BRANCH_ID: Joi.string().required(),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),

  // ─── LLM agent slice ────────────────────────────────────────────────────
  OPENAI_API_KEY: Joi.string().required(),
  LLM_MODEL: Joi.string().required(),
  LLM_MAX_STEPS: Joi.number().integer().min(1).default(3),
  LLM_HISTORY_TURNS: Joi.number().integer().min(1).default(12),
  LLM_MONTHLY_TOKEN_CEILING: Joi.number()
    .integer()
    .min(1)
    .default(8_000_000),
  LLM_IDLE_TIMEOUT_MS: Joi.number().integer().min(1).default(10_800_000),

  // ─── Durable conversation store (Postgres) ──────────────────────────────
  DATABASE_URL: Joi.string().uri().required(),
  DB_POOL_MAX: Joi.number().integer().min(1).default(5),
}).options({ allowUnknown: true });
