/**
 * Durable restock-backorder gates (odd/tasks/restock-backorder.md T4):
 *
 *   - `backorder_offer`: the offer «¿Quiere que se lo apartemos en cuanto
 *     llegue?» sent after the RESTOCK estimate (decision, product, estimate,
 *     stated quantity), so the customer's answer still counts after a process
 *     restart. It is armed outside a customer turn, once Meta accepted the
 *     message.
 *   - `backorder_quantity`: the unit count the customer stated when the
 *     RESTOCK request was made, per product/variant, kept until the estimate
 *     arrives (the RESTOCK request itself stores no quantity).
 *
 * Both are short-lived rows of `conversation_gates` (migration 4200), keyed by
 * (sender_id, gate_kind) like the others; only the closed `gate_kind` CHECK
 * changes (5400 widened it with `payment_offer`).
 *
 * `down` locks the table and refuses while an unexpired row of either kind
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
  'payment_offer',
];
const ADDED_KINDS = ['backorder_offer', 'backorder_quantity'];
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
         RAISE EXCEPTION 'refusing to roll back ${CONSTRAINT}: unexpired backorder gates exist';
       END IF;
     END $guard$;`,
  );
  pgm.sql(`DELETE FROM ${TABLE} WHERE gate_kind IN (${quoted(ADDED_KINDS)});`);
  pgm.dropConstraint(TABLE, CONSTRAINT);
  pgm.addConstraint(TABLE, CONSTRAINT, kindCheck(PREVIOUS_KINDS));
};
