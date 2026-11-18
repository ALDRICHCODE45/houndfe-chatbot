/**
 * Human request feed: pay in store templates (odd/tasks/pay-in-store-templates.md
 * S2–S4). The feed adds `sale.pickup_expired_review` (the hold expired with
 * a payment registered and the sale is NOT cancelled).
 *
 *   - decisions: PICKUP_EXPIRED_REVIEW_NOTICE (sent). Every value of 5200's
 *     list stays. Template sends outside the 24 h window reuse the 5200
 *     notice decisions (PICKUP_REMINDER, PICKUP_EXPIRED_NOTICE,
 *     PICKUP_EXTENDED_NOTICE) and a refused template reuses WINDOW_CLOSED.
 *
 * Additive. `down` locks the ledger and refuses while a row uses the new
 * decision (the old CHECK would reject it).
 */
const DELIVERIES = 'human_request_deliveries';
const DECISION_CHECK = `${DELIVERIES}_decision_check`;
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
  'REQUEST_CLOSED',
  'SESSION_STARTED',
  'SESSION_REVERTED',
  'SESSION_ENDED',
  'FAREWELL',
  'RESUME_NOTICE',
  'REASSIGNED_NOTICE',
  'STAFF_MESSAGE',
  'TEMPLATE_SENT',
  'STALE_EPOCH',
  'SESSION_NOT_ACTIVE',
  'MEDIA_NOT_FOUND',
  'SEND_REFUSED',
  'REMINDER_SENT',
  'RESCHEDULE_NOTICE',
  'STALE_SCHEDULE',
  'PICKUP_REMINDER',
  'PICKUP_EXPIRED_NOTICE',
  'PICKUP_EXTENDED_NOTICE',
  'HOLD_SUPERSEDED',
  'SALE_CLOSED',
  'SALE_UNKNOWN',
];
const NEW_DECISIONS = ['PICKUP_EXPIRED_REVIEW_NOTICE'];
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const decisionCheck = (values) =>
  `CHECK (decision IS NULL OR decision IN (${quoted(values)}))`;

exports.up = (pgm) => {
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(
    DELIVERIES,
    DECISION_CHECK,
    decisionCheck([...OLD_DECISIONS, ...NEW_DECISIONS]),
  );
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${DELIVERIES} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${DELIVERIES}
          WHERE decision IN (${quoted(NEW_DECISIONS)})
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} pay in store templates: rows with the expired review decision exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(DELIVERIES, DECISION_CHECK, decisionCheck(OLD_DECISIONS));
};
