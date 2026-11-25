/**
 * Multi-pet profiles T4b (S8): a prospect's LOCAL pet list, one JSONB array
 * per WhatsApp sender, uploaded to the backend (Customer → pets) once the
 * sender is a Customer and removed locally after each successful upload.
 * Additive: the legacy single `pet` object column is NOT touched (T6 moves
 * it to the backend). NULL means no local pets.
 */
const TABLE = 'customer_profiles';
const CHECKS = [
  ['pets', "pets IS NULL OR jsonb_typeof(pets) = 'array'"],
  // 20 pets of a few hundred bytes each, with room for the upload body.
  ['pets_size', 'pets IS NULL OR octet_length(pets::text) <= 32768'],
];

exports.up = (pgm) => {
  pgm.addColumn(TABLE, { pets: { type: 'jsonb' } });
  for (const [name, definition] of CHECKS)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
};

exports.down = (pgm) => {
  // Same guard as the other ledgers: never drop pets not yet uploaded.
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE}
                   WHERE pets IS NOT NULL AND jsonb_array_length(pets) > 0) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE}.pets: local pets exist';
       END IF;
     END $guard$;`,
  );
  for (const [name] of [...CHECKS].reverse())
    pgm.dropConstraint(TABLE, `${TABLE}_${name}_check`);
  pgm.dropColumn(TABLE, 'pets');
};
