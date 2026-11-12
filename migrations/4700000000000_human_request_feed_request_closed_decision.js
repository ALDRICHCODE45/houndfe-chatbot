/**
 * Human request feed: `REQUEST_CLOSED` decision.
 *
 *   - decision `REQUEST_CLOSED`: a `request.overdue_notice` not sent because
 *     the bot's registry already has the request CANCELLED or RESOLVED (ACK
 *     STALE, never "sigue pendiente" after the customer was told otherwise).
 *
 * Additive: widens the decision CHECK only. `down` locks the ledger and
 * refuses while a row uses the new decision (the old CHECK would reject it).
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
  'LOCAL_FAILURE',
  'OVERDUE_NOTICE',
  'HUMAN_SESSION',
];
const NEW_DECISIONS = ['REQUEST_CLOSED'];
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const decisionCheck = (values) =>
  `CHECK (decision IS NULL OR decision IN (${quoted(values)}))`;

exports.up = (pgm) => {
  pgm.dropConstraint(DELIVERIES, CHECK);
  pgm.addConstraint(
    DELIVERIES,
    CHECK,
    decisionCheck([...OLD_DECISIONS, ...NEW_DECISIONS]),
  );
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${DELIVERIES} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (SELECT 1 FROM ${DELIVERIES} WHERE decision IN (${quoted(NEW_DECISIONS)})) THEN
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} REQUEST_CLOSED decision: rows exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropConstraint(DELIVERIES, CHECK);
  pgm.addConstraint(DELIVERIES, CHECK, decisionCheck(OLD_DECISIONS));
};
