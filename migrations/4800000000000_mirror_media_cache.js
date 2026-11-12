/**
 * Conversation mirror media cache (spec S1): `idempotency_key → media_id`.
 *
 * One backend upload per distinct file: the chatbot looks the key
 * (`mediaIdempotencyKey(source[, version])`, a UUIDv5) up here before it
 * downloads anything, so a product photo sent to many customers is uploaded
 * once and a retried mirror row does not download the file again.
 *
 *   - `created_at`: when the media was uploaded; an entry older than the
 *     service's max age is re-uploaded under a fresh key (the backend keeps
 *     media about 12 months).
 *   - `last_used_at`: recency for the lazy prune (entries unused for 30 days
 *     are removed); refreshed at most once a day per entry.
 *
 * Additive: one new table, nothing existing is touched. `down` locks the table
 * and refuses while it has rows (as the other migrations do): the rows are
 * only a cache, so TRUNCATE the table first to roll back deliberately and the
 * chatbot simply uploads again.
 */
const TABLE = 'mirror_media_cache';
const MAX_BYTES = 10 * 1024 * 1024;

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    idempotency_key: { type: 'uuid', primaryKey: true },
    media_id: { type: 'text', notNull: true },
    mime_type: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_used_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint(
    TABLE,
    `${TABLE}_media_id_check`,
    'CHECK (char_length(media_id) BETWEEN 1 AND 100)',
  );
  pgm.addConstraint(
    TABLE,
    `${TABLE}_mime_type_check`,
    'CHECK (char_length(mime_type) BETWEEN 1 AND 100)',
  );
  pgm.addConstraint(
    TABLE,
    `${TABLE}_size_bytes_check`,
    `CHECK (size_bytes BETWEEN 1 AND ${MAX_BYTES})`,
  );
  pgm.createIndex(TABLE, 'last_used_at', { name: `${TABLE}_last_used_idx` });
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}) THEN
         RAISE EXCEPTION 'refusing to drop ${TABLE}: cache rows exist (TRUNCATE ${TABLE} first to roll back)';
       END IF;
     END $guard$;`,
  );
  pgm.dropTable(TABLE);
};
