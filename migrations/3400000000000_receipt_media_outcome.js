/**
 * Receipt payment flow R5: the customer hears the human outcome (S5).
 *
 * An ATTACHED receipt is polled against GET /chatbot-api/receipts/:id until
 * the backend reports CONFIRMED or REJECTED. The outcome, the customer reason,
 * the remaining debt and the notification are recorded once, in the same
 * transaction that queues the customer message (or records that the 24 h
 * WhatsApp window had closed), so a receipt is notified exactly once.
 *
 *   - `sale_folio`: the order folio captured at upload, for the texts.
 *   - `outcome_*`: the human outcome and its notification evidence.
 *   - three outbox template keys for the outcome texts.
 *
 * Irreversible like 3300: there is no real data (always-on-features S4).
 */

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
  'RECEIPT_PAYMENT_CONFIRMED',
  'RECEIPT_PAYMENT_PARTIAL',
  'RECEIPT_PAYMENT_REJECTED',
];

const oneOf = (col, values) =>
  `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;
const implies = (a, b) => `(NOT (${a}) OR (${b}))`;
const OUTCOME_COLS = [
  'outcome_status',
  'outcome_debt_cents',
  'outcome_observed_at',
  'outcome_notified_at',
  'outcome_delivery',
];

exports.up = (pgm) => {
  const t = 'receipt_media';
  pgm.addColumns(t, {
    sale_folio: {
      type: 'text',
      check: 'sale_folio IS NULL OR char_length(sale_folio) BETWEEN 1 AND 40',
    },
    outcome_status: {
      type: 'text',
      check: `outcome_status IS NULL OR ${oneOf('outcome_status', ['CONFIRMED', 'REJECTED'])}`,
    },
    outcome_reason: {
      type: 'text',
      check:
        'outcome_reason IS NULL OR char_length(outcome_reason) BETWEEN 1 AND 500',
    },
    outcome_debt_cents: {
      type: 'bigint',
      check: 'outcome_debt_cents IS NULL OR outcome_debt_cents >= 0',
    },
    outcome_observed_at: { type: 'timestamptz' },
    outcome_polled_at: { type: 'timestamptz' },
    outcome_notified_at: { type: 'timestamptz' },
    outcome_delivery: {
      type: 'text',
      check: `outcome_delivery IS NULL OR ${oneOf('outcome_delivery', ['QUEUED', 'OUTSIDE_WINDOW'])}`,
    },
  });
  pgm.addConstraint(
    t,
    'receipt_media_outcome_evidence',
    `CHECK (${[
      // All outcome evidence is written together, once.
      `(${OUTCOME_COLS.map((c) => `${c} IS NULL`).join(' AND ')}) OR (${OUTCOME_COLS.map((c) => `${c} IS NOT NULL`).join(' AND ')})`,
      implies('outcome_status IS NOT NULL', "status = 'ATTACHED'"),
      implies('outcome_reason IS NOT NULL', "outcome_status = 'REJECTED'"),
      implies('outcome_polled_at IS NOT NULL', "status = 'ATTACHED'"),
    ]
      .map((c) => `(${c})`)
      .join(' AND ')})`,
  );
  pgm.createIndex(t, ['outcome_polled_at', 'attached_at'], {
    name: 'receipt_media_outcome_due_idx',
    where: "status = 'ATTACHED' AND outcome_notified_at IS NULL",
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
