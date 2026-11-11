import type { PoolClient } from 'pg';

/**
 * Backend outbox (S2, human-intervention contract v1 §10.1): every fact the
 * backend must learn from the bot (transcript mirror, outbound wamids,
 * statuses, request creations/cancellations, session ACKs, feed delivery
 * outcomes) is committed here first and drained by a worker, in strict
 * `seq` order per (conversation, lane), through `BackendOutboxDeliveryPort`.
 */
export const BACKEND_OUTBOX_KINDS = [
  'MESSAGE_MIRROR',
  'MESSAGE_STATUS',
  'REQUEST_CREATE',
  'REQUEST_CANCEL',
  'SESSION_ACK',
  'DELIVERY_OUTCOME',
] as const;
export type BackendOutboxKind = (typeof BACKEND_OUTBOX_KINDS)[number];

/**
 * Ordering lanes. Order is strict within (conversation, lane) and lanes of
 * one conversation never block each other, so a request create/cancel is
 * not stuck behind transcript rows that keep retrying.
 */
export type BackendOutboxLane = 'MIRROR' | 'CONTROL';

const LANE_BY_KIND: Readonly<Record<BackendOutboxKind, BackendOutboxLane>> = {
  MESSAGE_MIRROR: 'MIRROR',
  MESSAGE_STATUS: 'MIRROR',
  REQUEST_CREATE: 'CONTROL',
  REQUEST_CANCEL: 'CONTROL',
  SESSION_ACK: 'CONTROL',
  DELIVERY_OUTCOME: 'CONTROL',
};

/** The lane a kind is ordered in (mirrored by the 4400 migration CHECK). */
export function laneForKind(kind: BackendOutboxKind): BackendOutboxLane {
  if (!Object.prototype.hasOwnProperty.call(LANE_BY_KIND, kind))
    throw new RangeError('backend outbox: unknown kind');
  return LANE_BY_KIND[kind];
}

export type BackendOutboxStatus = 'PENDING' | 'IN_FLIGHT' | 'DONE' | 'DEAD';

export interface BackendOutboxEntry {
  /** bigserial, kept as a decimal string (pg returns int8 as text). */
  id: string;
  conversationRef: string;
  seq: number;
  kind: BackendOutboxKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: BackendOutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  /** Fencing token for the completion calls of the current claim. */
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  doneAt: Date | null;
}

export interface BackendOutboxEnqueueInput {
  conversationRef: string;
  kind: BackendOutboxKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface BackendOutboxEnqueueResult {
  entry: BackendOutboxEntry;
  /** False when the idempotency key already existed (no-op). */
  created: boolean;
}

/** A claimed entry together with the lease that fences its completion. */
export type ClaimedBackendOutboxEntry = BackendOutboxEntry & {
  status: 'IN_FLIGHT';
  leaseOwner: string;
  leaseExpiresAt: Date;
};

export const BACKEND_OUTBOX_STORE = Symbol('BACKEND_OUTBOX_STORE');

export interface BackendOutboxStore {
  /**
   * Allocates the next `seq` of the (conversation, lane of the kind) and
   * inserts a PENDING row.
   * A duplicate idempotency key returns the existing row untouched. With a
   * `client`, the write joins the caller's open transaction (the caller
   * commits); without one it runs in its own transaction.
   */
  enqueue(
    input: BackendOutboxEnqueueInput,
    client?: PoolClient,
  ): Promise<BackendOutboxEnqueueResult>;

