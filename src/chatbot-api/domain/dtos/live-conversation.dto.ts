import type { ConversationMirrorCommonFailure } from './conversation-mirror.dto';
import {
  parseScheduledRequestSummary,
  type ScheduledRequestSummary,
} from './scheduling.dto';

/**
 * Live conversation (backend unit 11, houndfe-backend
 * `docs/chatbot-handoff/chatbot-requests-bot-contract.md` §"Live
 * conversation (unit 11)", commit 5b1ce241): `session-ack`, the single and
 * bulk conversation state reads, and the staff media download.
 *
 * Error style (same as the unit 9 mirror): every documented answer is a typed
 * result discriminated by `kind`; nothing here echoes the `conversationRef`
 * or a phone in an error or result (S7). The `items[].conversationRef` of the
 * bulk list is the one place a ref is returned, because that is the payload.
 * Parsing is fail-closed on `mode` / epochs and never throws; unknown extra
 * response keys are dropped.
 */

// ---------------------------------------------------------------- limits

export const SESSION_ACK_PROVIDER_MESSAGE_ID_MAX_CHARS = 512;
export const CONVERSATION_STATE_LIST_MAX_LIMIT = 500;
export const CONVERSATION_STATE_CURSOR_MAX_CHARS = 2048;
export const STAFF_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /chatbot-api/media/:id` only serves these (unit 9 limits). */
const STAFF_MEDIA_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

// ----------------------------------------------------------------- shared

export type LiveConversationMode = 'BOT' | 'HUMAN';
export type LiveSessionState = 'STARTING' | 'ACTIVE' | 'ENDING' | 'ENDED';
export type SessionAckState = 'STARTED' | 'ENDED';

/** The failures every live-conversation route shares (the mirror's set). */
export type LiveConversationFailure = ConversationMirrorCommonFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLiveConversationMode(
  value: unknown,
): value is LiveConversationMode {
  return value === 'BOT' || value === 'HUMAN';
}

/** Unknown session states read as `null` (the mode and epoch are what the
 *  silence protocol acts on), never as a made-up state. */
function parseSessionState(value: unknown): LiveSessionState | null {
  return value === 'STARTING' ||
    value === 'ACTIVE' ||
    value === 'ENDING' ||
    value === 'ENDED'
    ? value
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ------------------------------------------------------------ session-ack

export interface SessionAckInput {
  /** Integer ≥ 1: the epoch of the item being acknowledged. */
  epoch: number;
  state: SessionAckState;
  /** Optional, 1..512 characters: the wamid of the greeting/farewell. */
  providerMessageId?: string;
}

export type SessionAckResult =
  /** 200 (also an idempotent replay): `sessionState` is the session's state
   *  after the call. */
  | {
      kind: 'ok';
      epoch: number;
      state: SessionAckState;
      sessionState: LiveSessionState | null;
    }
  /** 409 `STALE_EPOCH`: a reconcile signal, never a retry (apply rule 9). */
  | {
      kind: 'STALE_EPOCH';
      currentEpoch: number;
      mode: LiveConversationMode;
      sessionState: LiveSessionState | null;
    }
  /** 409 `SESSION_NOT_ENDING`: the bot cannot end a session by itself. */
  | { kind: 'SESSION_NOT_ENDING' }
  /** 404: the conversation is unknown to the backend. */
  | { kind: 'NOT_FOUND' }
  | LiveConversationFailure;

/** A fixed, input-free reason when the input breaks the contract, or null. */
export function sessionAckProblem(input: unknown): string | null {
  if (!isPlainObject(input)) return 'ack must be an object';
  const { epoch, state, providerMessageId } = input;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 1)
    return 'epoch must be an integer of at least 1';
  if (state !== 'STARTED' && state !== 'ENDED')
    return 'state must be STARTED or ENDED';
  if (providerMessageId !== undefined) {
    if (
      typeof providerMessageId !== 'string' ||
      providerMessageId.length < 1 ||
      providerMessageId.length > SESSION_ACK_PROVIDER_MESSAGE_ID_MAX_CHARS
    )
      return `providerMessageId must hold 1 to ${SESSION_ACK_PROVIDER_MESSAGE_ID_MAX_CHARS} characters`;
  }
  return null;
}

/** Exactly the contract keys, in a fixed order (extra keys are a 400). */
export function toSessionAckBody(
  input: SessionAckInput,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    epoch: input.epoch,
    state: input.state,
  };
  if (input.providerMessageId !== undefined)
    wire.providerMessageId = input.providerMessageId;
  return wire;
}

export function parseSessionAckOk(
  body: unknown,
): Extract<SessionAckResult, { kind: 'ok' }> | null {
  if (!isPlainObject(body)) return null;
  const { epoch, state, sessionState } = body;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) return null;
  if (state !== 'STARTED' && state !== 'ENDED') return null;
  return {
    kind: 'ok',
    epoch: epoch as number,
    state,
    sessionState: parseSessionState(sessionState),
  };
}

export function parseStaleEpoch(
  body: unknown,
): Extract<SessionAckResult, { kind: 'STALE_EPOCH' }> | null {
  if (!isPlainObject(body)) return null;
  const { currentEpoch, mode, sessionState } = body;
  if (!Number.isSafeInteger(currentEpoch) || (currentEpoch as number) < 0)
    return null;
  if (!isLiveConversationMode(mode)) return null;
  return {
    kind: 'STALE_EPOCH',
    currentEpoch: currentEpoch as number,
    mode,
    sessionState: parseSessionState(sessionState),
  };
}

// ------------------------------------------------------------------ state

/** The conversation's handoff state as the backend sees it. */
export interface ConversationHandoffState {
  mode: LiveConversationMode;
  /** `0` before the first claim. */
  handoffEpoch: number;
  /** `null` when `mode` is `BOT`. */
  sessionState: LiveSessionState | null;
  requestId: string | null;
  assigneeFirstName: string | null;
  /** Unit 14: the chat's nearest open scheduled request, or `null`. Set by
   *  the parsers whenever the backend sends the key (it always does from
   *  unit 14 on); absent only on a pre-unit-14 backend or a 404, which read
   *  as `null`. A malformed value reads as `null`: it is informational and
   *  never breaks the mode/epoch read. */
  scheduledRequest?: ScheduledRequestSummary | null;
}

/** What the backend answers for a conversation it has never seen (404). */
export const UNKNOWN_CONVERSATION_STATE: Readonly<ConversationHandoffState> =
  Object.freeze({
    mode: 'BOT',
    handoffEpoch: 0,
    sessionState: null,
    requestId: null,
    assigneeFirstName: null,
  });

export type GetConversationStateResult =
  /** 200, or the 404 of an unknown conversation read as BOT / epoch 0. */
  ({ kind: 'ok' } & ConversationHandoffState) | LiveConversationFailure;

export function parseConversationState(
  body: unknown,
): ConversationHandoffState | null {
  if (!isPlainObject(body)) return null;
  const { mode, handoffEpoch, sessionState, requestId, assigneeFirstName } =
    body;
  if (!isLiveConversationMode(mode)) return null;
  if (!Number.isSafeInteger(handoffEpoch) || (handoffEpoch as number) < 0)
    return null;
  return {
    mode,
    handoffEpoch: handoffEpoch as number,
    sessionState: parseSessionState(sessionState),
    requestId: nullableString(requestId),
    assigneeFirstName: nullableString(assigneeFirstName),
    ...('scheduledRequest' in body
      ? {
          scheduledRequest: parseScheduledRequestSummary(body.scheduledRequest),
        }
      : {}),
  };
}

// ------------------------------------------------------------- bulk state

export interface ListHumanConversationsOptions {
  /** Opaque, from the previous answer's `nextCursor`. */
  cursor?: string;
  /** 1 to 500; the backend defaults to 100. */
  limit?: number;
}

export interface HumanConversationState extends ConversationHandoffState {
  conversationRef: string;
}

export type ListHumanConversationsResult =
  | {
      kind: 'ok';
      items: HumanConversationState[];
      /** `null` on the last page. */
      nextCursor: string | null;
    }
  | LiveConversationFailure;

export function listHumanConversationsProblem(options: unknown): string | null {
  if (!isPlainObject(options)) return 'options must be an object';
  const { cursor, limit } = options;
  if (cursor !== undefined) {
    if (
      typeof cursor !== 'string' ||
      cursor.length < 1 ||
      cursor.length > CONVERSATION_STATE_CURSOR_MAX_CHARS
    )
      return 'cursor must be a non-empty opaque string';
  }
  if (limit !== undefined) {
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > CONVERSATION_STATE_LIST_MAX_LIMIT
    )
      return `limit must be an integer from 1 to ${CONVERSATION_STATE_LIST_MAX_LIMIT}`;
  }
  return null;
}

export function parseHumanConversationList(
  body: unknown,
): { items: HumanConversationState[]; nextCursor: string | null } | null {
  if (!isPlainObject(body)) return null;
  const { items, nextCursor } = body;
  if (!Array.isArray(items)) return null;
  if (nextCursor !== null && nextCursor !== undefined) {
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) return null;
  }
  const parsed: HumanConversationState[] = [];
  for (const item of items) {
    const state = parseConversationState(item);
    const ref = isPlainObject(item) ? item.conversationRef : undefined;
    if (state === null || typeof ref !== 'string' || ref.length === 0)
      return null;
    parsed.push({ conversationRef: ref, ...state });
  }
  return {
    items: parsed,
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
  };
}

// ------------------------------------------------------------ staff media

export interface DownloadStaffMediaOptions {
  /** Hard cap enforced while streaming; default and maximum 10 MiB. */
  maxBytes?: number;
}

/** A streamed, size-capped temp file (mode 0600). The caller owns it and
 *  must call `cleanup()` once the bytes are no longer needed. */
export interface StaffMediaFile {
  filePath: string;
  /** The response `Content-Type` without parameters (image/jpeg, image/png,
   *  image/webp or application/pdf). */
  mimeType: string;
  /** The sanitized `Content-Disposition` filename (`media` when absent). */
  filename: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: string;
  /** Idempotent; never throws. */
  cleanup(): Promise<void>;
}

export type DownloadStaffMediaResult =
  | ({ kind: 'ok' } & StaffMediaFile)
  /** 404 `MEDIA_NOT_FOUND`: unknown, foreign, purged or not a staff file.
   *  The caller reports the delivery outcome `STALE`. */
  | { kind: 'MEDIA_NOT_FOUND' }
  /** The file is over `maxBytes` (declared or counted while streaming):
   *  nothing is kept on disk. */
  | { kind: 'MEDIA_TOO_LARGE' }
  /** The temp file could not be written (disk full, permissions, …). */
  | { kind: 'LOCAL_IO_ERROR' }
  | LiveConversationFailure;

export function isStaffMediaId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isStaffMediaMimeType(value: unknown): value is string {
  return typeof value === 'string' && STAFF_MEDIA_MIME_TYPES.includes(value);
}
