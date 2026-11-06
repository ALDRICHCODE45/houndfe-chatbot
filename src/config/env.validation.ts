import * as Joi from 'joi';

export const META_GRAPH_API_BASE_URL_DEFAULT =
  'https://graph.facebook.com/v23.0';

// ─── Receipt-media helpers ─────────────────────────────────────────────────
// Receipt ingestion is always on (receipt payment flow R3/S7): the backend
// stores the file, so only the Meta download and worker knobs remain, each
// with a working default.
const RECEIPT_MAX_BYTES_VALUE = 10_485_760;
// WU1C2A numeric relations: lease is the 60-second safety window every external operation must stay strictly inside.
const RECEIPT_LEASE_MS_VALUE = 60_000;
const RECEIPT_MAX_WORKER_CONCURRENCY = 8;
/** Meta serves WhatsApp media downloads from this host. */
export const META_MEDIA_ALLOWED_HOSTS_DEFAULT = 'lookaside.fbsbx.com';

// Strictly-less-than-lease schema for timeouts/poll where the lease boundary itself is forbidden.
const receiptLessThanLease = (fallback: number) =>
  Joi.number().integer().min(1).less(RECEIPT_LEASE_MS_VALUE).default(fallback);

// WU15-1: ASCII hex digit pattern for 64-character token validation.
const METRICS_TOKEN_HEX_RE = /^[0-9a-fA-F]{64}$/;

const receiptMediaHostsSchema = Joi.string()
  .default(META_MEDIA_ALLOWED_HOSTS_DEFAULT)
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

// WU1C2B2: scrub the failing field value from every place Joi may retain it.
// Joi's built-in rules (`string.uri`, `string.pattern.base`, `string.empty`,
// `any.required`, etc.) thread the original value into `details[*].context`,
// and Joi itself keeps the full input under `error._original`. Both are
// observable through `error.message`, `JSON.stringify(error.details)`, and
// `String(error)`. Custom rules that re-throw with `helpers.error('any.custom')`
// inherit the same retention surface. The redactor walks the validation error
// in place so the schema can stay Joi-native while still guaranteeing that no
// storage credential, keyring material, or other secret value ever leaves the
// wrapper — the field `path` and `type` are kept for diagnostics.
const stripContextValueRecursive = (node: unknown): void => {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if ('value' in record) {
    delete record.value;
  }
  if ('error' in record) {
    delete record.error;
  }
  for (const key of Object.keys(record)) {
    stripContextValueRecursive(record[key]);
  }
};
const redactValidationError = (error: Joi.ValidationError): void => {
  // Joi retains the entire original input here; drop it so the secret-bearing
  // originals never appear in logs or JSON serialization.
  delete (error as { _original?: unknown })._original;
  for (const detail of error.details) {
    stripContextValueRecursive(detail.context);
  }
  // Rebuild the top-level message from redacted detail messages so any cached
  // value interpolation (e.g., `string.pattern.base` includes the value text
  // in the rendered message) is removed.
  error.message = error.details.map((d) => d.message).join('. ');
};

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
 *   OPS_CHANNEL_PHONE      — human-handoff ops recipient (always on).
 *                             Exact digit-only Meta sender id (wa_id), same
 *                             form Meta delivers in an inbound `wa_id`,
 *                             10-15 digits. `+`/separators/whitespace are
 *                             rejected at boot: the runtime compares it
 *                             verbatim, so a `+` would silently drop replies.
 */
