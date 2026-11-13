import type { DeliveryZoneIntakeInput } from './human-decisions-delivery-zone.dto';
import type { ExpirationIntakeInput } from './human-decisions-expiration.dto';
import type { RestockIntakeInput } from './human-decisions.dto';

/**
 * Human requests (docs/contracts/human-intervention-requests-5a.md) and the
 * feed, delivery outcome and pending deliveries
 * (docs/contracts/human-intervention-bot-contract-5b.md).
 *
 * Error style: every documented business answer (409/410/422/429/404/400 with
 * a known code) is a typed result discriminated by `kind`, so callers must
 * decide on each one. Anything else — 401/403, 5xx, network/timeouts, an
 * undocumented code, or a success body that breaks the contract — still
 * throws the existing `ChatbotApiError` subclasses.
 *
 * Parsing is fail-closed on missing keys, wrong types and enums; unknown
 * extra keys are dropped (the backend adds fields over time). Never throws.
 */

// ---------------------------------------------------------------- create

export type DirectHumanRequestSubtype =
  | 'UNKNOWN_QUESTION'
  | 'TALK_TO_HUMAN'
  | 'COMPLAINT';

export interface HumanRequestCustomer {
  phoneCountryCode: string;
  phone: string;
  displayName?: string | null;
}

/** Only these keys are accepted by the backend; never prices. */
export interface HumanRequestContext {
  cartRef?: string;
  saleId?: string;
  orderId?: string;
  productIds?: string[];
  variantIds?: string[];
  quantity?: number;
}

interface CreateHumanRequestCommon {
  /** Also sent as `X-Idempotency-Key`. */
  sourceRequestId: string;
  needs?: string;
  context?: HumanRequestContext;
  dedupKey?: string;
  triggerWaMessageId?: string;
}

/** Direct subtypes require the conversation envelope. */
export type CreateDirectHumanRequestInput = CreateHumanRequestCommon & {
  subtype: DirectHumanRequestSubtype;
  customer: HumanRequestCustomer;
  conversationRef: string;
  lastCustomerMessageAt: string;
  /** 1..140 chars. */
  summary: string;
  detail?: Record<string, never>;
};

/** Wrapped subtypes send today's human-decisions body as `detail`. */
type WrappedEnvelope = Partial<
  Pick<
    CreateDirectHumanRequestInput,
    'customer' | 'conversationRef' | 'lastCustomerMessageAt' | 'summary'
  >
>;
export type CreateWrappedHumanRequestInput = CreateHumanRequestCommon &
  WrappedEnvelope &
  (
    | { subtype: 'RESTOCK'; detail: RestockIntakeInput }
    | { subtype: 'EXPIRATION'; detail: ExpirationIntakeInput }
    | { subtype: 'DELIVERY_ZONE'; detail: DeliveryZoneIntakeInput }
  );

export type CreateHumanRequestInput =
  | CreateDirectHumanRequestInput
  | CreateWrappedHumanRequestInput;

export const HUMAN_REQUEST_SUMMARY_MAX_LENGTH = 140;

export interface HumanRequestBusinessHours {
  openNow: boolean;
  nextOpenAt: string | null;
}

export interface HumanRequestCreated {
  /** `null` for a DELIVERY_ZONE already approved (answer in `legacy`). */
  id: string | null;
  folio: string | null;
  status: string;
  outcome: 'CREATED' | 'REPLAYED' | 'MERGED';
  mergedIntoId: string | null;
  /** `null` until backend unit 7: never treat null as "closed". */
  businessHours: HumanRequestBusinessHours | null;
  /** Wrapped subtypes only: the legacy human-decision answer, kept raw. */
  legacy?: Record<string, unknown>;
}

export type RateLimitedResult = {
  kind: 'RATE_LIMITED';
  retryAfterSeconds: number | null;
};
export type ValidationErrorResult = {
  kind: 'VALIDATION_ERROR';
  message: string | null;
};

export type CreateHumanRequestResult =
  | { kind: 'ok'; status: 201 | 200; response: HumanRequestCreated }
  | { kind: 'CUSTOMER_OPEN_LIMIT'; limit: number | null; open: number | null }
  | {
      kind: 'CUSTOMER_RATE_LIMITED';
      limit: number | null;
      retryAfterSeconds: number | null;
    }
  | RateLimitedResult
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'SUBTYPE_DISABLED' }
  | { kind: 'SCHEDULING_DISABLED' }
  | { kind: 'VERSION_CONFLICT' }
  | ValidationErrorResult
  | { kind: 'NOT_FOUND' };

// ---------------------------------------------------------------- cancel

export interface CancelHumanRequestInput {
  reason: 'CUSTOMER_WITHDREW' | 'AUTO_RESOLVED';
  triggerWaMessageId: string;
}

export interface HumanRequestCancelled {
  id: string;
  status: 'CANCELLED';
  reason: string;
  cancelledAt: string;
}

