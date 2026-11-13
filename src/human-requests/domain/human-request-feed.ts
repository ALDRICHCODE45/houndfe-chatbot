import type {
  DeliveryOutcome,
  DeliveryOutcomeInput,
  FeedItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import {
  applyCustomerStyle,
  type CustomerStyle,
} from '../../customer-profile/domain/notice-style';

/**
 * Human request feed consumer (backend unit 5b,
 * docs/contracts/human-intervention-bot-contract-5b.md): the local delivery
 * ledger, the request registry and the pure rules shared by the consumer, the
 * replay paths and the ACK sweeper. See docs/human-request-feed.md.
 */

export const HUMAN_REQUEST_FEED_STORE = Symbol('HUMAN_REQUEST_FEED_STORE');

/** The single cursor row and the advisory lock key both use this name. */
export const FEED_CONSUMER_NAME = 'human_request_feed:consumer';
/** Cursor-table row holding the consumer's synced_at (canonical UTC ms in
 *  the `cursor` column), written in the same statement as the cursor. */
export const FEED_SYNCED_AT_NAME = 'human_request_feed:consumer:synced_at';

export type DeliveryLocalState =
  | 'RECEIVED'
  | 'SENDING'
  | 'SENT'
  | 'STALE'
  | 'UNKNOWN'
  | 'DEFERRED_WINDOW'
  | 'HELD_HUMAN';

export type DeliveryDecision =
  /** L4: wrapped decisions are delivered by the legacy poll paths. */
  | 'LEGACY_PATH_DELIVERS'
  | 'DUPLICATE'
  | 'WINDOW_CLOSED'
  | 'CANCEL_NOTICE'
  | 'CLARIFICATION'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_KIND'
  | 'NO_CONVERSATION'
  /** request.overdue_notice sent to the customer (4600). */
  | 'OVERDUE_NOTICE'
  /** request.overdue_notice not sent: the conversation is in a human
   *  session (4600). */
  | 'HUMAN_SESSION'
  /** request.overdue_notice not sent: the bot's registry already has the
   *  request CANCELLED or RESOLVED (4700). */
  | 'REQUEST_CLOSED'
  /** A feed item that kept failing locally and was given up (poison item). */
  | 'LOCAL_FAILURE'
  // ---- live conversation (unit 11, migration 4900) ----
  /** conversation.started: durable HUMAN taken, session-ack STARTED sent;
   *  the ACK outcome says whether the greeting went out. */
  | 'SESSION_STARTED'
  /** conversation.ended START_TIMEOUT: back to BOT, nothing sent (STALE). */
  | 'SESSION_REVERTED'
  /** conversation.ended applied without a farewell (farewell false, window
   *  closed, or a reconcile): durable BOT, ACK STALE. */
  | 'SESSION_ENDED'
  /** conversation.ended: the farewell was sent. */
  | 'FAREWELL'
  /** conversation.ended START_TIMEOUT: the resume notice was sent. */
  | 'RESUME_NOTICE'
  /** conversation.reassigned: the "Ahora le atiende ..." notice was sent. */
  | 'REASSIGNED_NOTICE'
  /** conversation.staff_message relayed to the customer. */
  | 'STAFF_MESSAGE'
  /** template.requested: the approved template was sent. */
  | 'TEMPLATE_SENT'
  /** A live item of an epoch that is not the conversation's current HUMAN
   *  epoch (or a 409 STALE_EPOCH on the session-ack): STALE. */
  | 'STALE_EPOCH'
  /** Same epoch but the session is over (mode BOT): not sent, STALE. */
  | 'SESSION_NOT_ACTIVE'
  /** conversation.staff_message media: GET /media/:id answered 404 (STALE). */
  | 'MEDIA_NOT_FOUND'
  /** A live message Meta refused synchronously (definite, nothing sent):
   *  STALE. Never used for an uncertain send (that is UNKNOWN). */
  | 'SEND_REFUSED';

export type AckState = 'PENDING' | 'ACKED' | 'FAILED_PERMANENT';

/** One ledger row (`human_request_deliveries`). `item` is the whole parsed
 *  feed item (stored in the `payload` column), so a replay re-handles it
 *  without the backend. */
export interface DeliveryRow {
  deliveryId: string;
  cursor: string;
  type: string;
  requestId: string | null;
  conversationRef: string | null;
  item: FeedItem;
  /** Dedupe key of a staff message / template (`payload.messageId`), stored
   *  with the row before any Meta call and kept when the payload is purged.
   *  `null`: other items, or a duplicate of a messageId another delivery
   *  already owns (see `duplicateOf` of `insertDelivery`). */
  messageId: string | null;
  localState: DeliveryLocalState;
  decision: DeliveryDecision | null;
  attemptId: string | null;
  providerMessageId: string | null;
  /** Canonical UTC ms (`YYYY-MM-DDTHH:mm:ss.sssZ`), the ACK's `attemptedAt`. */
  attemptedAt: string | null;
  /** `null`: no ACK owed for the current attempt. */
  ackState: AckState | null;
  ackOutcome: DeliveryOutcome | null;
  ackAttempts: number;
  nextAckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Full overwrite of the mutable attempt fields; `ack` set → a new PENDING
 *  ACK due now (attempt counter reset), `null` → no ACK owed. */
export interface DeliveryTransition {
  localState: DeliveryLocalState;
  decision: DeliveryDecision | null;
  attemptId: string;
  attemptedAt: string | null;
  providerMessageId: string | null;
  ack: DeliveryOutcome | null;
}

/** Compare-and-set guard: the row must still be in this state and attempt. */
export interface DeliveryExpectation {
  localState: DeliveryLocalState;
  attemptId: string | null;
}

export type AckCompletion =
  | { ackState: 'ACKED' }
  | { ackState: 'FAILED_PERMANENT'; error: string }
  | { ackState: 'PENDING'; retryAt: Date; error: string }
  /** Drops the owed ACK; the row keeps its local state. */
  | { ackState: null };

export type HumanRequestStatus = 'OPEN' | 'CANCELLED' | 'RESOLVED';

export interface HumanRequestRecord {
  requestId: string;
  conversationRef: string;
  subtype: string;
  legacyId: string | null;
  status: HumanRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenHumanRequestInput {
  requestId: string;
  conversationRef: string;
  subtype: string;
  legacyId?: string | null;
}

export interface InsertDeliveryResult {
  row: DeliveryRow;
  inserted: boolean;
  /** deliveryId owning the item's `messageId`, when it is not this one. */
  duplicateOf?: string;
}

/** The `messageId` dedupe key of a feed item (staff message, template). */
export function messageIdOf(item: FeedItem): string | null {
  return item.type === 'conversation.staff_message' ||
    item.type === 'template.requested'
    ? item.payload.messageId
    : null;
}

/** Durable state of the feed consumer. Every write is a single atomic
 *  statement; ledger transitions are compare-and-set so two actors (the
 *  consumer, a replay, the sweeper) never both claim one send. */
export interface HumanRequestFeedStore {
  /** `null`: start from the oldest retained item. */
  readCursor(): Promise<string | null>;
  /** With `syncedAt` (canonical UTC ms: the last instant the local state
   *  was complete), both are saved atomically; without it the stored
   *  synced_at is kept. */
  saveCursor(cursor: string | null, syncedAt?: string): Promise<void>;
  /** `null` when unknown (never saved). */
  readSyncedAt(): Promise<string | null>;

  /** Inserts the item as RECEIVED unless its `deliveryId` exists; returns the
   *  stored row either way (an existing row is never overwritten).
   *
   *  A staff message / template also de-duplicates by `messageId`: when
   *  another delivery already owns that messageId the item is still stored
   *  (it needs its own ACK; `messageId` null on the row) and the owner's
   *  deliveryId is reported in `duplicateOf` (only on that first insert; a
   *  replay of the duplicate's deliveryId is a plain `inserted: false`).
   *  The caller must not send a `duplicateOf` item. */
  insertDelivery(item: FeedItem): Promise<InsertDeliveryResult>;
  getDelivery(deliveryId: string): Promise<DeliveryRow | null>;
  /** `null` when the row moved on (another actor won). */
  transition(
    deliveryId: string,
    expected: DeliveryExpectation,
    next: DeliveryTransition,
  ): Promise<DeliveryRow | null>;
  /** Applies only while the row is still PENDING for this attempt. */
  completeAck(
    deliveryId: string,
    attemptId: string,
    completion: AckCompletion,
  ): Promise<boolean>;
  listDueAcks(now: Date, limit: number): Promise<DeliveryRow[]>;
  /** HELD_HUMAN rows, least recently checked first. */
  listHeld(filter: {
    conversationRef?: string;
    limit: number;
  }): Promise<DeliveryRow[]>;
  /** Marks a held row as checked (moves it behind the other held rows);
   *  applies only while the row is still HELD_HUMAN for this attempt. */
  touchHeld(deliveryId: string, attemptId: string | null): Promise<void>;
  listDeferredWindow(filter: {
    conversationRef: string;
    limit: number;
  }): Promise<DeliveryRow[]>;
  /** Retention: terminal rows (SENT, STALE, UNKNOWN) last updated before
   *  `before`, at most `limit` of each kind: ACKED rows are deleted;
   *  FAILED_PERMANENT rows keep their dedup key and ACK evidence but lose the
   *  payload. Rows owing work are never touched. */
  purgeTerminal(
    before: Date,
    limit: number,
  ): Promise<{ deleted: number; scrubbed: number }>;
  /** SENDING rows whose attempt started before `before` (crash leftovers). */
  listStuckSending(before: Date, limit: number): Promise<DeliveryRow[]>;

  /** Idempotent: an existing request row is left as is. */
  recordOpenRequest(input: OpenHumanRequestInput): Promise<void>;
  /** OPEN → status; `false` when there is no OPEN row. */
  closeRequest(
    requestId: string,
    status: Exclude<HumanRequestStatus, 'OPEN'>,
  ): Promise<boolean>;
  getRequest(requestId: string): Promise<HumanRequestRecord | null>;
  /** Ids of OPEN registry rows created before `createdBefore`. */
  listOpenRequestIds(createdBefore: Date): Promise<string[]>;
}

/** Advisory lock held on a dedicated connection while consuming. */
export interface FeedConsumerLock {
  tryAcquire(): Promise<boolean>;
  /** `false` once the lock connection is gone (the lock is lost). */
  isHeld(): Promise<boolean>;
  release(): Promise<void>;
}

// ---------------------------------------------------------------- copy

export const TEAM_PREFIX = 'Le comparto la respuesta del equipo:';
export const CANCEL_NOTICE =
  'El equipo cerró su consulta. Si necesita algo más, escríbame por aquí.';
/** request.overdue_notice: told once; the request stays open. */
export const OVERDUE_NOTICE =
  'Todavía no tengo respuesta del equipo; sigue pendiente y le aviso en cuanto la tenga.';

// Live conversation (unit 11) customer notices, S5 (owner-approved usted
// copy; the tú variants are curated pairs in `customer-style.ts`). `{nombre}`
// is replaced AFTER styling, so the staff name is never rewritten.
export const LIVE_NAME_PLACEHOLDER = '{nombre}';
export const LIVE_GREETING = 'Le atiende {nombre} del equipo HoundFe.';
export const LIVE_GREETING_NO_NAME =
  'Le atiende una persona del equipo HoundFe.';
export const LIVE_REASSIGNED = 'Ahora le atiende {nombre}, del equipo HoundFe.';
export const LIVE_REASSIGNED_NO_NAME =
  'Ahora le atiende otra persona del equipo HoundFe.';
export const LIVE_FAREWELL =
  'Listo, terminó la atención con el equipo. Si necesita algo más, aquí sigo para ayudarle.';
export const LIVE_RESUME = 'Seguimos por aquí, ¿en qué le ayudo?';

/** A live notice in the customer's style; `name` null/blank → `noName`. */
export function liveNotice(
  withName: string,
  noName: string,
  name: string | null,
  style: CustomerStyle | null,
): string {
  const trimmed = name?.trim() ?? '';
  if (trimmed === '') return styleFixedCopy(noName, style);
  return styleFixedCopy(withName, style).replace(
    LIVE_NAME_PLACEHOLDER,
    () => trimmed,
  );
}

/** Fixed usted copy in the customer's stored style (usted when unknown);
 *  the tú variants are whole-sentence curated pairs in `customer-style.ts`. */
export function styleFixedCopy(
  usted: string,
  style: CustomerStyle | null,
): string {
  return style === null ? usted : applyCustomerStyle(usted, style);
}

/** Styled prefix + staff text verbatim (never restyled). */
export function withTeamPrefix(
  text: string,
  prefix: string | null,
  style: CustomerStyle | null,
): string {
  return `${styleFixedCopy(prefix ?? TEAM_PREFIX, style)}\n${text}`;
}

// ---------------------------------------------------------------- refs

const CONVERSATION_REF = /^wa:([0-9]{6,20})$/;

/** The WhatsApp recipient of `wa:<wa_id>`; null when absent or malformed. */
export function senderIdFromRef(ref: string | null): string | null {
  if (ref === null) return null;
  return CONVERSATION_REF.exec(ref)?.[1] ?? null;
}

/** `wa:5215550001111` → `wa:…1111`: logs keep only the last 4 digits. */
export function maskConversationRef(ref: string | null): string {
  if (ref === null) return '(no conversation)';
  const digits = ref.replace(/[^0-9]/g, '');
  return `wa:…${digits.slice(-4)}`;
}

/** Ledger payload of a purged FAILED_PERMANENT row: the customer text is
 *  gone, the row still de-duplicates its deliveryId. */
export const purgedItem = (
  deliveryId: string,
  cursor: string,
  type: string,
): FeedItem => ({
  type: 'unknown',
  rawType: type,
  cursor,
  deliveryId,
  raw: { purged: true },
});

/** Ledger rows are purged this long after their last update (the backend
 *  keeps feed items 30 days, so a later re-read is impossible). */
export const LEDGER_RETENTION_MS = 35 * 24 * 3_600_000;

// ---------------------------------------------------------------- Meta

/** Meta's re-engagement error: the 24 h customer service window is closed. */
export const META_WINDOW_CLOSED_CODE = 131047;

/** How the WhatsApp sender surfaces a rejection (`WhatsappSendError`). */
export function isWindowClosedSendError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { graphErrorCode?: unknown }).graphErrorCode;
  return Number(code) === META_WINDOW_CLOSED_CODE;
}

/** What a failed live relay send (staff message / template) means. */
export type RelaySendFailure =
  /** 131047 on the send: the 24 h window is closed (nothing sent). */
  | 'WINDOW_CLOSED'
  /** Definite non-send: the upload failed, Meta refused the request
   *  synchronously (4xx) or the sender rejected it locally. */
  | 'REFUSED'
  /** The send request may or may not have reached Meta. */
  | 'UNCERTAIN';

/**
 * Classifies a sender error by its shape (`WhatsappSendError`:
 * `status`, `graphErrorCode`, `stage`; `UnsupportedOutboundError` and
 * `InvalidOutboundTemplateError` are local rejections before any request).
 * Uncertain is the default: a send is never assumed not to have happened
 * without evidence (an upload-stage failure, a 4xx answer, a local check).
 */
export function classifyRelaySendError(error: unknown): RelaySendFailure {
  if (typeof error !== 'object' || error === null) return 'UNCERTAIN';
  const { name, stage, status } = error as {
    name?: unknown;
    stage?: unknown;
    status?: unknown;
  };
  if (name === 'UnsupportedOutboundError') return 'REFUSED';
  if (name === 'InvalidOutboundTemplateError') return 'REFUSED';
  if (name !== 'WhatsappSendError') return 'UNCERTAIN';
  // Nothing reached the customer, whatever the status (even a 5xx or none).
  if (stage === 'upload') return 'REFUSED';
  if (isWindowClosedSendError(error)) return 'WINDOW_CLOSED';
  // 408 is a timeout: Meta may still have accepted the message.
  if (typeof status === 'number' && status >= 400 && status < 500)
    return status === 408 ? 'UNCERTAIN' : 'REFUSED';
  return 'UNCERTAIN';
}

// ---------------------------------------------------------------- ACK

/** The exact outcome body of the row's current attempt (replayed verbatim
 *  until the backend answers). */
export function ackBodyFor(row: DeliveryRow): DeliveryOutcomeInput | null {
  if (row.ackOutcome === null || row.attemptId === null) return null;
  const attemptId = row.attemptId;
  const attemptedAt = row.attemptedAt ?? undefined;
  switch (row.ackOutcome) {
    case 'PROVIDER_ACCEPTED':
      return row.providerMessageId === null || attemptedAt === undefined
        ? null
        : {
            outcome: 'PROVIDER_ACCEPTED',
            attemptId,
            providerMessageId: row.providerMessageId,
            attemptedAt,
          };
    case 'DELIVERY_UNKNOWN':
      return attemptedAt === undefined
        ? null
        : {
            outcome: 'DELIVERY_UNKNOWN',
            attemptId,
            attemptedAt,
            ...(row.providerMessageId === null
              ? {}
              : { providerMessageId: row.providerMessageId }),
          };
    case 'DEFERRED_WINDOW_CLOSED':
    case 'DEFERRED_HUMAN_SESSION':
      return attemptedAt === undefined
        ? null
        : { outcome: row.ackOutcome, attemptId, attemptedAt };
    case 'STALE':
      return {
        outcome: 'STALE',
        attemptId,
        ...(attemptedAt === undefined ? {} : { attemptedAt }),
      };
  }
}

const ACK_BASE_MS = 1_000;
const ACK_MAX_MS = 300_000;
export const RETRY_AFTER_MAX_MS = 300_000;

/** Capped exponential backoff with full jitter on the upper half. */
export function ackBackoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(
    ACK_MAX_MS,
    ACK_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(ceiling / 2 + (ceiling / 2) * random());
}

export const canonicalNow = (clock: () => Date): string =>
  Date.prototype.toISOString.call(clock());
