import * as Joi from 'joi';

export const META_GRAPH_API_BASE_URL_DEFAULT =
  'https://graph.facebook.com/v23.0';

// ─── Receipt-media helpers (WU1C1) ─────────────────────────────────────────
// Local field-level helpers for the conditional receipt-media foundation.
// The base schema is `Joi.any()` so the `.when(...)` branch is a complete
// replacement; applying a typed base (`Joi.boolean()` etc.) would validate
// the value before the branch could decide permissiveness.
const RECEIPT_MAX_BYTES_VALUE = 10_485_760;
// WU1C2A numeric relations: lease is the 60-second safety window every external operation must stay strictly inside.
const RECEIPT_LEASE_MS_VALUE = 60_000;
const RECEIPT_MAX_WORKER_CONCURRENCY = 8;
const RECEIPT_MAX_ATTACH_TIMEOUT_MS = 30_000;

// Positive integer in (0, max] required schema (used for timeouts + concurrency); `<` lease variants share this base.
const receiptBoundedPositiveInt = (max: number) =>
  Joi.number().integer().min(1).max(max).required();
// Strictly-less-than-lease required schema for poll/attach where the lease boundary itself is forbidden.
const receiptLessThanLease = Joi.number()
  .integer()
  .min(1)
  .less(RECEIPT_LEASE_MS_VALUE)
  .required();

const httpsUrlSchema = Joi.string()
  .uri({ scheme: ['https'] })
  .required();