export type CancelHumanRequestResult =
  | { kind: 'ok'; response: HumanRequestCancelled }
  /** Deliver `resolution` instead of "cancelled". Kept raw. */
  | { kind: 'ALREADY_RESOLVED'; resolution: unknown }
  | { kind: 'REQUEST_CLOSED' }
  | { kind: 'CANCEL_NOT_ALLOWED' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  | RateLimitedResult;

// ---------------------------------------------------------------- feed

export const FEED_MAX_LIMIT = 50;
export const FEED_MAX_WAIT_SECONDS = 25;

export interface ReadFeedOptions {
  after?: string;
  /** 1..50, default 50. */
  limit?: number;
  /** 0..25, default 25. */
  waitSeconds?: number;
}

export type DeferredReason = 'HUMAN_SESSION' | 'WINDOW_CLOSED';
export type DeliveryZoneType = 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED';

interface DecisionCommon {
  kind: 'DECISION';
  legacyId: string | null;
  /** usted fallback; compose from the structured fields first. */
  text: string;
  /** Team prefix only when `text` is staff wording, else null. */
  prefix: string | null;
}

export type RestockAnswer = DecisionCommon & { subtype: 'RESTOCK' } & (
    | {
        action: 'PROVIDE_RESTOCK_ESTIMATE';
        productName: string;
        restockDays: number;
      }
    | { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE'; productName: string }
  );

export type ExpirationAnswer = DecisionCommon & { subtype: 'EXPIRATION' } & (
    | {
        action: 'PROVIDE_EXPIRATION_TEXT';
        productName: string;
        expirationText: string;
        staffText: string;
      }
    | { action: 'REPORT_EXPIRATION_UNAVAILABLE'; productName: string }
  );

export type DeliveryZoneAnswer = DecisionCommon & {
  subtype: 'DELIVERY_ZONE';
  action: 'APPROVE_DELIVERY_ZONE' | 'REJECT_DELIVERY_ZONE';
  zipCode: string;
  zoneType: DeliveryZoneType;
  /** Present only when it applies. */
  surchargeCents?: number;
  etaDays?: number;
};

export type TransferReceiptAnswer = DecisionCommon & {
  subtype: 'TRANSFER_RECEIPT';
} & (
    | { action: 'CONFIRM_RECEIPT' }
    | {
        action: 'REJECT_RECEIPT';
        customerReason: string;
        reasonSource: 'STAFF';
        /** Relay as written, with the team prefix. */
        staffText: string;
      }
    | {
        action: 'REJECT_RECEIPT';
        customerReason: string;
        /** No staff wording: compose your own in the customer's register. */
        reasonSource: 'DEFAULT';
      }
  );

export interface ClarificationAnswer {
  kind: 'CLARIFICATION';
  /** The staff text (`staffText`, else `text`), delivered verbatim with the
   *  team prefix. */
  text: string;
  prefix: string | null;
  /** Unit 10: the id to mirror the sent message with (`staffReplyId`).
   *  Absent on items that predate it: delivered with no attribution. */
  replyId?: string;
}

/** Unknown kind/subtype/action: the raw payload plus the fallback text. */
export interface UnrecognizedAnswer {
  kind: 'unrecognized';
  text: string | null;
  prefix: string | null;
  raw: Record<string, unknown>;
}

export type RequestAnsweredPayload =
  | RestockAnswer
  | ExpirationAnswer
  | DeliveryZoneAnswer
  | TransferReceiptAnswer
  | ClarificationAnswer
  | UnrecognizedAnswer;

export type StaffCancelReason =
  | 'DUPLICATE'
  | 'NOT_ACTIONABLE'
  | 'CUSTOMER_UNREACHABLE'
  | 'OTHER';

export interface RequestCancelledPayload {
  requestId: string;
  reason: StaffCancelReason;
  cancelledBy: 'STAFF';
  /** Sent verbatim with the team prefix when present. */
  customerNote?: string;
}

interface FeedItemEnvelope {
  cursor: string;
  deliveryId: string;
  requestId: string;
  conversationRef: string | null;
  notBefore: string | null;
  expiresAt: string | null;
  /** Pending deliveries and recovery items only; absent when no deferral
   *  was reported (`null` on the wire). */
  deferredReason?: DeferredReason;
}

export type RequestAnsweredItem = FeedItemEnvelope & {
  type: 'request.answered';
  payload: RequestAnsweredPayload;
};
export type RequestCancelledItem = FeedItemEnvelope & {
  type: 'request.cancelled';
  payload: RequestCancelledPayload;
};
export interface RequestMergedPayload {
  /** The open request that absorbed this one (B in "merge A into B"). */
  intoRequestId: string;
}
/** Staff merged this request (A) into another one (B); informational only:
 *  the bot sends nothing and ACKs STALE. */
export type RequestMergedItem = FeedItemEnvelope & {
  type: 'request.merged';
  payload: RequestMergedPayload;
};
export interface RequestOverdueNoticePayload {
  requestId: string;
  folio: string | null;
  kind: string | null;
  subtype: string | null;
  /** Which SLA clock ran out (claim or resolve). */
  clock: 'CLAIM' | 'RESOLVE';
  overdueAt: string | null;
  assigned: boolean;
}
/** Backend unit 7c: the SLA sweep first marked the request overdue (once per
 *  request ever). The bot tells the customer once; the request stays open and
 *  the item is never deferred (422 OUTCOME_NOT_ALLOWED). */
export type RequestOverdueNoticeItem = FeedItemEnvelope & {
  type: 'request.overdue_notice';
  payload: RequestOverdueNoticePayload;
};
// ---------------------------------------------------- live conversation

/** Backend unit 11 (contract "Live conversation"). `handoffEpoch` is the
 *  conversation's integer epoch (>= 1); `seq` its message counter. */
export interface ConversationStartedPayload {
  requestId: string;
  handoffEpoch: number;
  /** First word of the attendee's name; `null` when the account has none. */
  staffFirstName: string | null;
  /** Backend estimate (ISO UTC) or `null`; informational, Meta decides. */
  whatsappWindowClosesAt: string | null;
}
/** The claim of a live request committed: mute, session-ack STARTED, then
 *  (after the 200) the greeting. */
export type ConversationStartedItem = FeedItemEnvelope & {
  type: 'conversation.started';
  payload: ConversationStartedPayload;
};

interface StaffMessageCommon {
  requestId: string;
  handoffEpoch: number;
  seq: number;
  /** The backend's message row id: a dedupe key next to `deliveryId`. */
  messageId: string;
}
export type StaffMessagePayload =
  | (StaffMessageCommon & { type: 'TEXT'; text: string })
  | (StaffMessageCommon & {
      type: 'IMAGE' | 'DOCUMENT';
      mediaId: string;
      mimeType: string;
      filename: string;
      /** `null`: send no caption. */
      caption: string | null;
    });
/** One staff message to relay verbatim (never mirrored by the bot). */
export type ConversationStaffMessageItem = FeedItemEnvelope & {
  type: 'conversation.staff_message';
  payload: StaffMessagePayload;
};

export interface TemplateRequestedPayload {
  requestId: string;
  handoffEpoch: number;
  seq: number;
  messageId: string;
  templateName: string;
  /** `xx` or `xx_YY`; `es_MX` when the backend omits it. */
  languageCode: string;
}
/** The attendee pressed "Enviar plantilla"; no variables in v1. */
export type TemplateRequestedItem = FeedItemEnvelope & {
  type: 'template.requested';
  payload: TemplateRequestedPayload;
};

export interface ConversationReassignedPayload {
  requestId: string;
  handoffEpoch: number;
  staffFirstName: string | null;
}
export type ConversationReassignedItem = FeedItemEnvelope & {
  type: 'conversation.reassigned';
  payload: ConversationReassignedPayload;
};

export type ConversationEndReason =
  | 'FINISHED'
  | 'FORCED'
  | 'IDLE_TIMEOUT'
  | 'START_TIMEOUT';
export interface ConversationEndedPayload {
  requestId: string;
  handoffEpoch: number;
  reason: ConversationEndReason;
  farewell: boolean;
  resumeNotice: boolean;
}
export type ConversationEndedItem = FeedItemEnvelope & {
  type: 'conversation.ended';
  payload: ConversationEndedPayload;
};

export type LiveConversationItem =
  | ConversationStartedItem
  | ConversationStaffMessageItem
  | TemplateRequestedItem
  | ConversationReassignedItem
  | ConversationEndedItem;

/** A type this bot does not know (or a malformed known one): ACK or skip
 *  it by `deliveryId`, never crash. */
export interface UnknownFeedItem {
  type: 'unknown';
  rawType: string;
  cursor: string;
  deliveryId: string;
  raw: Record<string, unknown>;
}

export type FeedItem =
  | RequestAnsweredItem
  | RequestMergedItem
  | RequestCancelledItem
  | RequestOverdueNoticeItem
  | LiveConversationItem
  | UnknownFeedItem;

export type ReadFeedResult =
  | { kind: 'ok'; items: FeedItem[]; nextCursor: string }
  | { kind: 'CURSOR_EXPIRED' }
  | RateLimitedResult;

// ---------------------------------------------------------------- outcome

export type DeliveryOutcomeInput =
  | {
      outcome: 'PROVIDER_ACCEPTED';
      attemptId: string;
      providerMessageId: string;
      attemptedAt: string;
    }
  | {
      outcome: 'DELIVERY_UNKNOWN';
      attemptId: string;
      attemptedAt: string;
      providerMessageId?: string;
    }
  | {
      outcome: 'DEFERRED_WINDOW_CLOSED';
      attemptId: string;
      attemptedAt: string;
    }
  /** Slice 5c; `422 OUTCOME_NOT_ALLOWED` on `request.cancelled`. */
  | {
      outcome: 'DEFERRED_HUMAN_SESSION';
      attemptId: string;
      attemptedAt: string;
    }
  | { outcome: 'STALE'; attemptId: string; attemptedAt?: string };

export type DeliveryOutcome = DeliveryOutcomeInput['outcome'];

export interface DeliveryOutcomeAck {
  deliveryId: string;
  outcome: DeliveryOutcome;
  attemptId: string;
  /** `null` for a deferral. */
  ackReceivedAt: string | null;
}

export type RecordDeliveryOutcomeResult =
  | { kind: 'ok'; response: DeliveryOutcomeAck }
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'OUTCOME_ALREADY_RECORDED' }
  | { kind: 'OUTCOME_NOT_ALLOWED' }
  | { kind: 'NOT_FOUND' }
  | RateLimitedResult
  | ValidationErrorResult;

// ---------------------------------------------------------------- pending

export type PendingDeliveriesFilter =
  | { conversationRef: string; requestId?: never }
  | { requestId: string; conversationRef?: never };

export type PendingDeliveriesResult =
  | { kind: 'ok'; items: FeedItem[] }
  | RateLimitedResult;

// ---------------------------------------------------------------- recovery

export const OPEN_REQUESTS_MAX_LIMIT = 50;

export interface ListOpenRequestsOptions {
  /** Canonical UTC ms; adds requests closed at or after it. */
  updatedSince?: string;
  /** The previous page's `nextPage`. */
  cursor?: string;
  /** 1..50, default 50. */
  limit?: number;
}

export type HumanRequestLifecycleStatus =
  | 'NEW'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'CANCELLED';

/** One request of the 5c recovery route. `conversationRef` carries the
 *  customer's phone: never log it unmasked. */
export interface OpenHumanRequest {
  id: string;
  folio: string | null;
  kind: string;
  subtype: string;
  status: HumanRequestLifecycleStatus;
  conversationRef: string | null;
  legacyId: string | null;
  whatsappWindowClosesAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Latest undelivered feed items of the request (at most 5), oldest first. */
  pendingDeliveries: FeedItem[];
  undeliveredTruncated: boolean;
  /** Feed `after` re-serving the oldest undelivered item when truncated. */
  undeliveredResumeAfter: string | null;
}

export type ListOpenRequestsResult =
  | {
      kind: 'ok';
      items: OpenHumanRequest[];
      /** Tenant feed position when the walk's first page was served. */
      nextCursor: string;
      /** `null` on the last page. */
      nextPage: string | null;
    }
  | RateLimitedResult
  | ValidationErrorResult;

// ---------------------------------------------------------------- parsing

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Lowercase RFC UUID (the outcome contract requires lowercase). */
export const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant. */
export const isCanonicalUtcMs = (value: unknown): value is string =>
  typeof value === 'string' &&
  CANONICAL_UTC_MS.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const isProviderMessageId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 512 &&
  value.trim() === value &&
  !CONTROL_CHARS.test(value);

const OUTCOME_KEYS: Record<
  DeliveryOutcome,
  { required: string[]; optional: string[] }
> = {
  PROVIDER_ACCEPTED: {
    required: ['attemptId', 'outcome', 'providerMessageId', 'attemptedAt'],
    optional: [],
  },
  DELIVERY_UNKNOWN: {
    required: ['attemptId', 'outcome', 'attemptedAt'],
    optional: ['providerMessageId'],
  },
  DEFERRED_WINDOW_CLOSED: {
    required: ['attemptId', 'outcome', 'attemptedAt'],
    optional: [],
  },
  DEFERRED_HUMAN_SESSION: {
    required: ['attemptId', 'outcome', 'attemptedAt'],
    optional: [],
  },
  STALE: { required: ['attemptId', 'outcome'], optional: ['attemptedAt'] },
};

/** Exact outcome body for the wire, or null when it breaks the contract. */
export function normalizeDeliveryOutcome(
  input: unknown,
): DeliveryOutcomeInput | null {
  if (!isRecord(input) || typeof input.outcome !== 'string') return null;
  const keys = OUTCOME_KEYS[input.outcome as DeliveryOutcome] as
    | (typeof OUTCOME_KEYS)[DeliveryOutcome]
    | undefined;
  if (keys === undefined) return null;
  const present = Object.keys(input).filter((key) => input[key] !== undefined);
  if (
    !keys.required.every((key) => present.includes(key)) ||
    !present.every(
      (key) => keys.required.includes(key) || keys.optional.includes(key),
    )
  )
    return null;
  if (
    typeof input.attemptId !== 'string' ||
    !LOWERCASE_UUID.test(input.attemptId)
  )
    return null;
  if ('attemptedAt' in input && input.attemptedAt !== undefined)
    if (!isCanonicalUtcMs(input.attemptedAt)) return null;
  if ('providerMessageId' in input && input.providerMessageId !== undefined)
    if (!isProviderMessageId(input.providerMessageId)) return null;
  const body: Record<string, unknown> = {};
  for (const key of present) body[key] = input[key];
  return body as DeliveryOutcomeInput;
}

export function parseDeliveryOutcomeAck(
  body: unknown,
): DeliveryOutcomeAck | null {
  if (!isRecord(body)) return null;
  const { deliveryId, outcome, attemptId, ackReceivedAt } = body;
  if (
    !isText(deliveryId) ||
    typeof outcome !== 'string' ||
    !(outcome in OUTCOME_KEYS) ||
    !isText(attemptId) ||
    !isNullableString(ackReceivedAt)
  )
    return null;
  return {
    deliveryId,
    outcome: outcome as DeliveryOutcome,
    attemptId,
    ackReceivedAt,
  };
}

const CREATE_OUTCOMES: ReadonlySet<unknown> = new Set([
  'CREATED',
  'REPLAYED',
  'MERGED',
]);

export function parseHumanRequestCreated(
  body: unknown,
): HumanRequestCreated | null {
  if (!isRecord(body)) return null;
  const { id, status, outcome, mergedIntoId, businessHours, legacy } = body;
  // `folio` is tolerated when absent (the 5a summary omits it).
  const folio = body.folio ?? null;
  if (
    !isNullableString(id) ||
    id === '' ||
    !isNullableString(folio) ||
    !isText(status) ||
    !CREATE_OUTCOMES.has(outcome) ||
    !isNullableString(mergedIntoId)
  )
    return null;
  let hours: HumanRequestBusinessHours | null = null;
  if (businessHours !== null) {
    if (
      !isRecord(businessHours) ||
      typeof businessHours.openNow !== 'boolean' ||
      !isNullableString(businessHours.nextOpenAt ?? null)
    )
      return null;
    hours = {
      openNow: businessHours.openNow,
      nextOpenAt:
        (businessHours.nextOpenAt as string | null | undefined) ?? null,
    };
  }
  if (legacy !== undefined && legacy !== null && !isRecord(legacy)) return null;
  return {
    id,
    folio,
    status,
    outcome: outcome as HumanRequestCreated['outcome'],
    mergedIntoId,
    businessHours: hours,
    ...(isRecord(legacy) ? { legacy } : {}),
  };
}

export function parseHumanRequestCancelled(
  body: unknown,
): HumanRequestCancelled | null {
  if (!isRecord(body)) return null;
  const { id, status, reason, cancelledAt } = body;
  if (
    !isText(id) ||
    status !== 'CANCELLED' ||
    !isText(reason) ||
    !isText(cancelledAt)
  )
    return null;
  return { id, status, reason, cancelledAt };
}

const ZONE_TYPES: ReadonlySet<unknown> = new Set([
  'FREE',
  'SURCHARGE',
  'CARRIER_ONLY',
  'DENIED',
]);
const KNOWN_ACTIONS: Record<string, readonly string[]> = {
  RESTOCK: ['PROVIDE_RESTOCK_ESTIMATE', 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE'],
  EXPIRATION: ['PROVIDE_EXPIRATION_TEXT', 'REPORT_EXPIRATION_UNAVAILABLE'],
  DELIVERY_ZONE: ['APPROVE_DELIVERY_ZONE', 'REJECT_DELIVERY_ZONE'],
  TRANSFER_RECEIPT: ['CONFIRM_RECEIPT', 'REJECT_RECEIPT'],
};

const REPLY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isReplyId = (value: unknown): value is string =>
  typeof value === 'string' && REPLY_ID.test(value);

/** `undefined` = malformed (rejects the page). */
function parseAnswered(
  p: Record<string, unknown>,
): RequestAnsweredPayload | undefined {
  const prefix = p.prefix ?? null;
  if (!isNullableString(prefix)) return undefined;
  const unrecognized = (): RequestAnsweredPayload | undefined =>
    p.text === undefined || isNullableString(p.text)
      ? {
          kind: 'unrecognized',
          text: p.text ?? null,
          prefix,
          raw: p,
        }
      : undefined;

  if (p.kind === 'CLARIFICATION') {
    // Contract: relay `staffText` as written; `text` (same string) is the
    // fallback. A malformed `replyId` only loses the attribution: it must
    // never reject the page and block the feed.
    const staff = isText(p.staffText) ? p.staffText : p.text;
    if (!isText(staff)) return undefined;
    const replyId = isReplyId(p.replyId) ? p.replyId : undefined;
    return {
      kind: 'CLARIFICATION',
      text: staff,
      prefix,
      ...(replyId === undefined ? {} : { replyId }),
    };
  }
  if (
    p.kind !== 'DECISION' ||
    typeof p.subtype !== 'string' ||
    typeof p.action !== 'string' ||
    !KNOWN_ACTIONS[p.subtype]?.includes(p.action)
  )
    return unrecognized();

  const legacyId = p.legacyId ?? null;
  if (!isNullableString(legacyId) || !isText(p.text)) return undefined;
  const common = { kind: 'DECISION' as const, legacyId, text: p.text, prefix };

  switch (p.action) {
    case 'PROVIDE_RESTOCK_ESTIMATE':
      if (
        !isText(p.productName) ||
        !isCount(p.restockDays) ||
        p.restockDays < 1
      )
        return undefined;
      return {
        ...common,
        subtype: 'RESTOCK',
        action: p.action,
        productName: p.productName,
        restockDays: p.restockDays,
      };
    case 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE':
      if (!isText(p.productName)) return undefined;
      return {
        ...common,
        subtype: 'RESTOCK',
        action: p.action,
        productName: p.productName,
      };
    case 'PROVIDE_EXPIRATION_TEXT':
      if (
        !isText(p.productName) ||
        !isText(p.expirationText) ||
        !isText(p.staffText)
      )
        return undefined;
      return {
        ...common,
        subtype: 'EXPIRATION',
        action: p.action,
        productName: p.productName,
        expirationText: p.expirationText,
        staffText: p.staffText,
      };
    case 'REPORT_EXPIRATION_UNAVAILABLE':
      if (!isText(p.productName)) return undefined;
      return {
        ...common,
        subtype: 'EXPIRATION',
        action: p.action,
        productName: p.productName,
      };
    case 'APPROVE_DELIVERY_ZONE':
    case 'REJECT_DELIVERY_ZONE': {
      const surcharge = p.surchargeCents ?? undefined;
      const eta = p.etaDays ?? undefined;
      if (
        !isText(p.zipCode) ||
        !ZONE_TYPES.has(p.zoneType) ||
        (surcharge !== undefined && !isCount(surcharge)) ||
        (eta !== undefined && !isCount(eta))
      )
        return undefined;
      return {
        ...common,
        subtype: 'DELIVERY_ZONE',
        action: p.action,
        zipCode: p.zipCode,
        zoneType: p.zoneType as DeliveryZoneType,
        ...(surcharge === undefined ? {} : { surchargeCents: surcharge }),
        ...(eta === undefined ? {} : { etaDays: eta }),
      };
    }
    case 'CONFIRM_RECEIPT':
      return { ...common, subtype: 'TRANSFER_RECEIPT', action: p.action };
    case 'REJECT_RECEIPT': {
      if (!isText(p.customerReason)) return undefined;
      const base = {
        ...common,
        subtype: 'TRANSFER_RECEIPT' as const,
        action: 'REJECT_RECEIPT' as const,
        customerReason: p.customerReason,
      };
      if (p.reasonSource === 'STAFF')
        return isText(p.staffText)
          ? { ...base, reasonSource: 'STAFF', staffText: p.staffText }
          : undefined;
      if (p.reasonSource === 'DEFAULT')
        return p.staffText === undefined || p.staffText === null
          ? { ...base, reasonSource: 'DEFAULT' }
          : undefined;
      return undefined;
    }
    default:
      return unrecognized();
  }
}

const CANCEL_REASONS: ReadonlySet<unknown> = new Set([
  'DUPLICATE',
  'NOT_ACTIONABLE',
  'CUSTOMER_UNREACHABLE',
  'OTHER',
]);

function parseCancelled(
  p: Record<string, unknown>,
): RequestCancelledPayload | undefined {
  const note = p.customerNote ?? undefined;
  if (
    !isText(p.requestId) ||
    !CANCEL_REASONS.has(p.reason) ||
    p.cancelledBy !== 'STAFF' ||
    (note !== undefined && typeof note !== 'string')
  )
    return undefined;
  return {
    requestId: p.requestId,
    reason: p.reason as StaffCancelReason,
    cancelledBy: 'STAFF',
    ...(note === undefined ? {} : { customerNote: note }),
  };
}

const DEFERRED_REASONS: ReadonlySet<unknown> = new Set([
  'HUMAN_SESSION',
  'WINDOW_CLOSED',
]);

/** One feed / pending-deliveries item; null when malformed. */
export function parseFeedItem(item: unknown): FeedItem | null {
  if (
    !isRecord(item) ||
    !isText(item.cursor) ||
    !isText(item.deliveryId) ||
    !isText(item.type)
  )
    return null;
  // Informational and its backend shape is not final: a malformed one is
  // ACKed STALE as unknown rather than rejecting the whole page.
  if (item.type === 'request.merged')
    return (
      parseMerged(item, item.cursor, item.deliveryId) ?? {
        type: 'unknown',
        rawType: item.type,
        cursor: item.cursor,
        deliveryId: item.deliveryId,
        raw: item,
      }
    );
  // Informational too: a malformed one is ACKed STALE as unknown.
  if (item.type === 'request.overdue_notice')
    return (
      parseOverdueNotice(item, item.cursor, item.deliveryId) ?? {
        type: 'unknown',
        rawType: item.type,
        cursor: item.cursor,
        deliveryId: item.deliveryId,
        raw: item,
      }
    );
  // Unit 11: a malformed live item is ACKed STALE as unknown rather than
  // rejecting the page (a rejected page would block the whole feed).
  if (LIVE_TYPES.has(item.type))
    return (
      parseLiveItem(item, item.cursor, item.deliveryId) ?? {
        type: 'unknown',
        rawType: item.type,
        cursor: item.cursor,
        deliveryId: item.deliveryId,
        raw: item,
      }
    );
  if (item.type !== 'request.answered' && item.type !== 'request.cancelled')
    return {
      type: 'unknown',
      rawType: item.type,
      cursor: item.cursor,
      deliveryId: item.deliveryId,
      raw: item,
    };
  const { deferredReason } = item;
  if (
    !isText(item.requestId) ||
    !isNullableString(item.conversationRef) ||
    !isNullableString(item.notBefore) ||
    !isNullableString(item.expiresAt) ||
    !isRecord(item.payload) ||
    (deferredReason !== undefined &&
      deferredReason !== null &&
      !DEFERRED_REASONS.has(deferredReason))
  )
    return null;
  const envelope: FeedItemEnvelope = {
    cursor: item.cursor,
    deliveryId: item.deliveryId,
    requestId: item.requestId,
    conversationRef: item.conversationRef,
    notBefore: item.notBefore,
    expiresAt: item.expiresAt,
    ...(deferredReason === undefined || deferredReason === null
      ? {}
      : { deferredReason: deferredReason as DeferredReason }),
  };
  if (item.type === 'request.answered') {
    const payload = parseAnswered(item.payload);
    return payload === undefined
      ? null
      : { ...envelope, type: 'request.answered', payload };
  }
  const payload = parseCancelled(item.payload);
  return payload === undefined
    ? null
    : { ...envelope, type: 'request.cancelled', payload };
}

/** `request.merged` (backend slice 4b): tolerant of the envelope fields the
 *  informational item may omit; `requestId` and `intoRequestId` may arrive in
 *  the payload or at the top level until the backend shape is final (top-level
 *  `requestId` wins; `intoRequestId` is the first valid text of payload, then
 *  top level). */
function parseMerged(
  item: Record<string, unknown>,
  cursor: string,
  deliveryId: string,
): RequestMergedItem | null {
  const optional = (value: unknown): value is string | null | undefined =>
    value === undefined || isNullableString(value);
  if (
    !optional(item.conversationRef) ||
    !optional(item.notBefore) ||
    !optional(item.expiresAt) ||
    (item.payload !== undefined && !isRecord(item.payload))
  )
    return null;
  const payload = isRecord(item.payload) ? item.payload : {};
  const requestId = [item.requestId, payload.requestId].find(isText);
  const intoRequestId = [payload.intoRequestId, item.intoRequestId].find(
    isText,
  );
  if (requestId === undefined || intoRequestId === undefined) return null;
  return {
    cursor,
    deliveryId,
    requestId,
    conversationRef: item.conversationRef ?? null,
    notBefore: item.notBefore ?? null,
    expiresAt: item.expiresAt ?? null,
    type: 'request.merged',
    payload: { intoRequestId },
  };
}

/** `request.overdue_notice` (backend unit 7c): needs the envelope
 *  `requestId` and a payload with a known `clock`; every other field is
 *  tolerated (the bot only needs the request and its conversation). */
function parseOverdueNotice(
  item: Record<string, unknown>,
  cursor: string,
  deliveryId: string,
): RequestOverdueNoticeItem | null {
  const optional = (value: unknown): value is string | null | undefined =>
    value === undefined || isNullableString(value);
  const { payload } = item;
  if (
    !isText(item.requestId) ||
    !optional(item.conversationRef) ||
    !optional(item.notBefore) ||
    !optional(item.expiresAt) ||
    !isRecord(payload) ||
    (payload.clock !== 'CLAIM' && payload.clock !== 'RESOLVE')
  )
    return null;
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  const { deferredReason } = item;
  return {
    cursor,
    deliveryId,
    requestId: item.requestId,
    conversationRef: item.conversationRef ?? null,
    notBefore: item.notBefore ?? null,
    expiresAt: item.expiresAt ?? null,
    ...(typeof deferredReason === 'string' &&
    DEFERRED_REASONS.has(deferredReason)
      ? { deferredReason: deferredReason as DeferredReason }
      : {}),
    type: 'request.overdue_notice',
    payload: {
      requestId: item.requestId,
      folio: text(payload.folio),
      kind: text(payload.kind),
      subtype: text(payload.subtype),
      clock: payload.clock,
      overdueAt: text(payload.overdueAt),
      assigned: payload.assigned === true,
    },
  };
}

const LIVE_TYPES: ReadonlySet<string> = new Set([
  'conversation.started',
  'conversation.staff_message',
  'template.requested',
  'conversation.reassigned',
  'conversation.ended',
]);
const END_REASONS: ReadonlySet<unknown> = new Set([
  'FINISHED',
  'FORCED',
  'IDLE_TIMEOUT',
  'START_TIMEOUT',
]);
/** True for the five typed unit 11 items (`conversation.*`,
 *  `template.requested`). */
export const isLiveConversationItem = (
  item: FeedItem,
): item is LiveConversationItem =>
  item.type !== 'unknown' && LIVE_TYPES.has(item.type);
/** Contract: staff text is 1 to 4096 characters. */
export const STAFF_TEXT_MAX_LENGTH = 4096;
const DEFAULT_TEMPLATE_LANGUAGE = 'es_MX';
const LANGUAGE_CODE = /^[a-z]{2}(_[A-Z]{2})?$/;
const isEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

/** `null` when the key is not a string; an empty name is no name. */
const nameOrNull = (value: unknown): string | null | undefined =>
  value === undefined || value === null || value === ''
    ? null
    : typeof value === 'string'
      ? value
      : undefined;

function parseLiveItem(
  item: Record<string, unknown>,
  cursor: string,
  deliveryId: string,
): LiveConversationItem | null {
  const optional = (value: unknown): value is string | null | undefined =>
    value === undefined || isNullableString(value);
  const { payload, deferredReason } = item;
  if (
    !optional(item.conversationRef) ||
    !optional(item.notBefore) ||
    !optional(item.expiresAt) ||
    !isRecord(payload) ||
    (deferredReason !== undefined &&
      deferredReason !== null &&
      !DEFERRED_REASONS.has(deferredReason))
  )
    return null;
  // The envelope and the payload name the same request.
  const requestId = [item.requestId, payload.requestId].find(isText);
  if (
    requestId === undefined ||
    (item.requestId !== undefined && item.requestId !== requestId) ||
    (payload.requestId !== undefined && payload.requestId !== requestId) ||
    !isEpoch(payload.handoffEpoch)
  )
    return null;
  const handoffEpoch = payload.handoffEpoch;
  const envelope: FeedItemEnvelope = {
    cursor,
    deliveryId,
    requestId,
    conversationRef: item.conversationRef ?? null,
    notBefore: item.notBefore ?? null,
    expiresAt: item.expiresAt ?? null,
    ...(typeof deferredReason === 'string'
      ? { deferredReason: deferredReason as DeferredReason }
      : {}),
  };

  switch (item.type) {
    case 'conversation.started': {
      const staffFirstName = nameOrNull(payload.staffFirstName);
      if (staffFirstName === undefined) return null;
      return {
        ...envelope,
        type: 'conversation.started',
        payload: {
          requestId,
          handoffEpoch,
          staffFirstName,
          // Informational only: a malformed estimate never costs the item.
          whatsappWindowClosesAt: isText(payload.whatsappWindowClosesAt)
            ? payload.whatsappWindowClosesAt
            : null,
        },
      };
    }
    case 'conversation.reassigned': {
      const staffFirstName = nameOrNull(payload.staffFirstName);
      if (staffFirstName === undefined) return null;
      return {
        ...envelope,
        type: 'conversation.reassigned',
        payload: { requestId, handoffEpoch, staffFirstName },
      };
    }
    case 'conversation.ended':
      if (
        !END_REASONS.has(payload.reason) ||
        typeof payload.farewell !== 'boolean' ||
        typeof payload.resumeNotice !== 'boolean'
      )
        return null;
      return {
        ...envelope,
        type: 'conversation.ended',
        payload: {
          requestId,
          handoffEpoch,
          reason: payload.reason as ConversationEndReason,
          farewell: payload.farewell,
          resumeNotice: payload.resumeNotice,
        },
      };
    case 'conversation.staff_message': {
      if (!isCount(payload.seq) || !isText(payload.messageId)) return null;
      const common = {
        requestId,
        handoffEpoch,
        seq: payload.seq,
        messageId: payload.messageId,
      };
      if (payload.type === 'TEXT') {
        // Verbatim: never trimmed or rewritten.
        if (
          !isText(payload.text) ||
          payload.text.length > STAFF_TEXT_MAX_LENGTH
        )
          return null;
        return {
          ...envelope,
          type: 'conversation.staff_message',
          payload: { ...common, type: 'TEXT', text: payload.text },
        };
      }
      if (payload.type !== 'IMAGE' && payload.type !== 'DOCUMENT') return null;
      const caption = payload.caption ?? null;
      if (
        !isText(payload.mediaId) ||
        !isText(payload.mimeType) ||
        !isText(payload.filename) ||
        !isNullableString(caption)
      )
        return null;
      return {
        ...envelope,
        type: 'conversation.staff_message',
        payload: {
          ...common,
          type: payload.type,
          mediaId: payload.mediaId,
          mimeType: payload.mimeType,
          filename: payload.filename,
          caption,
        },
      };
    }
    case 'template.requested': {
      const languageCode = payload.languageCode ?? DEFAULT_TEMPLATE_LANGUAGE;
      if (
        !isCount(payload.seq) ||
        !isText(payload.messageId) ||
        !isText(payload.templateName) ||
        typeof languageCode !== 'string' ||
        !LANGUAGE_CODE.test(languageCode)
      )
        return null;
      return {
        ...envelope,
        type: 'template.requested',
        payload: {
          requestId,
          handoffEpoch,
          seq: payload.seq,
          messageId: payload.messageId,
          templateName: payload.templateName,
          languageCode,
        },
      };
    }
    default:
      return null;
  }
}

function parseItems(items: unknown): FeedItem[] | null {
  if (!Array.isArray(items)) return null;
  const parsed: FeedItem[] = [];
  for (const raw of items) {
    const item = parseFeedItem(raw);
    if (item === null) return null;
    parsed.push(item);
  }
  return parsed;
}

/** A whole page; null when the page or any item breaks the contract. */
export function parseFeedPage(
  body: unknown,
): { items: FeedItem[]; nextCursor: string } | null {
  if (!isRecord(body) || typeof body.nextCursor !== 'string') return null;
  const items = parseItems(body.items);
  return items === null ? null : { items, nextCursor: body.nextCursor };
}

export function parsePendingDeliveries(body: unknown): FeedItem[] | null {
  return isRecord(body) ? parseItems(body.items) : null;
}

const LIFECYCLE_STATUSES: ReadonlySet<unknown> = new Set([
  'NEW',
  'IN_PROGRESS',
  'RESOLVED',
  'CANCELLED',
]);

function parseOpenRequest(raw: unknown): OpenHumanRequest | null {
  if (!isRecord(raw)) return null;
  const {
    id,
    folio,
    kind,
    subtype,
    status,
    conversationRef,
    legacyId,
    whatsappWindowClosesAt,
    cancelReason,
    createdAt,
    updatedAt,
    closedAt,
    undeliveredTruncated,
    undeliveredResumeAfter,
  } = raw;
  if (
    !isText(id) ||
    !isNullableString(folio) ||
    !isText(kind) ||
    !isText(subtype) ||
    !LIFECYCLE_STATUSES.has(status) ||
    !isNullableString(conversationRef) ||
    !isNullableString(legacyId) ||
    !isNullableString(whatsappWindowClosesAt) ||
    !isNullableString(cancelReason) ||
    !isText(createdAt) ||
    !isText(updatedAt) ||
    !isNullableString(closedAt) ||
    typeof undeliveredTruncated !== 'boolean' ||
    !(undeliveredResumeAfter === null || isText(undeliveredResumeAfter)) ||
    (undeliveredTruncated && undeliveredResumeAfter === null)
  )
    return null;
  const pendingDeliveries = parseItems(raw.pendingDeliveries);
  // A known item must belong to this request.
  if (
    pendingDeliveries === null ||
    pendingDeliveries.some(
      (item) => item.type !== 'unknown' && item.requestId !== id,
    )
  )
    return null;
  return {
    id,
    folio,
    kind,
    subtype,
    status: status as HumanRequestLifecycleStatus,
    conversationRef,
    legacyId,
    whatsappWindowClosesAt,
    cancelReason,
    createdAt,
    updatedAt,
    closedAt,
    pendingDeliveries,
    undeliveredTruncated,
    undeliveredResumeAfter,
  };
}

/** A recovery page; null when the page or any request breaks the contract. */
export function parseOpenRequestsPage(body: unknown): {
  items: OpenHumanRequest[];
  nextCursor: string;
  nextPage: string | null;
} | null {
  if (
    !isRecord(body) ||
    !Array.isArray(body.items) ||
    !isText(body.nextCursor) ||
    !(body.nextPage === null || isText(body.nextPage))
  )
    return null;
  const items: OpenHumanRequest[] = [];
  for (const raw of body.items) {
    const request = parseOpenRequest(raw);
    if (request === null) return null;
    items.push(request);
  }
  return { items, nextCursor: body.nextCursor, nextPage: body.nextPage };
}

/** Local create check; the backend owns the full validation (400). */
export function isCreateHumanRequestInput(
  input: unknown,
): input is CreateHumanRequestInput {
  if (!isRecord(input) || !isText(input.sourceRequestId)) return false;
  if (
    input.subtype === 'RESTOCK' ||
    input.subtype === 'EXPIRATION' ||
    input.subtype === 'DELIVERY_ZONE'
  )
    return isRecord(input.detail);
  if (
    input.subtype !== 'UNKNOWN_QUESTION' &&
    input.subtype !== 'TALK_TO_HUMAN' &&
    input.subtype !== 'COMPLAINT'
  )
    return false;
  return (
    isRecord(input.customer) &&
    isText(input.conversationRef) &&
    isText(input.lastCustomerMessageAt) &&
    isText(input.summary) &&
    input.summary.length <= HUMAN_REQUEST_SUMMARY_MAX_LENGTH
  );
}

/** Wire body: only defined keys, so an unknown key never reaches the backend. */
export function toCreateHumanRequestBody(
  input: CreateHumanRequestInput,
): Record<string, unknown> {
  const keys = [
    'sourceRequestId',
    'subtype',
    'customer',
    'conversationRef',
    'lastCustomerMessageAt',
    'summary',
    'needs',
    'context',
    'dedupKey',
    'triggerWaMessageId',
    'detail',
  ] as const;
  const source = input as Partial<Record<(typeof keys)[number], unknown>>;
  const body: Record<string, unknown> = {};
  for (const key of keys)
    if (source[key] !== undefined) body[key] = source[key];
  return body;
}
