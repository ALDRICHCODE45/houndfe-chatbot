/**
 * HD-R3b3-c2 RESTOCK POST ledger columns on `human_decision_reservations`.
 *
 * `post_state` is NULL for LEGACY_OPS and required for RESTOCK
 * (RESERVED -> POST_IN_FLIGHT -> RECEIPT_RECORDED | UNKNOWN).
 * `backend_decision_id` is a UUID iff RECEIPT_RECORDED. `post_attempted_at` is
 * set once a POST is attempted (POST_IN_FLIGHT/RECEIPT_RECORDED; optional on
 * UNKNOWN because UNKNOWN can come straight from RESERVED),
 * `receipt_recorded_at` iff RECEIPT_RECORDED, `unknown_observed_at` iff UNKNOWN.
 * Every predicate is strictly boolean (IS NOT NULL / COALESCE / IS TRUE) so a
 * missing/null post_state can never pass as UNKNOWN. Legacy rows keep all five
 * columns NULL. `down` refuses if any RESTOCK post data would be lost.
 */

const TABLE = 'human_decision_reservations';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const POST_COLUMNS = [
  'post_state',
  'backend_decision_id',
  'post_attempted_at',
  'receipt_recorded_at',
  'unknown_observed_at',
];
const STATE_CHECK =
  "(route = 'LEGACY_OPS' AND post_state IS NULL) OR (route = 'RESTOCK' AND post_state IS NOT NULL AND post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN'))";
const BACKEND_CHECK = `((backend_decision_id IS NOT NULL) = COALESCE(post_state = 'RECEIPT_RECORDED', false)) AND (backend_decision_id IS NULL OR backend_decision_id ~* '${UUID}')`;
const ATTEMPTED_CHECK =
  "(CASE WHEN post_state = 'POST_IN_FLIGHT' THEN post_attempted_at IS NOT NULL WHEN post_state = 'RECEIPT_RECORDED' THEN post_attempted_at IS NOT NULL WHEN post_state = 'RESERVED' THEN post_attempted_at IS NULL WHEN post_state = 'UNKNOWN' THEN TRUE ELSE post_attempted_at IS NULL END) IS TRUE";
const RECEIPT_AT_CHECK =
  "(receipt_recorded_at IS NOT NULL) = COALESCE(post_state = 'RECEIPT_RECORDED', false)";
const UNKNOWN_AT_CHECK =
  "(unknown_observed_at IS NOT NULL) = COALESCE(post_state = 'UNKNOWN', false)";
const CHECKS = [
  ['human_decision_reservations_post_state_route_check', STATE_CHECK],
  ['human_decision_reservations_backend_decision_id_check', BACKEND_CHECK],
  ['human_decision_reservations_post_attempted_at_check', ATTEMPTED_CHECK],
  ['human_decision_reservations_receipt_recorded_at_check', RECEIPT_AT_CHECK],
  ['human_decision_reservations_unknown_observed_at_check', UNKNOWN_AT_CHECK],
];

exports.up = (pgm) => {
  pgm.addColumns(TABLE, {
    post_state: { type: 'text' },
    backend_decision_id: { type: 'text' },
    post_attempted_at: { type: 'timestamptz' },
    receipt_recorded_at: { type: 'timestamptz' },
    unknown_observed_at: { type: 'timestamptz' },
  });
  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, name, `CHECK (${definition})`);
};

exports.down = (pgm) => {
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${TABLE}
         WHERE route = 'RESTOCK'
            OR post_state IS NOT NULL
            OR backend_decision_id IS NOT NULL
            OR post_attempted_at IS NOT NULL
            OR receipt_recorded_at IS NOT NULL
            OR unknown_observed_at IS NOT NULL
       ) THEN
         RAISE EXCEPTION 'refusing to drop RESTOCK post ledger: data would be lost';
       END IF;
     END $guard$;`,
  );
  for (const [name] of CHECKS) pgm.dropConstraint(TABLE, name);
  pgm.dropColumns(TABLE, POST_COLUMNS);
};
