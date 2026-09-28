import * as Joi from 'joi';

export const META_GRAPH_API_BASE_URL_DEFAULT =
  'https://graph.facebook.com/v23.0';

// SQ-2A: Skydropx Pro API host. Domestic quotes need country + postal code +
// area_level1/2/3 for origin and destination, so a postal code alone is never
// sufficient; origin address fields are required only when quotes are enabled.
export const SKYDROPX_BASE_URL_DEFAULT = 'https://api-pro.skydropx.com';

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

// WU15-1: ASCII hex digit pattern for 64-character token validation.
const METRICS_TOKEN_HEX_RE = /^[0-9a-fA-F]{64}$/;

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
    // SAFETY: helpers.state.ancestors is typed as `any[]`; we narrow it to
    // a readable structure without affecting Joi validation behavior.
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

const receiptConditional = (then: Joi.Schema) =>
  Joi.any().when('RECEIPT_MEDIA_ENABLED', {
    is: true,
    then,
    otherwise: Joi.any(),
  });

// SQ-2A: same shape as `receiptConditional`; the base stays `Joi.any()` so the
// when-branch fully replaces it and every provider field is permissive when off.
const shippingConditional = (then: Joi.Schema) =>
  Joi.any().when('SHIPPING_QUOTES_ENABLED', {
    is: true,
    then,
    otherwise: Joi.any(),
  });

// SQ-2A-H: canonical, case-sensitive flag. Joi's boolean rule folds case
// (accepting 'TRUE'), which would disagree with the factory's exact `=== 'true'`
// posture; `sensitive(true)` pins the spelling and the original-value guard
// rejects surrounding whitespace. Output stays boolean with a false default.
const shippingFlagSchema = Joi.boolean()
  .sensitive(true)
  .truthy('true')
  .falsy('false')
  .custom((value: boolean, helpers) => {
    const original: unknown = helpers.original;
    if (typeof original === 'string' && original !== original.trim()) {
      return helpers.error('boolean.base');
    }
    return value;
  }, 'canonical boolean')
  .default(false);

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

  // ─── Experimental minimal SDK catalog route (default-off) ───────────────
  // The literal 'true' enables it; every other value stays off. The allowlist
  // is an optional exact wa_id CSV; an empty/invalid list enables nobody.
  MINIMAL_CATALOG_AGENT_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),
  MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS: Joi.string().optional(),

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
   * Must be the exact digit-only Meta sender id (same form delivered in an
   * inbound `wa_id`): 10-15 digits, no leading `+`, whitespace, or
   * separators. The value is retained verbatim; sender/ops comparison
   * honors `META_SANDBOX_RECIPIENT_NORMALIZATION`.
   */
  OPS_CHANNEL_PHONE: Joi.string()
    .pattern(/^\d{10,15}$/)
    .optional(),
  /**
   * Explicit Meta test-number recipient compatibility mode. Default: false.
   * When true, Mexico `521` + 10-digit recipients are rewritten to `52` + 10
   * digits and the ops sender/ops-phone comparison applies the same
   * conversion on both sides. The default keeps the exact inbound `wa_id`.
   */
  META_SANDBOX_RECIPIENT_NORMALIZATION: Joi.boolean().default(false),

  // ─── Human decisions: experimental RESTOCK gate (WU2A) ──────────────
  // Explicit opt-in only. The literal string `'true'` enables it and
  // `'false'` disables it; EVERY other value (a typo, upper-case, `1`) is
  // REJECTED, so an ambiguous value can never activate the gate. Default:
  // false. No consumer reads this yet.
  HUMAN_DECISIONS_RESTOCK_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),

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
  // R3-cleanup-rollout-gate: independent, default-false ingestion rollout
  // gate. It is NOT keyed on RECEIPT_MEDIA_ENABLED; notification and every
  // other receipt-media feature stay governed by RECEIPT_MEDIA_ENABLED alone.
  RECEIPT_MEDIA_INGESTION_ENABLED: Joi.boolean().default(false),
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
  // WU15-1: RECEIPT_MEDIA_METRICS_ENABLED is independently validated (not keyed on
  // RECEIPT_MEDIA_ENABLED); defaults false. When true, a dedicated Bearer-safe
  // opaque token is required: exactly 64 ASCII hex characters (32 random bytes).
  RECEIPT_MEDIA_METRICS_ENABLED: Joi.boolean().default(false),
  // WU15-1: Any supplied token is validated as exactly 64 ASCII hex.
  // .when only controls requiredness: required when enabled, optional when disabled.
  // Custom validation always rejects non-empty malformed values regardless of flag.
  RECEIPT_MEDIA_METRICS_TOKEN: Joi.string()
    .length(64)
    .pattern(/^[0-9a-fA-F]{64}$/)
    .custom((value: unknown, helpers) => {
      // Allow undefined/absent (optionality handled by .when) but reject
      // any supplied non-empty value that is not exactly 64 ASCII hex.
      if (typeof value === 'string' && value.length > 0) {
        if (value.length !== 64 || !METRICS_TOKEN_HEX_RE.test(value)) {
          return helpers.error('string.custom');
        }
      }
      return value;
    }, 'metrics token format')
    .when('RECEIPT_MEDIA_METRICS_ENABLED', {
      is: true,
      then: Joi.string().required().messages({
        'any.required':
          '"RECEIPT_MEDIA_METRICS_TOKEN" is required when "RECEIPT_MEDIA_METRICS_ENABLED" is true',
        'string.length':
          '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 characters',
        'string.pattern.base':
          '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 hexadecimal characters',
        'string.custom':
          '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 hexadecimal characters',
      }),
      otherwise: Joi.string().optional().messages({
        'string.length':
          '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 characters',
        'string.pattern.base':
          '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 hexadecimal characters',
        'string.custom':
          '"RECEIPT_MEDIA_METRICS_TOKEN" must be exactly 64 hexadecimal characters',
      }),
    }),
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

  // ─── Shipping quotes slice (SQ-2A default-off foundation) ────────────────
  // Kill-switch defaults to false; when enabled the strict Skydropx
  // requirements validate. Credentials stay plain non-empty strings so no
  // pattern can echo a secret into a validation message.
  SHIPPING_QUOTES_ENABLED: shippingFlagSchema,
  SKYDROPX_BASE_URL: shippingConditional(
    Joi.string()
      .trim(true)
      .uri({ scheme: ['https'] })
      .default(SKYDROPX_BASE_URL_DEFAULT),
  ),
  SKYDROPX_CLIENT_ID: shippingConditional(Joi.string().trim(true).required()),
  SKYDROPX_CLIENT_SECRET: shippingConditional(
    Joi.string().trim(true).required(),
  ),
  SKYDROPX_ORIGIN_POSTAL_CODE: shippingConditional(
    Joi.string()
      .trim(true)
      .length(5)
      .pattern(/^[0-9]{5}$/)
      .required(),
  ),
  SKYDROPX_ORIGIN_STATE: shippingConditional(
    Joi.string().trim(true).max(100).required(),
  ),
  SKYDROPX_ORIGIN_MUNICIPALITY: shippingConditional(
    Joi.string().trim(true).max(100).required(),
  ),
  SKYDROPX_ORIGIN_NEIGHBORHOOD: shippingConditional(
    Joi.string().trim(true).max(100).required(),
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
