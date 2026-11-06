/**
 * Durable DELIVERY_ZONE requesters (docs/contracts/delivery-zone-bot-cycle.md).
 * One row per chatbot requester: the exact intake body (replayed under the
 * same sourceRequestId), the backend requester id, the current poll status,
 * the resolution, and the single notification + ACK evidence. A zone
 * validation may stay PENDING for days, so polling state lives here and
 * survives restarts.
 *
 * At most one OPEN row per (sender, ZIP): repeated PENDING quotes for the
 * same ZIP reuse the open requester instead of creating new ones. CLOSED and
 * FAILED rows release the slot.
 */
const TABLE = 'delivery_zone_requesters';
const STATUSES = [
  'INTAKE_PENDING',
  'PENDING',
  'RESOLVED',
  'SEND_STARTED',
  'NOTIFIED',
  'CLOSED',
  'FAILED',
];
const OPEN = [
  'INTAKE_PENDING',
  'PENDING',
  'RESOLVED',
  'SEND_STARTED',
  'NOTIFIED',
];
const OUTCOMES = [
  'PROVIDER_ACCEPTED',
  'PROVIDER_ACCEPTED_LATE',
  'DELIVERY_UNKNOWN',
];
const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    source_request_id: { type: 'uuid', primaryKey: true },
    sender_id: { type: 'text', notNull: true, collation: '"C"' },
    zip_code: { type: 'text', notNull: true },
    intake: { type: 'jsonb', notNull: true },
    requester_id: { type: 'uuid' },
    status: { type: 'text', notNull: true },
    last_polled_at: { type: 'timestamptz' },
    resolution: { type: 'jsonb' },
    apply_before: { type: 'timestamptz' },
    channel: { type: 'text' },
    attempt_id: { type: 'uuid' },
    attempted_at: { type: 'timestamptz' },
    delivery_outcome: { type: 'text' },
    provider_message_id: { type: 'text' },
    provider_accepted_observed_at: { type: 'timestamptz' },
    notified_at: { type: 'timestamptz' },
    ack_outcome: { type: 'text' },
    acked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true },
  });
  const checks = [
    ['status', `status IN (${list(STATUSES)})`],
    ['zip', "zip_code ~ '^[0-9]{5}$'"],
    ['sender', 'char_length(sender_id) BETWEEN 1 AND 200'],
    ['channel', "channel IS NULL OR channel IN ('TEXT', 'TEMPLATE')"],
    [
      'delivery_outcome',
      `delivery_outcome IS NULL OR delivery_outcome IN (${list(OUTCOMES)})`,
    ],
    [
      'ack_outcome',
      `ack_outcome IS NULL OR ack_outcome IN (${list(OUTCOMES)})`,
    ],
    // A send can only start once the resolution and its window are stored.
    [
      'resolved_evidence',
      `status IN ('INTAKE_PENDING', 'PENDING', 'FAILED')
       OR (resolution IS NOT NULL AND apply_before IS NOT NULL AND requester_id IS NOT NULL)`,
    ],
    [
      'send_evidence',
      `status NOT IN ('SEND_STARTED', 'NOTIFIED')
       OR (channel IS NOT NULL AND attempt_id IS NOT NULL AND attempted_at IS NOT NULL)`,
    ],
    [
      'notified_evidence',
      `status <> 'NOTIFIED' OR (delivery_outcome IS NOT NULL AND notified_at IS NOT NULL)`,
    ],
  ];
  for (const [name, definition] of checks)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
  pgm.createIndex(TABLE, ['sender_id', 'zip_code'], {
    name: `${TABLE}_open_slot_idx`,
    unique: true,
    where: `status IN (${list(OPEN)})`,
  });
  pgm.createIndex(TABLE, ['requester_id'], {
    name: `${TABLE}_requester_idx`,
    unique: true,
    where: 'requester_id IS NOT NULL',
  });
  pgm.createIndex(TABLE, ['status', 'last_polled_at'], {
    name: `${TABLE}_due_idx`,
    where: `status IN (${list(OPEN)})`,
  });
};

exports.down = (pgm) => {
  // Same guard as the other human-decision ledgers: never drop live evidence.
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE}: table is non-empty';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(TABLE);
};
