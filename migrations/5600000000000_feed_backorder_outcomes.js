/**
 * Human request feed: restock backorder notices (odd/tasks/restock-backorder.md
 * T5a; docs/human-request-feed.md "Restock backorder items").
 *
 *   - `ack_outcome`: PROVIDER_REJECTED joins the list (terminal, backorder
 *     items only: reserved / reminder notices the bot cannot deliver, so the
 *     backend alerts staff to call the customer).
 *   - `ack_reason`: nullable text, 1-280 chars, the `reason` of that ACK
 *     (replayed with the same body until the backend answers). Only a
 *     PROVIDER_REJECTED outcome carries one, and it always does.
 *   - decisions: BACKORDER_RESERVED_NOTICE, BACKORDER_REMINDER_NOTICE,
 *     BACKORDER_EXPIRED_NOTICE, BACKORDER_LOST_NOTICE,
 *     BACKORDER_CANCELLED_NOTICE, BACKORDER_ETA_PENDING,
 *     BACKORDER_PAYLOAD_INVALID, BACKORDER_OVERTAKEN, TEMPLATE_NOT_APPROVED.
 *     Every value of 5300's list stays (HUMAN_SESSION, WINDOW_CLOSED,
 *     NO_CONVERSATION, SEND_REFUSED and UNKNOWN_TYPE are reused).
 *
 * Additive. `down` locks the ledger and refuses while a row uses a new
 * decision or the new outcome (the old CHECKs would reject them), then drops
 * the column.
 */
const DELIVERIES = 'human_request_deliveries';
const DECISION_CHECK = `${DELIVERIES}_decision_check`;
const OUTCOME_CHECK = `${DELIVERIES}_ack_outcome_check`;
const REASON_CHECK = `${DELIVERIES}_ack_reason_check`;
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
  'PICKUP_EXPIRED_REVIEW_NOTICE',
];
const NEW_DECISIONS = [
  'BACKORDER_RESERVED_NOTICE',
  'BACKORDER_REMINDER_NOTICE',
  'BACKORDER_EXPIRED_NOTICE',
  'BACKORDER_LOST_NOTICE',
  'BACKORDER_CANCELLED_NOTICE',
  'BACKORDER_ETA_PENDING',
  'BACKORDER_PAYLOAD_INVALID',
  'BACKORDER_OVERTAKEN',
  'TEMPLATE_NOT_APPROVED',
];
const OLD_OUTCOMES = [
  'PROVIDER_ACCEPTED',
  'DELIVERY_UNKNOWN',
  'DEFERRED_WINDOW_CLOSED',
  'DEFERRED_HUMAN_SESSION',
  'STALE',
];
const NEW_OUTCOMES = ['PROVIDER_REJECTED'];
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const decisionCheck = (values) =>
  `CHECK (decision IS NULL OR decision IN (${quoted(values)}))`;
const outcomeCheck = (values) =>
  `CHECK (ack_outcome IS NULL OR ack_outcome IN (${quoted(values)}))`;

exports.up = (pgm) => {
  pgm.addColumn(DELIVERIES, { ack_reason: { type: 'text' } });
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(
    DELIVERIES,
    DECISION_CHECK,
    decisionCheck([...OLD_DECISIONS, ...NEW_DECISIONS]),
  );
  pgm.dropConstraint(DELIVERIES, OUTCOME_CHECK);
  pgm.addConstraint(
    DELIVERIES,
    OUTCOME_CHECK,
    outcomeCheck([...OLD_OUTCOMES, ...NEW_OUTCOMES]),
  );
  // The reason belongs to PROVIDER_REJECTED, and that outcome always has one.
  pgm.addConstraint(
    DELIVERIES,
    REASON_CHECK,
    `CHECK (
       (ack_outcome IS DISTINCT FROM 'PROVIDER_REJECTED' AND ack_reason IS NULL)
       OR (ack_outcome = 'PROVIDER_REJECTED'
           AND ack_reason IS NOT NULL
           AND char_length(ack_reason) BETWEEN 1 AND 280)
     )`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`LOCK TABLE ${DELIVERIES} IN ACCESS EXCLUSIVE MODE;`);
  pgm.sql(
    `DO $guard$ BEGIN
       IF EXISTS (
         SELECT 1 FROM ${DELIVERIES}
          WHERE decision IN (${quoted(NEW_DECISIONS)})
             OR ack_outcome IN (${quoted(NEW_OUTCOMES)})
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} backorder outcomes: rows with a backorder decision or a PROVIDER_REJECTED outcome exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropConstraint(DELIVERIES, REASON_CHECK);
  pgm.dropConstraint(DELIVERIES, OUTCOME_CHECK);
  pgm.addConstraint(DELIVERIES, OUTCOME_CHECK, outcomeCheck(OLD_OUTCOMES));
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(DELIVERIES, DECISION_CHECK, decisionCheck(OLD_DECISIONS));
  pgm.dropColumn(DELIVERIES, 'ack_reason');
};
