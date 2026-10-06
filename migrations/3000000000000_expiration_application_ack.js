/** Add inert reporting-ACK storage without rewriting application snapshots.
 * SQL proves exact identity/outcome binding and five-key shape only. The domain
 * validates server timestamp semantics; a future trusted adapter must prove
 * provenance and exact-row/absent-ACK CAS. No send, closure, retry, immutability
 * trigger or runtime wiring is introduced. Original timestamp spelling stays
 * in JSONB, not timestamptz. Deploy-time migration execution remains separate.
 */
const TABLE = 'expiration_application_ledger';
const CHECK = `${TABLE}_ack_check`;
const KEYS = "ARRAY['id', 'version', 'attemptId', 'outcome', 'ackReceivedAt']";
const TERMINAL = "('PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'STALE')";
const ACK = `(
  ack_receipt IS NULL OR (
    jsonb_typeof(ack_receipt) = 'object'
    AND ack_receipt ?& ${KEYS}
    AND ack_receipt - ${KEYS} = '{}'::jsonb
    AND ${['id', 'attemptId', 'outcome', 'ackReceivedAt']
      .map((field) => `jsonb_typeof(ack_receipt -> '${field}') = 'string'`)
      .join(' AND ')}
    AND ack_receipt -> 'version' = '2'::jsonb
    AND ack_receipt ->> 'id' = decision_id::text
    AND ack_receipt ->> 'attemptId' = attempt_id::text
    AND row_data ->> 'state' IN ${TERMINAL}
    AND ack_receipt ->> 'outcome' = row_data ->> 'state'
  )
) IS TRUE`;

exports.up = (pgm) => {
  pgm.addColumns(TABLE, { ack_receipt: { type: 'jsonb' } });
  pgm.addConstraint(TABLE, CHECK, `CHECK (${ACK})`);
};

exports.down = (pgm) => {
  // The normal migration transaction holds this lock through column removal;
  // otherwise an ACK writer could race the no-evidence check.
  pgm.sql(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${TABLE} WHERE ack_receipt IS NOT NULL) THEN
         RAISE EXCEPTION 'refusing to roll back expiration ACK storage: evidence exists';
       END IF;
     END $guard$;`,
  );
  pgm.dropConstraint(TABLE, CHECK);
  pgm.dropColumns(TABLE, ['ack_receipt']);
};