const receiptMediaHostsSchema = Joi.string()
  .required()
  .custom((value: unknown, helpers) => {
    if (typeof value !== 'string') {
      return helpers.error('any.invalid');
    }
    const labels = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (labels.length === 0) {
      return helpers.error('any.invalid');
    }
    // RFC 1123 hostname label: alphanum, internal hyphens allowed,
    // no leading/trailing hyphen. Total length <=253, each label <=63.
    const labelRe = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
    for (const raw of labels) {
      // Reject protocol, userinfo, port, path, query, fragment.
      if (/[:/?#@]/.test(raw)) {
        return helpers.error('any.invalid');
      }
      const normalized = raw.startsWith('.') ? raw.slice(1) : raw;
      if (normalized.length === 0 || normalized.length > 253) {
        return helpers.error('any.invalid');
      }
      const parts = normalized.split('.');
      for (const part of parts) {
        if (part.length === 0 || part.length > 63 || !labelRe.test(part)) {
          return helpers.error('any.invalid');
        }
      }
    }
    return value;
  }, 'meta media allowed hosts');

const receiptConditional = (then: Joi.Schema) =>
  Joi.any().when('RECEIPT_MEDIA_ENABLED', {
    is: true,
    then,
    otherwise: Joi.any(),
  });

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
 * Conditional vars (human-handoff slice):
 *   HUMAN_HANDOFF_ENABLED  — boolean, default true. Kill-switch for the
 *                             human-handoff channel.
 *   OPS_CHANNEL_PHONE      — REQUIRED when HUMAN_HANDOFF_ENABLED=true.
 *                             Wa_id of the human agent who receives
 *                             digests and replies to them. Joi accepts an
 *                             optional leading `+` (E.164).
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
  /**
   * UUID of the seeded bot-dedicated cashier User record (AGENTS.md §5.3).
   * Boot fails-fast when missing or malformed, matching the existing
   * LLM env pattern — never bind a port without a valid cashier id.
   */
  CHATBOT_API_CASHIER_USER_ID: Joi.string().uuid().required(),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),

  // ─── LLM agent slice ────────────────────────────────────────────────────
  OPENAI_API_KEY: Joi.string().required(),
  LLM_MODEL: Joi.string().required(),
  LLM_MAX_STEPS: Joi.number().integer().min(1).default(3),
  LLM_HISTORY_TURNS: Joi.number().integer().min(1).default(12),
  LLM_MONTHLY_TOKEN_CEILING: Joi.number().integer().min(1).default(8_000_000),
  LLM_IDLE_TIMEOUT_MS: Joi.number().integer().min(1).default(10_800_000),

  // ─── Human-handoff slice (R7 + needs_human_review + R14) ─────────────────
  /**
   * Kill-switch for the human-handoff channel. When `false`,
   * `HumanHandoffService.create` short-circuits with a `disabled`
   * envelope before any write/send; the 12th tool
   * `requestHumanAssistance` returns the same disabled envelope.
   * Default: true.
   */
  HUMAN_HANDOFF_ENABLED: Joi.boolean().default(true),
  /**
   * WhatsApp senderId (wa_id) of the human agent who receives digests
   * and replies to them. Required when `HUMAN_HANDOFF_ENABLED=true`;
   * optional otherwise (enforced by the `.custom()` block below).
   * Joi accepts an optional leading `+` (E.164); the runtime normalizer
   * further strips the Mexican trunk-1 in dev-mode test numbers.
   */
  OPS_CHANNEL_PHONE: Joi.string()
    .pattern(/^\+?\d+$/)
    .optional(),

  // ─── Durable conversation store (Postgres) ──────────────────────────────
  DATABASE_URL: Joi.string().uri().required(),
  DB_POOL_MAX: Joi.number().integer().min(1).default(5),

  // ─── Receipt media slice (WU1C1 conditional foundation) ───────────
  // `RECEIPT_MEDIA_ENABLED` is the kill-switch (defaults to false).
  // All other receipt fields are conditionally permissive via
  // `receiptConditional`: when enabled, strict schemas validate;
  // when disabled or missing, the field is `Joi.any()`. The base
  // MUST stay `Joi.any()` so the when-branch fully replaces it.
  RECEIPT_MEDIA_ENABLED: Joi.boolean().default(false),
  RECEIPT_MEDIA_MAX_BYTES: receiptConditional(
    Joi.number().integer().valid(RECEIPT_MAX_BYTES_VALUE).required(),
  ),
  META_MEDIA_ALLOWED_HOSTS: receiptConditional(receiptMediaHostsSchema),
  RECEIPT_STORAGE_ENDPOINT: receiptConditional(httpsUrlSchema),
  RECEIPT_STORAGE_REGION: receiptConditional(Joi.string().required()),
  RECEIPT_STORAGE_BUCKET: receiptConditional(Joi.string().required()),
  RECEIPT_STORAGE_ACCESS_KEY_ID: receiptConditional(Joi.string().required()),
  RECEIPT_STORAGE_SECRET_ACCESS_KEY: receiptConditional(
    Joi.string().required(),
  ),
  RECEIPT_STORAGE_FORCE_PATH_STYLE: receiptConditional(Joi.boolean()),
  RECEIPT_MEDIA_PUBLIC_BASE_URL: receiptConditional(httpsUrlSchema),
  RECEIPT_MEDIA_METRICS_ENABLED: receiptConditional(Joi.boolean()),
  // WU1C2A numeric relations: same `receiptConditional` shape; all fields bounded by the 60s lease window, attach adds a 30s cap.
  META_MEDIA_METADATA_TIMEOUT_MS: receiptConditional(receiptLessThanLease),
  META_MEDIA_DOWNLOAD_TIMEOUT_MS: receiptConditional(receiptLessThanLease),
  RECEIPT_MEDIA_WORKER_CONCURRENCY: receiptConditional(
    receiptBoundedPositiveInt(RECEIPT_MAX_WORKER_CONCURRENCY),
  ),
  RECEIPT_MEDIA_WORKER_LEASE_MS: receiptConditional(
    Joi.number().integer().valid(RECEIPT_LEASE_MS_VALUE).required(),
  ),
  RECEIPT_MEDIA_WORKER_POLL_MS: receiptConditional(receiptLessThanLease),
  CHATBOT_API_ATTACH_TIMEOUT_MS: receiptConditional(
    Joi.number()
      .integer()
      .min(1)
      .max(RECEIPT_MAX_ATTACH_TIMEOUT_MS)
      .less(RECEIPT_LEASE_MS_VALUE)
      .required(),
  ),
})
  .custom((value: Record<string, unknown>, helpers) => {
    const enabled = value.HUMAN_HANDOFF_ENABLED !== false;
    const ops = value.OPS_CHANNEL_PHONE;
    if (enabled && (typeof ops !== 'string' || ops.length === 0)) {
      // Joi's `helpers.error` doesn't apply the supplied `message`
      // context directly to the error message; we throw with the
      // explicit message appended so the boot log carries the
      // actionable text.
      const err = helpers.error('any.custom');
      err.message = `"OPS_CHANNEL_PHONE" is required when "HUMAN_HANDOFF_ENABLED" is true`;
      throw err;
    }
    // WU1C2A cross-field rule: download timeout must be at least as large as metadata timeout; only enforced when receipt-media is enabled.
    if (value.RECEIPT_MEDIA_ENABLED === true) {
      const meta = Number(value.META_MEDIA_METADATA_TIMEOUT_MS);
      const dl = Number(value.META_MEDIA_DOWNLOAD_TIMEOUT_MS);
      if (Number.isFinite(meta) && Number.isFinite(dl) && dl < meta) {
        const err = helpers.error('any.custom');
        err.message = `"META_MEDIA_DOWNLOAD_TIMEOUT_MS" must be >= "META_MEDIA_METADATA_TIMEOUT_MS"`;
        throw err;
      }
    }
    return value;
  })
  .options({ allowUnknown: true });
