/**
 * Receipt payment flow review fixes (2026-11-06):
 *   - `upload_fields`: the exact declared/extracted upload fields computed on
 *     the first backend upload attempt; every same-key retry reuses them
 *     instead of running the vision extraction again (no drift under one
 *     `X-Idempotency-Key`). NULL until the first attempt starts.
 *   - 401/403/429 are retryable unknown outcomes, not definite refusals: the
 *     ATTACH_OUTCOME_UNKNOWN evidence check admits them. The definite check
 *     keeps admitting them so rows recorded before this migration stay valid;
 *     the store no longer writes them as definite.
 *
 * Irreversible like 3300–3500: there is no real data (always-on-features S4).
 */

const UNKNOWN_EXCLUDED_STATUSES = '400, 404, 409, 413, 415, 422';
const implies = (a, b) => `(NOT (${a}) OR (${b}))`;

exports.up = (pgm) => {
  const t = 'receipt_media';
  pgm.addColumns(t, {
    upload_fields: {
      type: 'jsonb',
      check: "upload_fields IS NULL OR jsonb_typeof(upload_fields) = 'object'",
    },
  });
  pgm.dropConstraint(t, 'receipt_media_unknown_attach_outcome');
  pgm.addConstraint(
    t,
    'receipt_media_unknown_attach_outcome',
    `CHECK (${implies(
      "status = 'ATTACH_OUTCOME_UNKNOWN'",
      `attach_outcome_observed_at IS NOT NULL AND backend_receipt_id IS NULL AND ((attach_http_status IS NOT NULL AND (attach_http_status < 200 OR attach_http_status > 299) AND attach_http_status NOT IN (${UNKNOWN_EXCLUDED_STATUSES})) OR attach_transport_code IS NOT NULL)`,
    )})`,
  );
};

exports.down = false;
