/**
 * S2 backend outbox (human-intervention contract v1 §10.1): every fact the
 * backend must learn from the bot is committed to `backend_outbox` and
 * drained in strict per-conversation `seq` order. Only the lowest seq that
 * is neither DONE nor DEAD is claimable (FOR UPDATE SKIP LOCKED + lease);
 * retries are indefinite with backoff; a DEAD row lets the next seq go.
 *
 * `backend_outbox_sequences` hands out the per-conversation seq with
 * INSERT … ON CONFLICT DO UPDATE … RETURNING inside the enqueue
 * transaction: the counter row lock serializes enqueues of one conversation
 * until commit, so commit order equals seq order. Counters are never
 * purged, so a seq is never reused after DONE rows are purged.
 */
const TABLE = 'backend_outbox';
const SEQUENCES = 'backend_outbox_sequences';
const KINDS = [
  'MESSAGE_MIRROR',
  'MESSAGE_STATUS',
  'REQUEST_CREATE',
  'REQUEST_CANCEL',
  'SESSION_ACK',
  'DELIVERY_OUTCOME',
];
const STATUSES = ['PENDING', 'IN_FLIGHT', 'DONE', 'DEAD'];
const CONVERSATION_REF = "'^wa:[0-9]{6,20}$'";
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = (pgm) => {
  pgm.createTable(SEQUENCES, {
    conversation_ref: { type: 'text', primaryKey: true, collation: '"C"' },
    next_seq: { type: 'bigint', notNull: true },
  });
  pgm.addConstraint(
    SEQUENCES,
    `${SEQUENCES}_conversation_ref_check`,
    `CHECK (conversation_ref ~ ${CONVERSATION_REF})`,
  );
  pgm.addConstraint(
    SEQUENCES,
    `${SEQUENCES}_next_seq_check`,
    'CHECK (next_seq >= 2)',
  );

  pgm.createTable(TABLE, {
    id: { type: 'bigserial', primaryKey: true },
    conversation_ref: { type: 'text', notNull: true, collation: '"C"' },
    seq: { type: 'bigint', notNull: true },
    kind: { type: 'text', notNull: true },
    idempotency_key: { type: 'text', notNull: true, collation: '"C"' },
    payload: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true, default: 'PENDING' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    lease_owner: { type: 'text' },
    lease_expires_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    done_at: { type: 'timestamptz' },
  });
  pgm.addConstraint(TABLE, `${TABLE}_idempotency_key_key`, {
    unique: ['idempotency_key'],
  });
  pgm.addConstraint(TABLE, `${TABLE}_conversation_seq_key`, {
    unique: ['conversation_ref', 'seq'],
  });
  const checks = [
    ['conversation_ref', `conversation_ref ~ ${CONVERSATION_REF}`],
    ['seq', 'seq >= 1'],
    ['kind', `kind IN (${quoted(KINDS)})`],
    ['status', `status IN (${quoted(STATUSES)})`],
    ['idempotency_key', 'char_length(idempotency_key) BETWEEN 1 AND 200'],
    ['payload', "jsonb_typeof(payload) = 'object'"],
    ['attempts', 'attempts >= 0'],
    ['last_error', 'last_error IS NULL OR char_length(last_error) <= 1000'],
    // A lease exists exactly while the row is IN_FLIGHT.
    [
      'lease',
      `(status = 'IN_FLIGHT') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
       AND (lease_owner IS NULL) = (lease_expires_at IS NULL)`,
    ],
    ['done_at', "(status = 'DONE') = (done_at IS NOT NULL)"],
  ];
  for (const [name, definition] of checks)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);

  // Head lookup for claiming: open rows per conversation in seq order.
  pgm.createIndex(TABLE, ['conversation_ref', 'seq'], {
    name: `${TABLE}_open_heads_idx`,
    where: "status IN ('PENDING', 'IN_FLIGHT')",
  });
  pgm.createIndex(TABLE, ['done_at'], { name: `${TABLE}_done_at_idx` });
};

exports.down = (pgm) => {
  // Same guard as the other ledgers: never drop undelivered facts.
  pgm.sql(`LOCK TABLE ${TABLE}, ${SEQUENCES} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE}: table is non-empty';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(TABLE);
  pgm.dropTable(SEQUENCES);
};
