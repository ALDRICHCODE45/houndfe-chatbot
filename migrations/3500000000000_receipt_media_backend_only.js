/**
 * Receipt payment flow R3: the backend owns receipt storage (S2) and receipt
 * ingestion is always on (S7). The chatbot-owned storage, capability URLs,
 * cleanup backlog and amount dialog are gone, so this migration removes their
 * schema:
 *   - drops `receipt_media_cancellation_commands` (amount dialog),
 *   - drops the object/capability/cleanup/amount/attach-request columns,
 *   - narrows the statuses to RESERVED → DOWNLOADED → ATTACHED | FAILED |
 *     ATTACH_OUTCOME_UNKNOWN (no STORED, AWAITING_*, ATTACHING, CANCELLED),
 *   - narrows the failure stages and the outbox template keys,
 *   - rebuilds the lifecycle checks and indexes over the remaining columns.
 * Rows in removed states are deleted first.
 *
 * Irreversible on purpose: there is no real data (always-on-features S4).
 */

const STATUSES = [
  'RESERVED',
  'DOWNLOADED',
  'ATTACHED',
  'FAILED',
  'ATTACH_OUTCOME_UNKNOWN',
];
const FAILURE_STAGES = [
  'MEDIA_VALIDATION_PRE_STORAGE',
  'META_EXHAUSTED_PRE_STORAGE',
  'ATTACH_DEFINITE',
  'NOT_A_RECEIPT',
  'PDF_ENCRYPTED',
];
const TEMPLATE_KEYS = [
  'RECEIPT_ATTACHED_PENDING',
  'RECEIPT_ATTACH_DEFINITE_FAILURE',
  'RECEIPT_ATTACH_UNKNOWN',
  'RECEIPT_UNAVAILABLE_LATER',
  'RECEIPT_UNSUPPORTED_FORMAT',
  'RECEIPT_SALE_ALREADY_PAID',
  'RECEIPT_SALE_NOT_PAYABLE',
  'RECEIPT_PDF_ENCRYPTED',
  'RECEIPT_NOT_A_RECEIPT',
  'RECEIPT_PAYMENT_CONFIRMED',
  'RECEIPT_PAYMENT_PARTIAL',
  'RECEIPT_PAYMENT_REJECTED',
];
const DROPPED_COLUMNS = [
  'object_key',
  'stored_at',
  'amount_proposed_at',
  'object_etag',
  'object_version_id',
  'capability_token_hash',
  'capability_key_version',
  'capability_key_version_text',
  'capability_issued_at',
  'capability_revoked_at',
  'cleanup_pending',
  'cleanup_attempts',
  'attach_attempt_id',
  'attach_request_started_at',
  'attach_attempts',
];
/** Checks that reference removed states or columns. */
const DROPPED_CHECKS = [
  'receipt_media_status_check',
  'receipt_media_failure_stage_check',
  'receipt_media_download_evidence',
  'receipt_media_amount_evidence',
  'receipt_media_request_start_evidence',
  'receipt_media_definite_attach_failure',
  'receipt_media_cleanup_stage',
];
const DEFINITE_STATUSES = '400, 401, 403, 404, 409, 413, 415, 422, 429';

const oneOf = (col, values) =>
  `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;
const implies = (a, b) => `(NOT (${a}) OR (${b}))`;
const DOWNLOAD_COLS = [
  'downloaded_at',
  'response_mime_type',
  'detected_mime_type',
  'byte_count',
  'content_sha256',
];
const DEFINITE =
  "status = 'FAILED' AND failure_stage IS NOT DISTINCT FROM 'ATTACH_DEFINITE'";
const HAS_DOWNLOAD = `(${oneOf('status', ['DOWNLOADED', 'ATTACHED', 'ATTACH_OUTCOME_UNKNOWN'])} OR (${DEFINITE}))`;
const ATTACH_TERMINAL = `(${oneOf('status', ['ATTACHED', 'ATTACH_OUTCOME_UNKNOWN'])} OR (${DEFINITE}))`;

const CHECKS = [
  ['receipt_media_status_check', oneOf('status', STATUSES)],
  [
    'receipt_media_failure_stage_check',
    `failure_stage IS NULL OR ${oneOf('failure_stage', FAILURE_STAGES)}`,
  ],
  [
    'receipt_media_download_evidence',
    `${implies(HAS_DOWNLOAD, DOWNLOAD_COLS.map((c) => `${c} IS NOT NULL`).join(' AND '))} AND ${implies(`NOT ${HAS_DOWNLOAD}`, DOWNLOAD_COLS.map((c) => `${c} IS NULL`).join(' AND '))}`,
  ],
  [
    'receipt_media_attach_evidence',
    `(${ATTACH_TERMINAL}) = (attach_started_at IS NOT NULL)`,
  ],
  [
    'receipt_media_definite_attach_failure',
    `${implies(DEFINITE, `backend_receipt_id IS NULL AND backend_receipt_status IS NULL AND attach_http_status IN (${DEFINITE_STATUSES}) AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL`)} AND ${implies("status = 'FAILED' AND failure_stage IS DISTINCT FROM 'ATTACH_DEFINITE'", 'backend_receipt_id IS NULL AND backend_receipt_status IS NULL AND attach_http_status IS NULL AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL')}`,
  ],
];

exports.up = (pgm) => {
  const t = 'receipt_media';
  pgm.dropTable('receipt_media_cancellation_commands');
  const removed = `status NOT IN (${STATUSES.map((s) => `'${s}'`).join(', ')}) OR failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'`;
  pgm.sql(
    `DELETE FROM receipt_media_outbox WHERE receipt_media_id IN (SELECT id FROM ${t} WHERE ${removed})`,
  );
  pgm.sql(`DELETE FROM ${t} WHERE ${removed}`);
  pgm.sql(
    `DELETE FROM receipt_media_outbox WHERE NOT (${oneOf('template_key', TEMPLATE_KEYS)})`,
  );
  for (const name of DROPPED_CHECKS)
    pgm.dropConstraint(t, name, { ifExists: true });
  pgm.dropIndex(t, [], { name: 'receipt_media_active_sender_idx' });
  pgm.dropIndex(t, [], { name: 'receipt_media_claim_idx', ifExists: true });
  pgm.dropColumns(t, DROPPED_COLUMNS);
  for (const [name, def] of CHECKS)
    pgm.addConstraint(t, name, `CHECK (${def})`);
  pgm.createIndex(t, 'sender_id', {
    name: 'receipt_media_active_sender_idx',
    unique: true,
    where: oneOf('status', ['RESERVED', 'DOWNLOADED']),
  });
  pgm.createIndex(t, ['next_attempt_at', 'created_at'], {
    name: 'receipt_media_claim_idx',
    where: oneOf('status', ['RESERVED', 'DOWNLOADED']),
  });
  pgm.dropConstraint(
    'receipt_media_outbox',
    'receipt_media_outbox_template_key_check',
  );
  pgm.addConstraint(
    'receipt_media_outbox',
    'receipt_media_outbox_template_key_check',
    `CHECK (${oneOf('template_key', TEMPLATE_KEYS)})`,
  );
};

exports.down = false;
