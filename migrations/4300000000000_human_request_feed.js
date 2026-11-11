/**
 * Human request feed consumer (backend unit 5b,
 * docs/contracts/human-intervention-bot-contract-5b.md; docs/human-request-feed.md).
 *
 *   - `human_request_feed_cursor`: one row per consumer name; `cursor` NULL
 *     means "start from the oldest retained item". Saved only after a page
 *     was handled locally.
 *   - `human_request_deliveries`: the delivery ledger. `delivery_id` is the
 *     unique key inserted BEFORE any Meta call; a replayed item reuses the
 *     stored row and is never sent twice. `payload` keeps the whole parsed
 *     feed item. The ACK of the current attempt is durable: `ack_state`
 *     PENDING rows are retried with the same body (`attempt_id`,
 *     `attempted_at`, `provider_message_id`) until the backend answers.
 *   - `human_request_registry`: requests the bot created (T3 writes OPEN
 *     rows); a staff `request.cancelled` closes them.
 *
 * `down` locks the tables and refuses while a delivery still owes work
 * (a PENDING ACK, a SENDING attempt, a HUMAN hold) or a request is OPEN.
 */
const CURSOR = 'human_request_feed_cursor';
const DELIVERIES = 'human_request_deliveries';
const REGISTRY = 'human_request_registry';
const LOCAL_STATES = [
  'RECEIVED',
  'SENDING',
  'SENT',
  'STALE',
  'UNKNOWN',
  'DEFERRED_WINDOW',
  'HELD_HUMAN',
];
const DECISIONS = [
  'LEGACY_PATH_DELIVERS',
  'DUPLICATE',
  'WINDOW_CLOSED',
  'CANCEL_NOTICE',
  'CLARIFICATION',
  'UNKNOWN_TYPE',
  'UNKNOWN_KIND',
  'NO_CONVERSATION',
];
const ACK_STATES = ['PENDING', 'ACKED', 'FAILED_PERMANENT'];
const OUTCOMES = [
  'PROVIDER_ACCEPTED',
  'DELIVERY_UNKNOWN',
  'DEFERRED_WINDOW_CLOSED',
  'DEFERRED_HUMAN_SESSION',
  'STALE',
];
const REQUEST_STATUSES = ['OPEN', 'CANCELLED', 'RESOLVED'];
const CONVERSATION_REF = "'^wa:[0-9]{6,20}$'";
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const timestamps = (pgm) => ({
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
const addChecks = (pgm, table, checks) => {
  for (const [name, definition] of checks)
    pgm.addConstraint(table, `${table}_${name}_check`, `CHECK (${definition})`);
};

exports.up = (pgm) => {
  pgm.createTable(CURSOR, {
    consumer: { type: 'text', primaryKey: true, collation: '"C"' },
    cursor: { type: 'text' },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  addChecks(pgm, CURSOR, [
    ['consumer', 'char_length(consumer) BETWEEN 1 AND 100'],
    ['cursor', 'cursor IS NULL OR char_length(cursor) BETWEEN 1 AND 200'],
  ]);

  pgm.createTable(DELIVERIES, {
    delivery_id: { type: 'text', primaryKey: true, collation: '"C"' },
    cursor: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    request_id: { type: 'text' },
    conversation_ref: { type: 'text', collation: '"C"' },
    payload: { type: 'jsonb', notNull: true },
    local_state: { type: 'text', notNull: true, default: 'RECEIVED' },
    decision: { type: 'text' },
    attempt_id: { type: 'uuid' },
    provider_message_id: { type: 'text' },
    attempted_at: { type: 'timestamptz' },
    ack_state: { type: 'text' },
    ack_outcome: { type: 'text' },
    ack_attempts: { type: 'integer', notNull: true, default: 0 },
    next_ack_at: { type: 'timestamptz' },
    ack_error: { type: 'text' },
    ...timestamps(pgm),
  });
  addChecks(pgm, DELIVERIES, [
    ['delivery_id', 'char_length(delivery_id) BETWEEN 1 AND 200'],
    ['type', 'char_length(type) BETWEEN 1 AND 100'],
    [
      'conversation_ref',
      'conversation_ref IS NULL OR char_length(conversation_ref) <= 128',
    ],
    ['payload', "jsonb_typeof(payload) = 'object'"],
    ['local_state', `local_state IN (${quoted(LOCAL_STATES)})`],
    ['decision', `decision IS NULL OR decision IN (${quoted(DECISIONS)})`],
    ['ack_state', `ack_state IS NULL OR ack_state IN (${quoted(ACK_STATES)})`],
    [
      'ack_outcome',
      `ack_outcome IS NULL OR ack_outcome IN (${quoted(OUTCOMES)})`,
    ],
    ['ack_attempts', 'ack_attempts >= 0'],
    ['ack_error', 'ack_error IS NULL OR char_length(ack_error) <= 1000'],
    [
      'provider_message_id',
      'provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 512',
    ],
    // An owed ACK names its outcome and attempt; only PENDING has a due time.
    [
      'ack',
      `(ack_state IS NULL) = (ack_outcome IS NULL)
       AND (ack_state IS NULL OR attempt_id IS NOT NULL)
       AND (ack_state IS NOT DISTINCT FROM 'PENDING') = (next_ack_at IS NOT NULL)`,
    ],
    // An attempt that reached Meta keeps its evidence.
    [
      'attempt',
      `local_state NOT IN ('SENDING', 'SENT', 'UNKNOWN')
       OR (attempt_id IS NOT NULL AND attempted_at IS NOT NULL)`,
    ],
    ['sent', "local_state <> 'SENT' OR provider_message_id IS NOT NULL"],
  ]);
  // ACK sweeper: due PENDING ACKs in due order.
  pgm.createIndex(DELIVERIES, ['next_ack_at'], {
    name: `${DELIVERIES}_ack_due_idx`,
    where: "ack_state = 'PENDING'",
  });
  // Window / HUMAN replay of one conversation.
  pgm.createIndex(DELIVERIES, ['conversation_ref', 'local_state'], {
    name: `${DELIVERIES}_conversation_state_idx`,
  });
  // Global sweeps of held and crash-left rows.
  pgm.createIndex(DELIVERIES, ['local_state', 'updated_at'], {
    name: `${DELIVERIES}_open_states_idx`,
    where: "local_state IN ('HELD_HUMAN', 'SENDING')",
  });

  pgm.createTable(REGISTRY, {
    request_id: { type: 'text', primaryKey: true, collation: '"C"' },
    conversation_ref: { type: 'text', notNull: true, collation: '"C"' },
    subtype: { type: 'text', notNull: true },
    legacy_id: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    ...timestamps(pgm),
  });
  addChecks(pgm, REGISTRY, [
    ['request_id', 'char_length(request_id) BETWEEN 1 AND 200'],
    ['conversation_ref', `conversation_ref ~ ${CONVERSATION_REF}`],
    ['subtype', 'char_length(subtype) BETWEEN 1 AND 64'],
    [
      'legacy_id',
      'legacy_id IS NULL OR char_length(legacy_id) BETWEEN 1 AND 200',
    ],
    ['status', `status IN (${quoted(REQUEST_STATUSES)})`],
  ]);
  pgm.createIndex(REGISTRY, ['conversation_ref', 'status'], {
    name: `${REGISTRY}_conversation_status_idx`,
  });
};

exports.down = (pgm) => {
  pgm.sql(
    `LOCK TABLE ${CURSOR}, ${DELIVERIES}, ${REGISTRY} IN ACCESS EXCLUSIVE MODE;`,
  );
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${DELIVERIES}
          WHERE ack_state = 'PENDING' OR local_state IN ('SENDING', 'HELD_HUMAN')
       ) OR EXISTS (SELECT 1 FROM ${REGISTRY} WHERE status = 'OPEN') THEN
         RAISE EXCEPTION 'refusing to roll back the human request feed: deliveries or requests still owe work';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(REGISTRY);
  pgm.dropTable(DELIVERIES);
  pgm.dropTable(CURSOR);
};
