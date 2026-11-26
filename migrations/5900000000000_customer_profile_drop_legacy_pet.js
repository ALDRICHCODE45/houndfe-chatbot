/**
 * Multi-pet profiles T6d (S2): drops the legacy single `pet` object column
 * of customer_profiles. Pets live in the backend (Customer → pets) and, for
 * prospects, in the local `pets` list (migration 5700); since T6b no code
 * reads or writes `pet`. Production had no legacy pet when this was written
 * (task log L38), so nothing is migrated: the guard refuses the drop while
 * any row still holds one, so an unexpected legacy pet blocks the deploy
 * instead of being lost.
 *
 * Deploy: run with the T6b bot. Rolling the bot back below T6b needs this
 * down step first (an older bot selects `pet`); down re-adds the column
 * empty, with the CHECKs of migration 3700.
 */
const TABLE = 'customer_profiles';
const CHECKS = [
  ['pet', "pet IS NULL OR jsonb_typeof(pet) = 'object'"],
  ['pet_size', 'pet IS NULL OR octet_length(pet::text) <= 4096'],
];

exports.up = (pgm) => {
  // Fail fast if a long transaction holds the table: the deploy stops
  // instead of queueing every live profile read and write behind the lock.
  pgm.sql("SET LOCAL lock_timeout = '5s';");
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}
                   WHERE pet IS NOT NULL) THEN
         RAISE EXCEPTION 'refusing to drop ${TABLE}.pet: legacy pets exist';
       END IF;
     END $guard$;`,
  );
  // Its CHECK constraints go with the column.
  pgm.dropColumn(TABLE, 'pet');
};

exports.down = (pgm) => {
  // The rollback path fails fast on a held lock too (review R4).
  pgm.sql("SET LOCAL lock_timeout = '5s';");
  pgm.addColumn(TABLE, { pet: { type: 'jsonb' } });
  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
};
