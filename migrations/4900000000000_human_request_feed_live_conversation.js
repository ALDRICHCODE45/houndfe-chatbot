/**
 * Human request feed: live conversation items (backend unit 11,
 * houndfe-backend docs/chatbot-handoff/chatbot-requests-bot-contract.md
 * "Live conversation").
 *
 *   - column `message_id`: the dedupe key of a `conversation.staff_message` /
 *     `template.requested` item (`payload.messageId`), stored in the same
 *     INSERT as the ledger row, i.e. before any Meta call (contract rule 4:
 *     "de-duplicate by deliveryId and messageId"). A real column, not an
 *     index on `payload->>'messageId'`, because the retention scrub replaces
 *     the payload of FAILED_PERMANENT rows and the key must survive it.
 *   - unique partial index on `message_id` (NULL for every other item type
 *     and for the duplicate rows the store records without the key).
 *   - decisions: SESSION_STARTED, SESSION_REVERTED, SESSION_ENDED, FAREWELL,
 *     RESUME_NOTICE, REASSIGNED_NOTICE, STAFF_MESSAGE, TEMPLATE_SENT,
 *     STALE_EPOCH, SESSION_NOT_ACTIVE, MEDIA_NOT_FOUND, SEND_REFUSED. The
 *     local states and ACK outcomes already cover the live items (SENT,
 *     STALE, UNKNOWN, DEFERRED_WINDOW), so those CHECKs stay as they are.
 *
 * Additive. `down` locks the ledger and refuses while a row uses a new
 * decision (the old CHECK would reject it) or holds a `message_id` (dropping
 * the column would lose the dedupe key of a message already handled).
 */
const DELIVERIES = 'human_request_deliveries';
const DECISION_CHECK = `${DELIVERIES}_decision_check`;
const MESSAGE_ID_CHECK = `${DELIVERIES}_message_id_check`;
const MESSAGE_ID_INDEX = `${DELIVERIES}_message_id_uidx`;
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
];
const NEW_DECISIONS = [
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
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const decisionCheck = (values) =>
  `CHECK (decision IS NULL OR decision IN (${quoted(values)}))`;

exports.up = (pgm) => {
  pgm.addColumn(DELIVERIES, {
    message_id: { type: 'text', collation: '"C"' },
  });
  pgm.addConstraint(
    DELIVERIES,
    MESSAGE_ID_CHECK,
    'CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 200)',
  );
  pgm.createIndex(DELIVERIES, ['message_id'], {
    name: MESSAGE_ID_INDEX,
    unique: true,
    where: 'message_id IS NOT NULL',
  });
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
          WHERE decision IN (${quoted(NEW_DECISIONS)}) OR message_id IS NOT NULL
       ) THEN
         RAISE EXCEPTION 'refusing to roll back ${DELIVERIES} live conversation: rows with live decisions or a message_id exist';
       END IF;
     END $guard$;`,
  );
  pgm.dropIndex(DELIVERIES, [], { name: MESSAGE_ID_INDEX });
  pgm.dropConstraint(DELIVERIES, MESSAGE_ID_CHECK);
  pgm.dropColumn(DELIVERIES, 'message_id');
  pgm.dropConstraint(DELIVERIES, DECISION_CHECK);
  pgm.addConstraint(DELIVERIES, DECISION_CHECK, decisionCheck(OLD_DECISIONS));
};
