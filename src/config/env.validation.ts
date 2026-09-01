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

// WU1C2B1: strict canonical base64 (RFC 4648 §4), unique positive versions, >=32-byte keys, active must be a member.
const RECEIPT_KEYRING_VERSION_RE = /^[1-9]\d*$/;
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const isStrictBase64Key = (raw: string): boolean => {
  if (raw.length === 0 || raw.length % 4 !== 0 || !STRICT_BASE64_RE.test(raw)) {
    return false;
  }
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length >= 32 && decoded.toString('base64') === raw;
};
const parseReceiptCapabilityKeyring = (raw: string): Set<string> | null => {
  const versions = new Set<string>();
  for (const entry of raw.split(',')) {
    const colon = entry.indexOf(':');
    if (colon < 1) return null;
    const versionToken = entry.slice(0, colon);
    if (
      !RECEIPT_KEYRING_VERSION_RE.test(versionToken) ||
      !isStrictBase64Key(entry.slice(colon + 1))
    ) {
      return null;
    }
    if (versions.has(versionToken)) return null;
    versions.add(versionToken);
  }
  return versions;
};
const receiptCapabilityKeysSchema = Joi.string()
  .required()
  .custom((value: unknown, helpers) => {
    const versions =
      typeof value === 'string' ? parseReceiptCapabilityKeyring(value) : null;
    if (versions === null) {
      const err = helpers.error('any.custom');
      err.message =
        '"RECEIPT_CAPABILITY_KEYS" must be comma-separated version:base64 entries (unique positive versions, canonical base64 keys >=32 bytes)';
      throw err;
    }
    return value;
  }, 'receipt capability keys');
const receiptCapabilityActiveVersionSchema = Joi.string()
  .required()
  .custom((value: unknown, helpers) => {
    const fail = (msg: string): never => {
      throw Object.assign(helpers.error('any.custom'), { message: msg });
    };
    if (typeof value !== 'string' || !RECEIPT_KEYRING_VERSION_RE.test(value)) {
      fail(`"RECEIPT_CAPABILITY_ACTIVE_VERSION" must be a positive integer`);
    }
    const ancestors = helpers.state.ancestors as unknown as
      | Array<Record<string, unknown>>
      | undefined;
    const parent = ancestors?.[0];
    const keys = parent?.RECEIPT_CAPABILITY_KEYS;
    if (typeof keys === 'string') {
      const versions = parseReceiptCapabilityKeyring(keys);
      if (versions !== null && !versions.has(value as string)) {
        fail(
          `"RECEIPT_CAPABILITY_ACTIVE_VERSION" must be present in "RECEIPT_CAPABILITY_KEYS"`,
        );
      }
    }
    return value;
  }, 'receipt capability active version');

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
  // WU1C2B1 capability keyring + active version membership.
  RECEIPT_CAPABILITY_KEYS: receiptConditional(receiptCapabilityKeysSchema),
  RECEIPT_CAPABILITY_ACTIVE_VERSION: receiptConditional(
    receiptCapabilityActiveVersionSchema,
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
