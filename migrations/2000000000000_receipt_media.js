/**
 * node-pg-migrate up/down for the durable receipt-media store (WU2A1 core).
 *
 * Creates `receipt_media` (durable job/state table per ADR-2) and
 * `receipt_media_outbox` (committed deterministic notification intents).
 * This slice owns only field-local checks (enums, ranges, byte lengths,
 * nullability), foreign keys, and basic uniques; cross-field lifecycle/
 * evidence/lease predicates, partial indexes, and non-empty down refusal
 * are deferred to WU2A2. No caption, URL, filename, raw token, or error
 * body is ever persisted.
 */

const RECEIPT_STATUSES = [
  'RESERVED',
  'DOWNLOADED',
  'STORED',
  'AWAITING_AMOUNT',
  'AWAITING_CONFIRMATION',
  'ATTACHING',
  'ATTACHED',
  'FAILED',
  'CANCELLED',
  'ATTACH_OUTCOME_UNKNOWN',
];
const FAILURE_STAGES = [
  'MEDIA_VALIDATION_PRE_STORAGE',
  'META_EXHAUSTED_PRE_STORAGE',
  'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
  'ATTACH_DEFINITE',
];
const RECONCILIATION_DISPOSITIONS = [
  'BACKEND_CONFIRMED',
  'BACKEND_NOT_FOUND',
  'UNRESOLVED',
];
const OUTBOX_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED'];
const TEMPLATE_KEYS = [
  'RECEIPT_AMOUNT_PROMPT',
  'RECEIPT_AMOUNT_CONFIRM',
  'RECEIPT_AMOUNT_REASK',
  'RECEIPT_CANCELLED',
  'RECEIPT_ATTACHED_PENDING',
  'RECEIPT_ATTACH_DEFINITE_FAILURE',
  'RECEIPT_ATTACH_UNKNOWN',
  'RECEIPT_UNAVAILABLE_LATER',
  'RECEIPT_IN_PROGRESS',
  'RECEIPT_FINISH_OR_CANCEL',
  'RECEIPT_PLACE_SALE_FIRST',
  'RECEIPT_UNSUPPORTED_FORMAT',
  'RECEIPT_RECEIPTS_ONLY',
];
const MAX_BYTES = 10485760;
const MIMES = ['image/jpeg', 'image/png'];

