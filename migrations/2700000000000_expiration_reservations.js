/**
 * HD EXPIRATION reservation schema: widen the shared reservation table to a
 * third route by replacing EXACTLY the four constraints that hard-code the
 * LEGACY_OPS/RESTOCK route set — 230 route/request_key/intake, 240
 * post_state_route. LEGACY_OPS/RESTOCK branches stay byte-equivalent; the
 * status/sender checks, both unique indexes and the four RESTOCK metadata
 * checks are untouched.
 *
 * EXPIRATION keys are strict RFC 4122 v1-v8 UUIDs with variant 8/9/a/b (nil
 * invalid), case-insensitive syntax, but `sourceRequestId` must equal
 * `request_key` byte-for-byte. Intake is an exact four-key JSON object with JSON
 * string ids and `variantId` an explicit JSON null or valid UUID. Every
 * EXPIRATION predicate is forced strict (`IS TRUE`) so a missing/null value can
 * never pass as UNKNOWN; `post_state` stays SQL NULL, so the 240 checks force
 * all four metadata columns NULL (no EXPIRATION POST semantics).
 *
 * `down` locks the table, refuses ANY EXPIRATION row (ACTIVE or CLOSED), then
 * restores the exact original four checks; it never deletes or converts a row.
 */
const TABLE = 'human_decision_reservations';
const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const KEYS = "ARRAY['sourceRequestId', 'type', 'productId', 'variantId']";
const L_KEY = "(route = 'LEGACY_OPS' AND request_key ~ '^[0-9a-f]{12}$')";
const R_KEY =
  "(route = 'RESTOCK' AND request_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')";
const L_INTAKE = "(route = 'LEGACY_OPS' AND intake IS NULL)";
const R_INTAKE =
  "(route = 'RESTOCK' AND intake IS NOT NULL AND jsonb_typeof(intake) = 'object' AND COALESCE((intake ->> 'sourceRequestId') = request_key, false))";
const L_POST = "(route = 'LEGACY_OPS' AND post_state IS NULL)";
const R_POST =
  "(route = 'RESTOCK' AND post_state IS NOT NULL AND post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN'))";
const E_KEY = `(route = 'EXPIRATION' AND request_key ~* '^${UUID}$')`;
const E_POST = "(route = 'EXPIRATION' AND post_state IS NULL)";
// `IS TRUE` collapses any UNKNOWN from a missing/null field to FALSE so the
// three-valued CHECK cannot silently accept a malformed EXPIRATION row.
const E_INTAKE = `(route = 'EXPIRATION' AND (intake IS NOT NULL AND jsonb_typeof(intake) = 'object' AND intake ?& ${KEYS} AND intake - ${KEYS} = '{}'::jsonb AND jsonb_typeof(intake -> 'sourceRequestId') = 'string' AND (intake ->> 'sourceRequestId') = request_key AND jsonb_typeof(intake -> 'type') = 'string' AND intake ->> 'type' = 'EXPIRATION' AND jsonb_typeof(intake -> 'productId') = 'string' AND (intake ->> 'productId') ~* '^${UUID}$' AND (intake -> 'variantId' = 'null'::jsonb OR (jsonb_typeof(intake -> 'variantId') = 'string' AND (intake ->> 'variantId') ~* '^${UUID}$'))) IS TRUE)`;
// [name, original definition, EXPIRATION-widened definition]
const CHECKS = [
  [
    'human_decision_reservations_route_check',
    "route IN ('LEGACY_OPS', 'RESTOCK')",
    "route IN ('LEGACY_OPS', 'RESTOCK', 'EXPIRATION')",
  ],
  [
    'human_decision_reservations_request_key_check',
    `${L_KEY} OR ${R_KEY}`,
    `${L_KEY} OR ${R_KEY} OR ${E_KEY}`,
  ],
  [
    'human_decision_reservations_intake_check',
    `${L_INTAKE} OR ${R_INTAKE}`,
    `${L_INTAKE} OR ${R_INTAKE} OR ${E_INTAKE}`,
  ],
  [
    'human_decision_reservations_post_state_route_check',
    `${L_POST} OR ${R_POST}`,
    `${L_POST} OR ${R_POST} OR ${E_POST}`,
  ],
];
const rewrite = (pgm, widened) => {
  for (const [name, original, replacement] of CHECKS) {
    pgm.dropConstraint(TABLE, name);
    pgm.addConstraint(
      TABLE,
      name,
      `CHECK (${widened ? replacement : original})`,
    );
  }
};

exports.up = (pgm) => rewrite(pgm, true);

exports.down = (pgm) => {
  // Normal node-pg-migrate transaction holds this lock through guard + rewrite.
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE} WHERE route = 'EXPIRATION') THEN
         RAISE EXCEPTION 'refusing to revert EXPIRATION constraints: EXPIRATION rows exist';
       END IF;
     END $guard$;`,
  );
  rewrite(pgm, false);
};
