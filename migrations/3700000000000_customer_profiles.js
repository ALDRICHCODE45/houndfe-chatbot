/**
 * S1 persistent customer memory (first-class roadmap T4): one row per
 * WhatsApp sender with how to address them (names, usted/tú, emojis, tone),
 * their pet facts (JSONB) and a pointer to their last order (folio, date,
 * total — the order itself stays in the backend). Additive, no backfill.
 *
 * Upserts are merge-only (COALESCE per column, JSONB concat for pet); the
 * only way to drop a profile is the customer's "olvida mis datos".
 */
const TABLE = 'customer_profiles';

exports.up = (pgm) => {
  pgm.createTable(TABLE, {
    sender_id: { type: 'text', primaryKey: true, collation: '"C"' },
    display_name: { type: 'text' },
    preferred_name: { type: 'text' },
    register: { type: 'text', notNull: true, default: 'usted' },
    emojis: { type: 'boolean', notNull: true, default: false },
    tone: { type: 'text', notNull: true, default: 'neutral' },
    pet: { type: 'jsonb' },
    last_order_folio: { type: 'text' },
    last_order_confirmed_at: { type: 'timestamptz' },
    last_order_total_cents: { type: 'bigint' },
    created_at: { type: 'timestamptz', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true },
  });
  const checks = [
    ['sender', "sender_id ~ '^[0-9]{6,20}$'"],
    ['register', "register IN ('usted', 'tu')"],
    ['tone', "tone IN ('formal', 'neutral', 'casual')"],
    [
      'display_name',
      'display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 60',
    ],
    [
      'preferred_name',
      'preferred_name IS NULL OR char_length(preferred_name) BETWEEN 1 AND 40',
    ],
    ['pet', "pet IS NULL OR jsonb_typeof(pet) = 'object'"],
    ['pet_size', 'pet IS NULL OR octet_length(pet::text) <= 4096'],
    // The last-order pointer is all or nothing.
    [
      'last_order',
      `(last_order_folio IS NULL AND last_order_confirmed_at IS NULL AND last_order_total_cents IS NULL)
       OR (last_order_folio IS NOT NULL AND char_length(last_order_folio) BETWEEN 1 AND 40
           AND last_order_confirmed_at IS NOT NULL
           AND last_order_total_cents IS NOT NULL AND last_order_total_cents >= 0)`,
    ],
  ];
  for (const [name, definition] of checks)
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${definition})`);
};

exports.down = (pgm) => {
  // Same guard as the human-decision ledgers: never drop live data.
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
