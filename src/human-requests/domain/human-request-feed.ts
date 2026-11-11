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
  | 'NO_CONVERSATION';

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
  /** The deferral is not supported yet (5c): the hold stays local only. */
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

/** Durable state of the feed consumer. Every write is a single atomic
 *  statement; ledger transitions are compare-and-set so two actors (the
 *  consumer, a replay, the sweeper) never both claim one send. */
export interface HumanRequestFeedStore {
  /** `null`: start from the oldest retained item. */
  readCursor(): Promise<string | null>;
  saveCursor(cursor: string | null): Promise<void>;

  /** Inserts the item as RECEIVED unless its `deliveryId` exists; returns the
   *  stored row either way (an existing row is never overwritten). */
  insertDelivery(
    item: FeedItem,
  ): Promise<{ row: DeliveryRow; inserted: boolean }>;
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
  listHeld(filter: {
    conversationRef?: string;
    limit: number;
  }): Promise<DeliveryRow[]>;
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

// ---------------------------------------------------------------- Meta

/** Meta's re-engagement error: the 24 h customer service window is closed. */
export const META_WINDOW_CLOSED_CODE = 131047;

/** How the WhatsApp sender surfaces a rejection (`WhatsappSendError`). */
export function isWindowClosedSendError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { graphErrorCode?: unknown }).graphErrorCode;
  return Number(code) === META_WINDOW_CLOSED_CODE;
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
