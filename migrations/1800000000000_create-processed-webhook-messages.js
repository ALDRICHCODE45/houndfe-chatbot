/**
 * node-pg-migrate up/down for the webhook dedup store.
 *
 * One row per successfully processed inbound `message.id`. Meta Cloud API
 * re-delivers webhook events on delivery failure (exponential backoff over
 * ~24h); the dispatcher checks this table before processing so a
 * re-delivered message is never answered twice.
 *
 * PK-only lookups (`isDuplicate`) and `INSERT ... ON CONFLICT DO NOTHING`
 * (`markSeen`) — no secondary index required. Rows are intentionally never
 * deleted in v1: volume is tiny (one row per inbound message) and a
 * permanent record makes the dedup immune to the 24h+ retry window.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('processed_webhook_messages', {
    message_id: { type: 'text', primaryKey: true },
    seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('processed_webhook_messages');
};
