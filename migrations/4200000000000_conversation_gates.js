/**
 * S4 durable conversation gates: the short-lived consent and selection state
 * that used to live in process memory (order confirmation, checkout
 * confirmation, saved-address references, pending RESTOCK question). One row
 * per (sender_id, gate_kind); expiry is enforced on read by the store, and a
 * worker deletes expired rows in bounded batches by `expires_at`.
 *
 * `down` locks the table and refuses while any unexpired gate exists, so a
 * rollback never silently drops a live customer confirmation. Expired rows
 * carry no authority and are dropped with the table.
 */
const TABLE = 'conversation_gates';
const KINDS = [
  'order_confirmation',
  'checkout_confirmation',
  'checkout_confirmed',
  'checkout_address',
  'restock_pending',
];
const PAYLOAD_MAX_BYTES = 65536;
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    sender_id: { type: 'text', notNull: true, collation: '"C"' },
    gate_kind: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint(TABLE, `${TABLE}_pkey`, {
    primaryKey: ['sender_id', 'gate_kind'],
  });
  const checks = [
    ['sender_id', 'char_length(sender_id) BETWEEN 1 AND 128'],
    ['gate_kind', `gate_kind IN (${quoted(KINDS)})`],
    ['payload', "jsonb_typeof(payload) = 'object'"],
    ['payload_size', `octet_length(payload::text) <= ${PAYLOAD_MAX_BYTES}`],
  ];
  for (const [name, definition] of checks)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);

  pgm.createIndex(TABLE, ['expires_at'], { name: `${TABLE}_expires_at_idx` });
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE} WHERE expires_at > now()) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE}: unexpired gates exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(TABLE);
};
