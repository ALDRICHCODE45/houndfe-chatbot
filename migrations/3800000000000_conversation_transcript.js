/**
 * S1 durable transcript (human-intervention prerequisites T1): one row per
 * customer inbound and bot outbound WhatsApp message, deduplicated by the
 * WhatsApp message id (inbound wamid or the outbound id Meta returned).
 * Media is a provider reference only, never bytes. Every row carries its
 * own purge time (observed_at + 12 months, computed by the app) and a
 * background worker deletes due rows in batches. No backfill: the
 * transcript starts with the messages seen after this migration.
 */
const TABLE = 'conversation_messages';

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    id: {
      type: 'bigint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'ALWAYS' },
    },
    sender_id: { type: 'text', notNull: true, collation: '"C"' },
    wa_message_id: { type: 'text', notNull: true, unique: true },
    direction: { type: 'text', notNull: true },
    author: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    text: { type: 'text' },
    media: { type: 'jsonb' },
    details: { type: 'jsonb' },
    provider_timestamp: { type: 'timestamptz' },
    observed_at: { type: 'timestamptz', notNull: true },
    purge_after: { type: 'timestamptz', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  const checks = [
    ['sender', "sender_id ~ '^[0-9]{6,20}$'"],
    ['wa_message_id', 'char_length(wa_message_id) BETWEEN 1 AND 256'],
    ['direction', "direction IN ('IN', 'OUT')"],
    // STAFF is reserved for the live human conversation.
    ['author', "author IN ('CUSTOMER', 'BOT', 'STAFF')"],
    ['type', "type ~ '^[a-z_]{1,32}$'"],
    ['text', 'text IS NULL OR char_length(text) <= 16384'],
    ['media', "media IS NULL OR jsonb_typeof(media) = 'object'"],
    ['media_size', 'media IS NULL OR octet_length(media::text) <= 8192'],
    ['details', "details IS NULL OR jsonb_typeof(details) = 'object'"],
    ['details_size', 'details IS NULL OR octet_length(details::text) <= 8192'],
    ['purge_after', 'purge_after > observed_at'],
  ];
  for (const [name, definition] of checks)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
  pgm.createIndex(TABLE, ['sender_id', 'observed_at']);
  pgm.createIndex(TABLE, ['purge_after']);
};

exports.down = (pgm) => {
  pgm.dropTable(TABLE);
};
