/**
 * Human request feed: pay in store sale notices (odd/tasks/pay-in-store.md
 * S3; backend docs/chatbot-handoff/pay-in-store-hold-bot-contract.md): the
 * feed carries `sale.pickup_reminder`, `sale.pickup_expired` and
 * `sale.pickup_extended` (requestId null, a saleId).
 *
 *   - decisions: PICKUP_REMINDER, PICKUP_EXPIRED_NOTICE,
 *     PICKUP_EXTENDED_NOTICE (sent), HOLD_SUPERSEDED, SALE_CLOSED,
 *     SALE_UNKNOWN (STALE). Every value of 5000's list stays (WINDOW_CLOSED,
 *     NO_CONVERSATION, HUMAN_SESSION and UNKNOWN_TYPE are reused). The local
 *     states, ACK outcomes and the nullable request_id already cover sale
 *     items, so those columns stay as they are.
 *
 * Additive. `down` locks the ledger and refuses while a row uses a new
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
];
const NEW_DECISIONS = [
  'PICKUP_REMINDER',
  'PICKUP_EXPIRED_NOTICE',
  'PICKUP_EXTENDED_NOTICE',
  'HOLD_SUPERSEDED',
  'SALE_CLOSED',
  'SALE_UNKNOWN',
];
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
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} pay in store: rows with pay in store decisions exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(DELIVERIES, DECISION_CHECK, decisionCheck(OLD_DECISIONS));
};