const innerEnvValidationSchema = Joi.object({
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
  LLM_MAX_STEPS: Joi.number().integer().min(1).default(4),
  LLM_HISTORY_TURNS: Joi.number().integer().min(1).default(12),
  LLM_MONTHLY_TOKEN_CEILING: Joi.number().integer().min(1).default(8_000_000),
  LLM_IDLE_TIMEOUT_MS: Joi.number().integer().min(1).default(10_800_000),

  // ─── Human-handoff slice (R7 + needs_human_review + R14) ─────────────────
  /**
   * WhatsApp senderId (wa_id) of the human agent who receives digests
   * and replies to them. Always required: human handoff and human
   * decisions are always on.
   * Must be the exact digit-only Meta sender id (same form delivered in an
   * inbound `wa_id`): 10-15 digits, no leading `+`, whitespace, or
   * separators. The value is retained verbatim; sender/ops comparison
   * honors `META_SANDBOX_RECIPIENT_NORMALIZATION`.
   */
  OPS_CHANNEL_PHONE: Joi.string()
    .pattern(/^\d{10,15}$/)
    .required(),
  /**
   * Explicit Meta test-number recipient compatibility mode. Default: false.
   * When true, Mexico `521` + 10-digit recipients are rewritten to `52` + 10
   * digits and the ops sender/ops-phone comparison applies the same
   * conversion on both sides. The default keeps the exact inbound `wa_id`.
   */
  META_SANDBOX_RECIPIENT_NORMALIZATION: Joi.boolean().default(false),

  // ─── Durable conversation store (Postgres) ──────────────────────────────
  DATABASE_URL: Joi.string().uri().required(),
  DB_POOL_MAX: Joi.number().integer().min(1).default(5),

  // ─── Receipt media (always on, receipt payment flow R3/S7) ──────────
  // The backend stores receipt files; the chatbot only downloads the
  // WhatsApp media and runs its workers. Every knob has a working default.
  RECEIPT_MEDIA_MAX_BYTES: Joi.number()
    .integer()
    .valid(RECEIPT_MAX_BYTES_VALUE)
    .default(RECEIPT_MAX_BYTES_VALUE),
  META_MEDIA_ALLOWED_HOSTS: receiptMediaHostsSchema,
  // WU15-1: optional dedicated Bearer-safe metrics token. The metrics
  // endpoint is served exactly when it is configured; any supplied value
  // must be exactly 64 ASCII hex characters (32 random bytes).
  RECEIPT_MEDIA_METRICS_TOKEN: Joi.string()
    .length(64)
    .pattern(/^[0-9a-fA-F]{64}$/)
    .custom((value: unknown, helpers) => {
      // Allow undefined/absent but reject any supplied non-empty value that
      // is not exactly 64 ASCII hex.
      if (typeof value === 'string' && value.length > 0) {
        if (value.length !== 64 || !METRICS_TOKEN_HEX_RE.test(value)) {
          return helpers.error('string.custom');
        }
      }
      return value;
    }, 'metrics token format')
    .optional()
    .messages({
      'string.length':
        '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 characters',
      'string.pattern.base':
        '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 hexadecimal characters',
      'string.custom':
        '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 hexadecimal characters',
    }),
  // WU1C2A numeric relations: every external operation stays inside the 60 s lease.
  META_MEDIA_METADATA_TIMEOUT_MS: receiptLessThanLease(10_000),
  META_MEDIA_DOWNLOAD_TIMEOUT_MS: receiptLessThanLease(30_000),
  RECEIPT_MEDIA_WORKER_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(RECEIPT_MAX_WORKER_CONCURRENCY)
    .default(2),
  RECEIPT_MEDIA_WORKER_LEASE_MS: Joi.number()
    .integer()
    .valid(RECEIPT_LEASE_MS_VALUE)
    .default(RECEIPT_LEASE_MS_VALUE),
  RECEIPT_MEDIA_WORKER_POLL_MS: receiptLessThanLease(5_000),
})
  .custom((value: Record<string, unknown>, helpers) => {
    // WU1C2A cross-field rule: download timeout must be at least as large as metadata timeout.
    const meta = Number(value.META_MEDIA_METADATA_TIMEOUT_MS);
    const dl = Number(value.META_MEDIA_DOWNLOAD_TIMEOUT_MS);
    if (Number.isFinite(meta) && Number.isFinite(dl) && dl < meta) {
      const err = helpers.error('any.custom');
      err.message = `"META_MEDIA_DOWNLOAD_TIMEOUT_MS" must be >= "META_MEDIA_METADATA_TIMEOUT_MS"`;
      throw err;
    }
    return value;
  })
  .options({ allowUnknown: true });

export type EnvValidationResult = Joi.ValidationResult;

export const envValidationSchema = {
  validate(env: unknown, options?: Joi.ValidationOptions): EnvValidationResult {
    const result = innerEnvValidationSchema.validate(env, options);
    if (result.error) {
      redactValidationError(result.error);
    }
    return result;
  },
};
