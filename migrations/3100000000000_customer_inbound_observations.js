/**
 * Inert trusted customer-inbound evidence storage. Additive and unwired: no
 * controller/module/query uses this table, and no store, latest reader,
 * UPDATE/upsert/latest-pointer, retention or backfill is introduced. Only
 * future signature-verified capture through a validated adapter may admit rows.
 *
 * SQL checks structural bounds only. BIGINT is numeric, so its canonical
 * lexical spelling is NOT preserved and differs from the domain string. Exact
 * calendars, canonical UTC, JavaScript UTF-16 lengths, control/Unicode
 * whitespace, provider <= observation, provenance and the exact five-field
 * own-data contract stay domain/adapter responsibilities. Text coordinates and
 * observed_at retain their original bytes; SQL does not normalize them.
 *
 * The (receiving_phone_number_id, message_id) primary key deliberately excludes
 * sender_id: one provider message is one event, while the same message on
 * another receiving phone is distinct. The latest index supports future
 * per-sender selection by original provider time, not replay time; this
 * migration only proves structure. SQL owners can still mutate rows: no
 * immutability, provenance or role trigger; existence is not send permission.
 */
const TABLE = 'customer_inbound_observations';
const LATEST_INDEX = `${TABLE}_latest_idx`;
const boundedIdentity = (column, max) => `(
  char_length(${column}) BETWEEN 1 AND ${max}
  AND btrim(${column}) <> '' AND ${column} = btrim(${column})
) IS TRUE`;
const CHECKS = [
  ['phone', "(receiving_phone_number_id ~ '^[0-9]{1,24}$') IS TRUE"],
  ['sender_id', boundedIdentity('sender_id', 200)],
  ['message_id', boundedIdentity('message_id', 512)],
  [
    'provider_seconds',
    '(provider_timestamp_seconds BETWEEN 1 AND 8640000000000) IS TRUE',
  ],
  [
    'observed_at',
    // Shape only, including Date.toISOString() positive extended-year boundary.
    `(btrim(observed_at) <> '' AND observed_at ~ '^([0-9]{4}|[+][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') IS TRUE`,
  ],
];

exports.up = (pgm) => {
  pgm.createTable(
    TABLE,
    {
      receiving_phone_number_id: {
        type: 'text',
        notNull: true,
        collation: '"C"',
      },
      sender_id: { type: 'text', notNull: true, collation: '"C"' },
      message_id: { type: 'text', notNull: true, collation: '"C"' },
      provider_timestamp_seconds: { type: 'bigint', notNull: true },
      observed_at: { type: 'text', notNull: true },
    },
    {
      constraints: { primaryKey: ['receiving_phone_number_id', 'message_id'] },
    },
  );
  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
  pgm.createIndex(
    TABLE,
    [
      'receiving_phone_number_id',
      'sender_id',
      { name: 'provider_timestamp_seconds', sort: 'DESC' },
      { name: 'message_id', sort: 'DESC' },
    ],
    { name: LATEST_INDEX },
  );
};

exports.down = (pgm) => {
  // Normal node-pg-migrate transaction holds this lock through guard and drop.
  // No time-based purge: even one evidence row blocks rollback.
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
