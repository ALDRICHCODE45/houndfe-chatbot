/**
 * Durable payment offer: the sale the bot's «¿Cómo desea pagar?» question is
 * about, so the customer's next message still answers it after a process
 * restart. It is one more short-lived row of `conversation_gates`
 * (migration 4200), keyed by (sender_id, gate_kind) like the others; only the
 * closed `gate_kind` CHECK changes.
 *
 * `down` locks the table and refuses while an unexpired `payment_offer` row
 * exists, so a rollback never silently drops a live offer. Expired rows carry
 * no authority and are deleted before the previous CHECK is restored.
 */
const TABLE = 'conversation_gates';
const CONSTRAINT = `${TABLE}_gate_kind_check`;
const PREVIOUS_KINDS = [
  'order_confirmation',
  'checkout_confirmation',
  'checkout_confirmed',
  'checkout_address',
  'restock_pending',
];
const KINDS = [...PREVIOUS_KINDS, 'payment_offer'];
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
         WHERE gate_kind = 'payment_offer' AND expires_at > now()
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${CONSTRAINT}: unexpired payment_offer gates exist';
       END IF;
     END $guard$;`,
  );
  pgm.sql(`DELETE FROM ${TABLE} WHERE gate_kind = 'payment_offer';`);
  pgm.dropConstraint(TABLE, CONSTRAINT);
  pgm.addConstraint(TABLE, CONSTRAINT, kindCheck(PREVIOUS_KINDS));
};
