/**
 * node-pg-migrate up/down for the durable conversation store.
 *
 * Creates the single table backing PostgresConversationStore.
 * PK lookups only — no GIN on `data` because no JSONB queries are issued.
 * `timestamptz` for last_message_at with ms precision (JS Date ⊆ PG µs).
 * `data jsonb` defaulted to '{}' so legacy / first-write rows are valid.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('conversation_state', {
    sender_id: { type: 'text', primaryKey: true },
    last_message_at: { type: 'timestamptz', notNull: true },
    data: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'{}'::jsonb"),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('conversation_state');
};