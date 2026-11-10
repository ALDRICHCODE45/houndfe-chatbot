/**
 * S6 webhook dedup as a claim with a lease (docs/webhook-dedup.md).
 *
 * The dispatcher now records a message BEFORE processing it: a PROCESSING
 * row with a random `claim_token` and a `lease_expires_at`. Only one of two
 * concurrent Meta deliveries wins the INSERT … ON CONFLICT; an expired
 * claim (crashed process) is taken over by the next redelivery. After the
 * message is handled the row becomes DONE; a failure before any send
 * deletes the claim so the redelivery is processed again.
 *
 * Existing rows (and the receipt admission's single-column marker insert)
 * become DONE through the column default. `seen_at` is the last state
 * change; the purge worker deletes DONE rows and abandoned claims older
 * than 8 days (Meta retries for up to 7) through the `seen_at` index.
 *
 * `down` locks the table and refuses while a claim with a live lease
 * exists (in-flight work). Expired claims were never answered, and the old
 * schema would read them as processed, so `down` deletes them; DONE rows
 * are kept.
 */
const TABLE = 'processed_webhook_messages';
const SEEN_INDEX = 'processed_webhook_messages_seen_at_idx';
const CHECKS = [
  ['status', "status IN ('PROCESSING', 'DONE')"],
  [
    'claim',
    `(status = 'PROCESSING'
        AND claim_token IS NOT NULL AND claimed_at IS NOT NULL
        AND lease_expires_at IS NOT NULL AND lease_expires_at > claimed_at)
     OR (status = 'DONE' AND claim_token IS NULL AND lease_expires_at IS NULL)`,
  ],
];

exports.up = (pgm) => {
  pgm.addColumns(TABLE, {
    status: { type: 'text', notNull: true, default: 'DONE' },
    claim_token: { type: 'uuid' },
    claimed_at: { type: 'timestamptz' },
    lease_expires_at: { type: 'timestamptz' },
  });
  for (const [name, check] of CHECKS) {
    pgm.addConstraint(TABLE, `${TABLE}_${name}_check`, `CHECK (${check})`);
  }
  pgm.createIndex(TABLE, 'seen_at', { name: SEEN_INDEX });
};

exports.down = (pgm) => {
  // Normal node-pg-migrate transaction holds this lock through guard + rewrite.
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${TABLE}
          WHERE status = 'PROCESSING' AND lease_expires_at > now()
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${TABLE} claims: a live claim is being processed';
       END IF;
     END $guard$;`,
  );
  pgm.sql(`DELETE FROM ${TABLE} WHERE status = 'PROCESSING';`);
  pgm.dropIndex(TABLE, 'seen_at', { name: SEEN_INDEX });
  for (const [name] of CHECKS) {
    pgm.dropConstraint(TABLE, `${TABLE}_${name}_check`);
  }
  pgm.dropColumns(TABLE, [
    'status',
    'claim_token',
    'claimed_at',
    'lease_expires_at',
  ]);
};
