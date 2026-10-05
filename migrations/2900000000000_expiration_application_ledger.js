/**
 * Independent EXPIRATION application ledger: inert snapshots, no ACK/foreign
 * keys/triggers/transitions/runtime binding. SQL proves canonical-column
 * binding and shape presence only; derived identity, RFC UUID bits, instants,
 * the 24h deadline and exact-key rejection are the normalizer/adapter's job.
 * Extra keys stay legal and a trusted adapter owns writes. No timestamptz.
 */
const TABLE = 'expiration_application_ledger';
const STATES =
  "('PENDING_DELIVERY', 'SEND_STARTED', 'PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'STALE')";
const COMMON =
  'senderId branchId sourceRequestId decisionId attemptId resolvedAt applyBefore state'.split(
    ' ',
  );
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
// Canonical, case-exact binding: unlike RESTOCK, no lower()/case-folding alias.
const bind = (field, column) => `row_data ->> '${field}' = ${column}::text`;
const IDENTITY = `(
  btrim(sender_id) <> '' AND btrim(branch_id) <> ''
  AND ${bind('senderId', 'sender_id')} AND ${bind('branchId', 'branch_id')}
  AND ${bind('sourceRequestId', 'source_request_id')}
  AND ${bind('decisionId', 'decision_id')} AND ${bind('attemptId', 'attempt_id')}
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
exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    decision_id: { type: 'uuid', primaryKey: true },
    source_request_id: { type: 'uuid', notNull: true },
    attempt_id: { type: 'uuid', notNull: true, unique: true },
    sender_id: { type: 'text', notNull: true },
    branch_id: { type: 'text', notNull: true },
    row_data: { type: 'jsonb', notNull: true },
  });
  pgm.addConstraint(TABLE, `${TABLE}_row_shape_check`, `CHECK (${ROW_SHAPE})`);
  pgm.addConstraint(TABLE, `${TABLE}_identity_check`, `CHECK (${IDENTITY})`);
  pgm.addConstraint(TABLE, `${TABLE}_evidence_check`, `CHECK (${EVIDENCE})`);
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
