/**
 * RESTOCK application snapshots + optional reporting ACK (not delivery proof).
 * Offline baseline: the domain parser validates derived UUIDv5 and snapshot
 * shape/instants/deadline, not provenance or history. A future trusted adapter
 * must establish transition/CAS safety and correlate actual provider responses.
 * Direct SQL writers can mutate identity/history or bypass whole-row CAS: trusted
 * adapter-only writes are assumed. Role lockdown/guard is a production gate,
 * not supplied by this migration. No transition/immutability trigger is added.
 * Original timestamp strings stay in JSONB, never timestamptz columns.
 */
const TABLE = 'restock_application_ledger';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const STATES =
  "('PENDING_DELIVERY', 'SEND_STARTED', 'PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'STALE')";
const TERMINAL = "('PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'STALE')";
const COMMON = [
  'senderId',
  'branchId',
  'sourceRequestId',
  'decisionId',
  'attemptId',
  'resolvedAt',
  'applyBefore',
  'state',
];
const stringAt = (column, field) =>
  `jsonb_typeof(${column} -> '${field}') = 'string'`;
const present = (fields) =>
  fields.map((field) => stringAt('row_data', field)).join(' AND ');
const absent = (fields) =>
  fields.map((field) => `NOT (row_data ? '${field}')`).join(' AND ');
const branch = (state, included, excluded) =>
  `(row_data ->> 'state' = '${state}' AND ${
    included.length ? `${present(included)} AND ` : ''
  }${absent(excluded)})`;
const ROW_SHAPE = `(
  jsonb_typeof(row_data) = 'object'
  AND ${present(COMMON)}
  AND row_data -> 'resolutionVersion' = '2'::jsonb
  AND row_data ->> 'state' IN ${STATES}
) IS TRUE`;
const IDENTITY = `(
  btrim(sender_id) <> '' AND btrim(branch_id) <> ''
  AND row_data ->> 'senderId' = sender_id
  AND row_data ->> 'branchId' = branch_id
  AND ${['sourceRequestId', 'decisionId', 'attemptId']
    .map((field) => `row_data ->> '${field}' ~* '${UUID}'`)
    .join(' AND ')}
  AND lower(row_data ->> 'sourceRequestId') = source_request_id::text
  AND lower(row_data ->> 'decisionId') = decision_id::text
  AND lower(row_data ->> 'attemptId') = attempt_id::text
) IS TRUE`;
const STARTED = ['sendToken', 'attemptedAt'];
const ACCEPTED = ['providerMessageId', 'providerAcceptedObservedAt'];
const STALE = ['staleObservedAt'];
const EVIDENCE = `(
  ${branch('PENDING_DELIVERY', [], [...STARTED, ...ACCEPTED, ...STALE])}
  OR ${branch('SEND_STARTED', STARTED, [...ACCEPTED, ...STALE])}
  OR ${branch('PROVIDER_ACCEPTED', [...STARTED, ...ACCEPTED], STALE)}
  OR ${branch('PROVIDER_ACCEPTED_LATE', [...STARTED, ...ACCEPTED], STALE)}
  OR ${branch('STALE', STALE, [...STARTED, ...ACCEPTED])}
) IS TRUE`;
const ACK_KEYS =
  "ARRAY['id', 'version', 'attemptId', 'outcome', 'ackReceivedAt']";
const ACK = `(
  ack_receipt IS NULL OR (
    jsonb_typeof(ack_receipt) = 'object'
    AND ack_receipt ?& ${ACK_KEYS}
    AND ack_receipt - ${ACK_KEYS} = '{}'::jsonb
    AND ${['id', 'attemptId', 'outcome', 'ackReceivedAt']
      .map((field) => stringAt('ack_receipt', field))
      .join(' AND ')}
    AND ack_receipt -> 'version' = '2'::jsonb
    AND lower(ack_receipt ->> 'id') = decision_id::text
    AND lower(ack_receipt ->> 'attemptId') = attempt_id::text
    AND row_data ->> 'state' IN ${TERMINAL}
    AND ack_receipt ->> 'outcome' = row_data ->> 'state'
  )
) IS TRUE`;
const CHECKS = [
  ['row_shape_check', ROW_SHAPE],
  ['identity_check', IDENTITY],
  ['evidence_check', EVIDENCE],
  ['ack_check', ACK],
];

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    decision_id: { type: 'uuid', primaryKey: true },
    source_request_id: { type: 'uuid', notNull: true },
    attempt_id: { type: 'uuid', notNull: true, unique: true },
    sender_id: { type: 'text', notNull: true },
    branch_id: { type: 'text', notNull: true },
    row_data: { type: 'jsonb', notNull: true },
    ack_receipt: { type: 'jsonb' },
  });
  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, `${TABLE}_${name}`, `CHECK (${definition})`);
};

exports.down = (pgm) => {
  // node-pg-migrate's normal transaction holds this lock through the drop.
  // Refuse even pending rows; lock first so inserts cannot race the guard.
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
