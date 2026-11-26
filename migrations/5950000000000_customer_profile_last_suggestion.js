/**
 * Complementary suggestions T3 (S6): when the bot last appended a
 * complementary-product line for this sender, so at most one is shown per
 * 24 h across restarts. Additive and nullable (no backfill); the store
 * writes it merge-only (COALESCE) and "olvida mis datos" deletes it with
 * the row.
 *
 * Deploy: before the T3 bot (it selects the column). Rolling the bot back
 * needs no down step (an older bot ignores the column); down drops it,
 * losing only the 24 h marker.
 */
const TABLE = 'customer_profiles';

exports.up = (pgm) => {
  pgm.sql("SET LOCAL lock_timeout = '5s';");
  pgm.addColumn(TABLE, { last_suggestion_at: { type: 'timestamptz' } });
};

exports.down = (pgm) => {
  pgm.sql("SET LOCAL lock_timeout = '5s';");
  pgm.dropColumn(TABLE, 'last_suggestion_at');
};
