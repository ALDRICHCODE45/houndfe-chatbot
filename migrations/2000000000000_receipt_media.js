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

// WU2A2A cross-field predicates: exact set membership, no ordering.
const implies = (a, b) => `(NOT (${a}) OR (${b}))`;
const DEFINITE =
  "status = 'FAILED' AND failure_stage IS NOT DISTINCT FROM 'ATTACH_DEFINITE'";
const words = (text) => text.split(' ');
const oneOfStatus = (values) => oneOf('status', values);
const allSet = (cols) => cols.map((c) => `${c} IS NOT NULL`).join(' AND ');
const allClear = (cols) => cols.map((c) => `${c} IS NULL`).join(' AND ');

const OBJECT_COLS = words(
  'stored_at object_etag capability_token_hash capability_key_version capability_issued_at',
);
const DOWNLOAD_COLS = words(
  'downloaded_at response_mime_type detected_mime_type byte_count content_sha256',
);
const ATTACH_COLS = words(
  'attach_started_at attach_attempt_id attach_request_started_at',
);
const DOWNSTREAM = words(
  'STORED AWAITING_AMOUNT AWAITING_CONFIRMATION ATTACHING ATTACHED CANCELLED ATTACH_OUTCOME_UNKNOWN',
);

const ACCEPTED_OBJECT = `(${oneOfStatus(DOWNSTREAM)} OR (${DEFINITE}))`;
const HAS_DOWNLOAD = `(${oneOfStatus(['DOWNLOADED', ...DOWNSTREAM])} OR COALESCE(failure_stage IN ('STORAGE_EXHAUSTED_PRE_ACCEPTANCE', 'ATTACH_DEFINITE'), false))`;
const NEEDS_AMOUNT = `(${oneOfStatus(words('AWAITING_CONFIRMATION ATTACHING ATTACHED ATTACH_OUTCOME_UNKNOWN'))} OR (${DEFINITE}))`;
const ATTACH_TERMINAL = `(${oneOfStatus(words('ATTACHED ATTACH_OUTCOME_UNKNOWN'))} OR (${DEFINITE}))`;
const PRE_ATTACH = `(NOT (${ATTACH_TERMINAL}) AND status <> 'ATTACHING')`;

const CHECKS = [
  [
    'receipt_media_accepted_object_evidence',
    `${implies(ACCEPTED_OBJECT, allSet(OBJECT_COLS))} AND ${implies(
      `NOT ${ACCEPTED_OBJECT}`,
      allClear(OBJECT_COLS),
    )}`,
  ],
  [
    'receipt_media_download_evidence',
    `${implies(HAS_DOWNLOAD, allSet(DOWNLOAD_COLS))} AND ${implies(
      `NOT ${HAS_DOWNLOAD}`,
      allClear(DOWNLOAD_COLS),
    )}`,
  ],
  [
    'receipt_media_amount_evidence',
    `${implies(NEEDS_AMOUNT, 'declared_amount_cents IS NOT NULL')} AND ${implies(
      "status = 'AWAITING_AMOUNT'",
      'declared_amount_cents IS NULL',
    )}`,
  ],
  [
    'receipt_media_request_start_evidence',
    `${implies("status = 'ATTACHING'", `attach_started_at IS NOT NULL AND ((attach_attempts = 0 AND ${allClear(ATTACH_COLS.slice(1))}) OR (attach_attempts = 1 AND ${allSet(ATTACH_COLS.slice(1))}))`)} AND ${implies(ATTACH_TERMINAL, `attach_attempts = 1 AND ${allSet(ATTACH_COLS)}`)} AND ${implies(PRE_ATTACH, `attach_attempts = 0 AND ${allClear(ATTACH_COLS)}`)}`,
  ],
  [
    'receipt_media_attached_success',
    `${implies(
      "status = 'ATTACHED'",
      "backend_receipt_id IS NOT NULL AND backend_receipt_status = 'PENDING' AND attached_at IS NOT NULL AND last_error_category IS NULL AND last_error_code IS NULL AND attach_http_status IS NULL AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL",
    )} AND ${implies(
      "status <> 'ATTACHED'",
      'backend_receipt_status IS NULL AND attached_at IS NULL',
    )}`,
  ],
  [
    'receipt_media_definite_attach_failure',
    `${implies(DEFINITE, 'backend_receipt_id IS NULL AND backend_receipt_status IS NULL AND cleanup_pending = false AND attach_http_status IN (400, 401, 403, 404, 409, 422, 429) AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL')} AND ${implies("status = 'FAILED' AND failure_stage IS DISTINCT FROM 'ATTACH_DEFINITE'", 'backend_receipt_id IS NULL AND backend_receipt_status IS NULL AND attach_http_status IS NULL AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL')}`,
  ],
  [
    'receipt_media_unknown_attach_outcome',
    implies(
      "status = 'ATTACH_OUTCOME_UNKNOWN'",
      'attach_outcome_observed_at IS NOT NULL AND backend_receipt_id IS NULL AND ((attach_http_status IS NOT NULL AND (attach_http_status < 200 OR attach_http_status > 299) AND attach_http_status NOT IN (400, 401, 403, 404, 409, 422, 429)) OR attach_transport_code IS NOT NULL)',
    ),
  ],
  [
    'receipt_media_cleanup_stage',
    "cleanup_pending = false OR (status = 'FAILED' AND failure_stage IN ('MEDIA_VALIDATION_PRE_STORAGE', 'META_EXHAUSTED_PRE_STORAGE', 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'))",
  ],
  [
    'receipt_media_failure_stage_iff_failed',
    "(status = 'FAILED') = (failure_stage IS NOT NULL)",
  ],
  [
    'receipt_media_paired_lease',
    '(lease_owner IS NULL) = (lease_expires_at IS NULL)',
  ],
];

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

  for (const [name, def] of CHECKS)
    pgm.addConstraint('receipt_media', name, `CHECK (${def})`);
  pgm.addConstraint(
    'receipt_media_outbox',
    'receipt_media_outbox_paired_lease',
    'CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))',
  );
};

exports.down = (pgm) => {
  pgm.dropTable('receipt_media_outbox');
  pgm.dropTable('receipt_media');
};
