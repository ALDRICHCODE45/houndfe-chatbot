/**
 * Inert inbound evidence baseline; no existing inbox/dedup semantics change.
 * No synthetic backfill: existing data cannot prove these coordinates/times.
 * Only future SignatureGuard-verified boundary capture may admit new rows.
 * Table existence is NOT cryptographic provenance, 24h eligibility or permission
 * to send. No message body, contact name, token or signature is retained.
 *
 * SQL checks structural bounds only. The domain parser remains authoritative
 * for derived UUIDv5, controls/all Unicode whitespace, calendar/canonical UTC
 * and provider <= observation. UUID storage is case-semantic; the adapter must
 * enforce the domain's lowercase canonical derivation at its boundary.
 * Text coordinates and times retain original bytes, without SQL normalization.
 * btrim checks ordinary spaces only; character counts are not JS UTF-16 lengths.
 *
 * Future adapter contract (NOT implemented here): INSERT/SELECT only, retain
 * first PERSISTED verified-ingress observation, not globally earliest arrival
 * under concurrency. Matching immutable identity/provider fields replay the
 * stored row even when retry observedAt differs; never overwrite observation.
 * Immutable-field conflicts HOLD. Production role controls remain a gate:
 * SQL owners can mutate rows; no immutability/provenance trigger is supplied.
 */
const TABLE = 'restock_inbound_evidence';
const boundedIdentity = (column, max) => `(
  char_length(${column}) BETWEEN 1 AND ${max}
  AND btrim(${column}) <> '' AND ${column} = btrim(${column})
) IS TRUE`;
const CHECKS = [
  ['version', '(version = 1) IS TRUE'],
  ['phone', "(receiving_phone_number_id ~ '^[0-9]{1,24}$') IS TRUE"],
  ['sender_id', boundedIdentity('sender_id', 200)],
  ['message_id', boundedIdentity('message_id', 512)],
  [
    'provider_seconds',
    // CASE guards conversion of malformed text; IS TRUE rejects NULL too.
    `(CASE WHEN provider_timestamp_seconds ~ '^[1-9][0-9]{0,12}$'
      THEN provider_timestamp_seconds::numeric <= 8640000000000
      ELSE FALSE END) IS TRUE`,
  ],
  [
    'observed_at',
    // Shape only, including Date.toISOString() positive extended-year boundary.
    `(btrim(observed_at) <> '' AND observed_at ~ '^([0-9]{4}|[+][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') IS TRUE`,
  ],
];

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    source_request_id: { type: 'uuid', primaryKey: true, notNull: true },
    receiving_phone_number_id: { type: 'text', notNull: true },
    sender_id: { type: 'text', notNull: true },
    message_id: { type: 'text', notNull: true },
    provider_timestamp_seconds: { type: 'text', notNull: true },
    observed_at: { type: 'text', notNull: true },
    version: { type: 'integer', notNull: true },
  });
  // The tuple's unique index already covers its receiving-phone prefix.
  pgm.addConstraint(
    TABLE,
    `${TABLE}_event_unique`,
    'UNIQUE (receiving_phone_number_id, sender_id, message_id)',
  );
  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
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
