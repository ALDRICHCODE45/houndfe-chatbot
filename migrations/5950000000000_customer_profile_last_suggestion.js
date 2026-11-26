/**
 * Complementary suggestions T3 / T3-fix (S6, S7): until when the bot shows
 * this sender no complementary-product line. A shown suggestion pauses it
 * 24 h; a decline («no me ofrezca nada») 30 days. Persisted so the pause
 * survives restarts. Additive and nullable (no backfill); the store writes
 * it merge-only (the latest write wins) and "olvida mis datos" deletes it
 * with the row. (The file name keeps its first, never-deployed column
 * name `last_suggestion_at`; T3-fix replaced it in place.)
 *
 * Strict order — the T3 bot SELECTs this column on every profile read:
 * - Deploy: this migration BEFORE the T3 bot.
 * - Rollback: the bot FIRST, then down (an older bot ignores the column;
 *   down under a running T3 bot would fail every profile read). Down
 *   loses only the pauses.
 */
const TABLE = 'customer_profiles';

exports.up = (pgm) => {
  pgm.sql("SET LOCAL lock_timeout = '5s';");
  pgm.addColumn(TABLE, { suggestions_paused_until: { type: 'timestamptz' } });
};

exports.down = (pgm) => {
  pgm.sql("SET LOCAL lock_timeout = '5s';");
  pgm.dropColumn(TABLE, 'suggestions_paused_until');
};
