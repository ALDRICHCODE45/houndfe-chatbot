/**
 * Receipt payment flow R2: the backend stores receipt files (S2) and the
 * chatbot uploads them as multipart, keyed by the WhatsApp media id.
 *
 * A receipt now goes RESERVED → DOWNLOADED → ATTACHED | FAILED |
 * ATTACH_OUTCOME_UNKNOWN with no chatbot-owned object, capability or amount
 * dialog, so this migration:
 *   - drops the accepted-object composite (no S3 object / capability exists),
 *   - narrows the amount evidence to the legacy dialog states (the declared
 *     amount is optional for an upload),
 *   - admits application/pdf receipts (S8),
 *   - adds the 413/415 definite upload statuses,
 *   - adds the NOT_A_RECEIPT and PDF_ENCRYPTED terminal stages,
 *   - allows up to 6 backend upload attempts (storage_attempts),
 *   - adds the new customer notification templates.
 * The chatbot-owned storage columns and states are removed by R3.
 *
 * Irreversible on purpose: there is no real data (always-on-features S4).
 */

const DEFINITE_STATUSES = '400, 401, 403, 404, 409, 413, 415, 422, 429';
const DEFINITE =
  "status = 'FAILED' AND failure_stage IS NOT DISTINCT FROM 'ATTACH_DEFINITE'";
const implies = (a, b) => `(NOT (${a}) OR (${b}))`;
const oneOf = (col, values) =>
  `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;
const nullableOneOf = (col, values) =>
  `(${col} IS NULL OR ${oneOf(col, values)})`;

const MIMES = ['image/jpeg', 'image/png', 'application/pdf'];
const FAILURE_STAGES = [
  'MEDIA_VALIDATION_PRE_STORAGE',
  'META_EXHAUSTED_PRE_STORAGE',
  'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
  'ATTACH_DEFINITE',
  'NOT_A_RECEIPT',
  'PDF_ENCRYPTED',
];
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
  'RECEIPT_SALE_ALREADY_PAID',
  'RECEIPT_SALE_NOT_PAYABLE',
  'RECEIPT_PDF_ENCRYPTED',
  'RECEIPT_NOT_A_RECEIPT',
];

const replace = (pgm, table, name, expression) => {
  pgm.dropConstraint(table, name);
  pgm.addConstraint(table, name, `CHECK (${expression})`);
};

exports.up = (pgm) => {
  const t = 'receipt_media';
  pgm.dropConstraint(t, 'receipt_media_accepted_object_evidence');
  replace(
    pgm,
    t,
    'receipt_media_amount_evidence',
    `${implies(
      "status IN ('AWAITING_CONFIRMATION', 'ATTACHING')",
      'declared_amount_cents IS NOT NULL',
    )} AND ${implies("status = 'AWAITING_AMOUNT'", 'declared_amount_cents IS NULL')}`,
  );
  replace(
    pgm,
    t,
    'receipt_media_definite_attach_failure',
    `${implies(DEFINITE, `backend_receipt_id IS NULL AND backend_receipt_status IS NULL AND cleanup_pending = false AND attach_http_status IN (${DEFINITE_STATUSES}) AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL`)} AND ${implies("status = 'FAILED' AND failure_stage IS DISTINCT FROM 'ATTACH_DEFINITE'", 'backend_receipt_id IS NULL AND backend_receipt_status IS NULL AND attach_http_status IS NULL AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL')}`,
  );
  replace(
    pgm,
    t,
    'receipt_media_unknown_attach_outcome',
    implies(
      "status = 'ATTACH_OUTCOME_UNKNOWN'",
      `attach_outcome_observed_at IS NOT NULL AND backend_receipt_id IS NULL AND ((attach_http_status IS NOT NULL AND (attach_http_status < 200 OR attach_http_status > 299) AND attach_http_status NOT IN (${DEFINITE_STATUSES})) OR attach_transport_code IS NOT NULL)`,
    ),
  );
  for (const col of [
    'declared_mime_type',
    'response_mime_type',
    'detected_mime_type',
  ])
    replace(pgm, t, `receipt_media_${col}_check`, nullableOneOf(col, MIMES));
  replace(
    pgm,
    t,
    'receipt_media_failure_stage_check',
    nullableOneOf('failure_stage', FAILURE_STAGES),
  );
  replace(
    pgm,
    t,
    'receipt_media_storage_attempts_check',
    'storage_attempts BETWEEN 0 AND 6',
  );
  replace(
    pgm,
    'receipt_media_outbox',
    'receipt_media_outbox_template_key_check',
    oneOf('template_key', TEMPLATE_KEYS),
  );
};

exports.down = false;
