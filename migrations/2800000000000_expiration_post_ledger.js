/** EXPIRATION POST schema only. No backfill/default or send authorization.
 * Existing NULL reservations remain uninitialized; a later fenced CAS owns
 * initialization and every transition. Existing RESTOCK/legacy checks stay.
 */
const TABLE = 'human_decision_reservations';
const STATE = `${TABLE}_post_state_route_check`;
const BACKEND = `${TABLE}_expiration_backend_id_check`;
const ORIGINAL =
  "(route = 'LEGACY_OPS' AND post_state IS NULL) OR (route = 'RESTOCK' AND post_state IS NOT NULL AND post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN')) OR (route = 'EXPIRATION' AND post_state IS NULL)";
const REPLACEMENT =
  "(route = 'LEGACY_OPS' AND post_state IS NULL) OR (route = 'RESTOCK' AND post_state IS NOT NULL AND post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN')) OR (route = 'EXPIRATION' AND (post_state IS NULL OR post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN')))";
// Metadata iff-state checks from 240 remain authoritative. Add the stricter
// canonical backend UUID required by EXPIRATION's receipt contract only.
const UUID =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
/** @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @param {string} definition */
const replace = (pgm, definition) => {
  pgm.dropConstraint(TABLE, STATE);
  pgm.addConstraint(TABLE, STATE, `CHECK (${definition})`);
};
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  replace(pgm, REPLACEMENT);
  pgm.addConstraint(
    TABLE,
    BACKEND,
    `CHECK (route <> 'EXPIRATION' OR backend_decision_id IS NULL OR (backend_decision_id ~ '${UUID}') IS TRUE)`,
  );
};
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(`DO $guard$ BEGIN
    IF EXISTS (SELECT 1 FROM ${TABLE} WHERE route = 'EXPIRATION' AND (
      post_state IS NOT NULL OR backend_decision_id IS NOT NULL OR
      post_attempted_at IS NOT NULL OR receipt_recorded_at IS NOT NULL OR
      unknown_observed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'refusing to revert EXPIRATION POST ledger: attempt data exists';
    END IF;
  END $guard$;`);
  pgm.dropConstraint(TABLE, BACKEND);
  replace(pgm, ORIGINAL);
};
