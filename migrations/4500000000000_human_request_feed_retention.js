/**
 * Human request feed retention and poison items (docs/human-request-feed.md).
 *
 *   - `human_request_deliveries_purge_idx`: terminal rows (SENT, STALE,
 *     UNKNOWN) in update order, for the maintenance purge (35 days: ACKED
 *     rows are deleted, FAILED_PERMANENT rows lose their payload but keep
 *     their dedup key).
 *   - decision `LOCAL_FAILURE`: a feed item that kept failing locally and was
 *     given up by the consumer.
 *
 * `down` locks the ledger and refuses while a row has decision LOCAL_FAILURE
 * (the old CHECK would reject it).
 */
const DELIVERIES = 'human_request_deliveries';
const CHECK = `${DELIVERIES}_decision_check`;
const OLD_DECISIONS = [
  'LEGACY_PATH_DELIVERS',
  'DUPLICATE',
  'WINDOW_CLOSED',
  'CANCEL_NOTICE',
  'CLARIFICATION',
  'UNKNOWN_TYPE',
  'UNKNOWN_KIND',
  'NO_CONVERSATION',
];
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const decisionCheck = (values) =>
  `CHECK (decision IS NULL OR decision IN (${quoted(values)}))`;

exports.up = (pgm) => {
  pgm.dropConstraint(DELIVERIES, CHECK);
  pgm.addConstraint(
    DELIVERIES,
    CHECK,
    decisionCheck([...OLD_DECISIONS, 'LOCAL_FAILURE']),
  );
  pgm.createIndex(DELIVERIES, ['updated_at'], {
    name: `${DELIVERIES}_purge_idx`,
    where: "local_state IN ('SENT', 'STALE', 'UNKNOWN')",
  });
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${DELIVERIES} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${DELIVERIES} WHERE decision = 'LOCAL_FAILURE') THEN
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} retention: LOCAL_FAILURE rows exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropIndex(DELIVERIES, [], { name: `${DELIVERIES}_purge_idx` });
  pgm.dropConstraint(DELIVERIES, CHECK);
  pgm.addConstraint(DELIVERIES, CHECK, decisionCheck(OLD_DECISIONS));
};