const oneOf = (col, values) =>
  `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;
const nullableOneOf = (col, values) =>
  `(${col} IS NULL OR ${oneOf(col, values)})`;
const boundedBytes = (col) =>
  `(${col} IS NULL OR (${col} >= 1 AND ${col} <= ${MAX_BYTES}))`;
const sha256 = (col) => `(${col} IS NULL OR octet_length(${col}) = 32)`;
const positiveWhenSet = (col) => `(${col} IS NULL OR ${col} > 0)`;

const STATUS_CHECK = oneOf('status', RECEIPT_STATUSES);
const mimeCheck = (col) => nullableOneOf(col, MIMES);
const FAILURE_STAGE_CHECK = nullableOneOf('failure_stage', FAILURE_STAGES);
const RECON_CHECK = nullableOneOf(
  'reconciliation_disposition',
  RECONCILIATION_DISPOSITIONS,
);
const OUTBOX_STATUS_CHECK = oneOf('status', OUTBOX_STATUSES);
const TEMPLATE_KEY_CHECK = oneOf('template_key', TEMPLATE_KEYS);
const ATTEMPTS_0_3_CHECK = 'attempts BETWEEN 0 AND 3';

const NOW = (pgm) => pgm.func('now()');

exports.up = (pgm) => {
  pgm.createTable('receipt_media', {
    id: { type: 'uuid', primaryKey: true },
    webhook_message_id: { type: 'text', notNull: true, unique: true },
    provider_media_id: { type: 'text', notNull: true, unique: true },
    sender_id: { type: 'text', notNull: true },
    captured_sale_id: { type: 'uuid', notNull: true },
    object_key: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true, check: STATUS_CHECK },
    version: { type: 'bigint', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    updated_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    reserved_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    downloaded_at: { type: 'timestamptz' },
    stored_at: { type: 'timestamptz' },
    amount_proposed_at: { type: 'timestamptz' },
    attach_started_at: { type: 'timestamptz' },
    attach_request_started_at: { type: 'timestamptz' },
    attached_at: { type: 'timestamptz' },
    terminal_at: { type: 'timestamptz' },
    declared_mime_type: {
      type: 'text',
      check: mimeCheck('declared_mime_type'),
    },
    response_mime_type: {
      type: 'text',
      check: mimeCheck('response_mime_type'),
    },
    detected_mime_type: {
      type: 'text',
      check: mimeCheck('detected_mime_type'),
    },
    provider_declared_bytes: {
      type: 'integer',
      check: boundedBytes('provider_declared_bytes'),
    },
    byte_count: { type: 'integer', check: boundedBytes('byte_count') },
    content_sha256: { type: 'bytea', check: sha256('content_sha256') },
    object_etag: { type: 'text' },
    object_version_id: { type: 'text' },
    capability_token_hash: {
      type: 'bytea',
      check: sha256('capability_token_hash'),
    },
    capability_key_version: {
      type: 'integer',
      check: positiveWhenSet('capability_key_version'),
    },
    capability_issued_at: { type: 'timestamptz' },
    capability_revoked_at: { type: 'timestamptz' },
    declared_amount_cents: {
      type: 'integer',
      check: positiveWhenSet('declared_amount_cents'),
    },
    backend_receipt_id: { type: 'uuid' },
    backend_receipt_status: {
      type: 'text',
      check: nullableOneOf('backend_receipt_status', ['PENDING']),
    },
    attach_attempt_id: { type: 'uuid' },
    attach_attempts: {
      type: 'smallint',
      notNull: true,
      default: 0,
      check: 'attach_attempts BETWEEN 0 AND 1',
    },
    meta_attempts: {
      type: 'smallint',
      notNull: true,
      default: 0,
      check: 'meta_attempts BETWEEN 0 AND 3',
    },
    storage_attempts: {
      type: 'smallint',
      notNull: true,
      default: 0,
      check: 'storage_attempts BETWEEN 0 AND 3',
    },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    lease_owner: { type: 'text' },
    lease_expires_at: { type: 'timestamptz' },
    failure_stage: { type: 'text', check: FAILURE_STAGE_CHECK },
    last_error_category: { type: 'text' },
    last_error_code: { type: 'text' },
    attach_http_status: { type: 'integer' },
    attach_transport_code: { type: 'text' },
    attach_outcome_observed_at: { type: 'timestamptz' },
    cleanup_pending: { type: 'boolean', notNull: true, default: false },
    cleanup_attempts: {
      type: 'integer',
      notNull: true,
      default: 0,
      check: 'cleanup_attempts >= 0',
    },
    reconciliation_disposition: { type: 'text', check: RECON_CHECK },
    reconciled_backend_receipt_id: { type: 'uuid' },
    reconciled_at: { type: 'timestamptz' },
    reconciled_by: { type: 'text' },
  });

  pgm.createTable('receipt_media_outbox', {
    id: { type: 'uuid', primaryKey: true },
    dedupe_key: { type: 'text', notNull: true, unique: true },
    receipt_media_id: { type: 'uuid', references: 'receipt_media(id)' },
    receipt_state_version: { type: 'bigint' },
    source_webhook_message_id: { type: 'text', notNull: true },
    recipient_id: { type: 'text', notNull: true },
    template_key: { type: 'text', notNull: true, check: TEMPLATE_KEY_CHECK },
    template_args: { type: 'jsonb', notNull: true, default: '{}' },
    status: {
      type: 'text',
      notNull: true,
      default: 'PENDING',
      check: OUTBOX_STATUS_CHECK,
    },
    attempts: {
      type: 'smallint',
      notNull: true,
      default: 0,
      check: ATTEMPTS_0_3_CHECK,
    },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    lease_owner: { type: 'text' },
    lease_expires_at: { type: 'timestamptz' },
    provider_message_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    updated_at: { type: 'timestamptz', notNull: true, default: NOW(pgm) },
    sent_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('receipt_media_outbox');
  pgm.dropTable('receipt_media');
};
