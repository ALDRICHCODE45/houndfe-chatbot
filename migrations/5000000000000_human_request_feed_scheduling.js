/**
 * Human request feed: scheduled conversations (backend unit 14,
 * houndfe-backend docs/chatbot-handoff/chatbot-requests-bot-contract.md
 * "Scheduled conversations"): the feed now carries
 * `conversation.scheduled_reminder` and `conversation.rescheduled`.
 *
 *   - decisions: REMINDER_SENT, RESCHEDULE_NOTICE, STALE_SCHEDULE. Every value
 *     of 4900's list stays (4600's HUMAN_SESSION / 4700's REQUEST_CLOSED are
 *     reused for a HUMAN chat / a closed request, WINDOW_CLOSED for a closed
 *     window). The local states and ACK outcomes already cover these items
 *     (SENT, STALE, UNKNOWN), so those CHECKs stay as they are.
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
];
const NEW_DECISIONS = ['REMINDER_SENT', 'RESCHEDULE_NOTICE', 'STALE_SCHEDULE'];
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
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} scheduling: rows with scheduling decisions exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(DELIVERIES, DECISION_CHECK, decisionCheck(OLD_DECISIONS));
};
