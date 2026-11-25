/**
 * Durable which-pet question (odd/tasks/multi-pet-profiles.md T4c-2a; S3,
 * S13):
 *
 *   - `pet_choice`: the «¿Para quién es?» question the bot asked with one
 *     button / list row per known pet, kept 15 minutes. Its payload holds the
 *     purpose (`request` for now), the offered options (pet ref + name) and
 *     the customer's original request text, so a tap after a process restart
 *     still continues that request for the chosen pet. «olvida mis datos»
 *     deletes the row (the payload holds pet names).
 *
 * A short-lived row of `conversation_gates` (migration 4200), keyed by
 * (sender_id, gate_kind) like the others; only the closed `gate_kind` CHECK
 * changes (5500 widened it with the backorder kinds).
 *
 * `down` locks the table and refuses while an unexpired `pet_choice` row
 * exists, so a rollback never silently drops a live question. Expired rows
 * carry no authority and are deleted before the previous CHECK is restored.
 */
const TABLE = 'conversation_gates';
const CONSTRAINT = `${TABLE}_gate_kind_check`;
const PREVIOUS_KINDS = [
  'order_confirmation',
  'checkout_confirmation',
  'checkout_confirmed',
  'checkout_address',
  'restock_pending',
  'payment_offer',
  'backorder_offer',
  'backorder_quantity',
];
const ADDED_KINDS = ['pet_choice'];
const KINDS = [...PREVIOUS_KINDS, ...ADDED_KINDS];
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const kindCheck = (kinds) => `CHECK (gate_kind IN (${quoted(kinds)}))`;

exports.up = (pgm) => {
  pgm.dropConstraint(TABLE, CONSTRAINT);
  pgm.addConstraint(TABLE, CONSTRAINT, kindCheck(KINDS));
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${TABLE}
         WHERE gate_kind IN (${quoted(ADDED_KINDS)}) AND expires_at > now()
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${CONSTRAINT}: unexpired pet_choice gates exist';
       END IF;
     END $guard$;`,
  );
  pgm.sql(`DELETE FROM ${TABLE} WHERE gate_kind IN (${quoted(ADDED_KINDS)});`);
  pgm.dropConstraint(TABLE, CONSTRAINT);
  pgm.addConstraint(TABLE, CONSTRAINT, kindCheck(PREVIOUS_KINDS));
};