  /**
   * Claims up to `limit` lane heads: per (conversation, lane) only the
   * lowest seq that is neither DONE nor DEAD, and only when it is due
   * (PENDING with `next_attempt_at <= now`) or its lease expired.
   */
  claimHeads(
    limit: number,
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedBackendOutboxEntry[]>;

  /** The completion calls are fenced by (owner, leaseExpiresAt). */
  markDone(entry: ClaimedBackendOutboxEntry): Promise<boolean>;
  reschedule(
    entry: ClaimedBackendOutboxEntry,
    delayMs: number,
    error: string,
  ): Promise<boolean>;
  markDead(entry: ClaimedBackendOutboxEntry, error: string): Promise<boolean>;

  /** Deletes up to `limit` DONE rows whose `done_at` is older than `olderThanMs`. */
  purgeDone(olderThanMs: number, limit: number): Promise<number>;
}

export type BackendOutboxDeliveryResult =
  | { outcome: 'DELIVERED' }
  | { outcome: 'RETRY'; error: string; retryAfterMs?: number }
  | { outcome: 'PERMANENT'; error: string };

export const BACKEND_OUTBOX_DELIVERY = Symbol('BACKEND_OUTBOX_DELIVERY');

/**
 * Delivers one row to the backend. A thrown error counts as RETRY
 * (network, timeout). Delivery must be idempotent on `idempotencyKey`: an
 * expired lease or a crash after delivery replays the same row.
 */
export interface BackendOutboxDeliveryPort {
  deliver(entry: BackendOutboxEntry): Promise<BackendOutboxDeliveryResult>;
}

const CONVERSATION_REF = /^wa:[0-9]{6,20}$/;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_LAST_ERROR_LENGTH = 1000;

/** `wa:<raw wa_id>`, the contract's conversationRef. */
export const conversationRefFor = (waId: string): string => `wa:${waId}`;

export const isConversationRef = (value: unknown): value is string =>
  typeof value === 'string' && CONVERSATION_REF.test(value);

/** Programmer errors throw: an invalid row must never be silently dropped. */
export function assertEnqueueInput(input: BackendOutboxEnqueueInput): void {
  if (!isConversationRef(input.conversationRef))
    throw new RangeError('backend outbox: conversationRef must be wa:<wa_id>');
  if (!(BACKEND_OUTBOX_KINDS as readonly string[]).includes(input.kind))
    throw new RangeError('backend outbox: unknown kind');
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  )
    throw new RangeError('backend outbox: invalid idempotencyKey');
  if (
    input.payload === null ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  )
    throw new TypeError('backend outbox: payload must be a JSON object');
}

export const truncateError = (error: string): string =>
  error.length > MAX_LAST_ERROR_LENGTH
    ? error.slice(0, MAX_LAST_ERROR_LENGTH)
    : error;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 300_000;
/** Upper bound for a backend-provided Retry-After. */
export const RETRY_AFTER_MAX_MS = 3_600_000;

/**
 * Exponential backoff with equal jitter: attempt 1 waits ~1 s, doubling up
 * to the 5 min cap; the delay lands in [half, full] of the step.
 */
export function backoffDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(step / 2 + (step / 2) * jitter);
}

/** Error codes that mean the backend already holds this fact. */
const ALREADY_RECORDED_CODES = new Set([
  'OUTCOME_ALREADY_RECORDED',
  'ALREADY_RESOLVED',
  'ALREADY_RECORDED',
]);

/**
 * Maps a backend HTTP answer to a delivery result, for the HTTP adapter:
 * 2xx and "already recorded" 409s are DELIVERED; 408, 429 and 5xx retry
 * (honoring Retry-After); any other 4xx will never succeed and is PERMANENT.
 */
export function classifyBackendResponse(
  status: number,
  options: { code?: string; retryAfter?: string | null; now?: Date } = {},
): BackendOutboxDeliveryResult {
  if (status >= 200 && status < 300) return { outcome: 'DELIVERED' };
  const label = options.code ? `${status} ${options.code}` : `${status}`;
  if (
    status === 409 &&
    options.code &&
    ALREADY_RECORDED_CODES.has(options.code)
  )
    return { outcome: 'DELIVERED' };
  if (status === 408 || status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfterMs(options.retryAfter, options.now);
    return retryAfterMs === undefined
      ? { outcome: 'RETRY', error: label }
      : { outcome: 'RETRY', error: label, retryAfterMs };
  }
  if (status >= 400) return { outcome: 'PERMANENT', error: label };
  return { outcome: 'RETRY', error: `unexpected ${label}` };
}

/** Retry-After as delta-seconds or an HTTP date; bounded to one hour. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^[0-9]+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now.getTime();
  }
  return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
}
