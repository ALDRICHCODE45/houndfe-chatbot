/**
 * HD-R3b3-c1 — pure, default-off RESTOCK POST ledger state machine. It decides
 * the only legal next step for one RESTOCK `(senderId, sourceRequestId)` row
 * across RESERVED → POST_IN_FLIGHT → RECEIPT_RECORDED | UNKNOWN. No DB, HTTP,
 * DI or send; a later fenced SQL CAS adapter applies these outcomes.
 *
 * `sourceRequestId` is CALLER-OWNED: it must come from a stable inbound-event
 * binding. Never mint a fresh `randomUUID` per retry and never assume webhook
 * dedup alone provides it.
 */

export type RestockPostState =
  | 'RESERVED'
  | 'POST_IN_FLIGHT'
  | 'RECEIPT_RECORDED'
  | 'UNKNOWN';

export interface RestockPostRow {
  readonly status: RestockPostState;
  readonly senderId: string;
  readonly sourceRequestId: string;
  readonly backendDecisionId: string | null;
}

export type RestockPostStep =
  | { readonly kind: 'begin_post' }
  | { readonly kind: 'record_receipt'; readonly backendDecisionId: string }
  | { readonly kind: 'mark_unknown' };

export interface RestockPostClassifyInput {
  readonly senderId: string;
  readonly sourceRequestId: string;
  readonly existing: RestockPostRow | 'absent' | 'unknown';
  readonly step: RestockPostStep;
}

export type RestockPostBlockedReason =
  | 'malformed_input'
  | 'missing_row'
  | 'unknown_row'
  | 'malformed_row'
  | 'sender_mismatch'
  | 'invalid_backend_decision_id'
  | 'not_in_flight'
  | 'unknown_state'
  | 'receipt_recorded';

export type RestockPostDecision =
  | { readonly action: 'authorize_post' }
  | {
      readonly action: 'hold';
      readonly reason: 'post_in_flight' | 'unknown_state' | 'already_unknown';
    }
  | {
      readonly action: 'historical_receipt';
      readonly backendDecisionId: string;
    }
  | { readonly action: 'record_receipt'; readonly backendDecisionId: string }
  | { readonly action: 'replay_receipt'; readonly backendDecisionId: string }
  | { readonly action: 'conflict'; readonly storedBackendDecisionId: string }
  | {
      readonly action: 'mark_unknown';
      readonly reason: 'pre_post' | 'ambiguous_post';
    }
  | { readonly action: 'blocked'; readonly reason: RestockPostBlockedReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEYS = ['senderId', 'sourceRequestId', 'existing', 'step'];
const ROW_KEYS = ['status', 'senderId', 'sourceRequestId', 'backendDecisionId'];
const STEP_KEYS: Record<RestockPostStep['kind'], readonly string[]> = {
  begin_post: ['kind'],
  record_receipt: ['kind', 'backendDecisionId'],
  mark_unknown: ['kind'],
};
const blocked = (reason: RestockPostBlockedReason): RestockPostDecision => ({
  action: 'blocked',
  reason,
});
const nonBlank = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const isState = (v: unknown): v is RestockPostState =>
  v === 'RESERVED' ||
  v === 'POST_IN_FLIGHT' ||
  v === 'RECEIPT_RECORDED' ||
  v === 'UNKNOWN';
const isStepKind = (v: unknown): v is RestockPostStep['kind'] =>
  v === 'begin_post' || v === 'record_receipt' || v === 'mark_unknown';
const hasExactKeys = (value: unknown, keys: readonly string[]): boolean => {
  if (value === null || typeof value !== 'object') return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string' && keys.includes(key))
  );
};

/** Null-prototype snapshot of exact own data descriptors; a symbol key, an
 * accessor, a non-plain prototype, or a descriptor/read mismatch fails closed,
 * so a hostile or mutating Proxy cannot change a value after validation. */
function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const proto = Reflect.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    const read = (value as Record<string, unknown>)[key];
    if (!Object.is(descriptor.value, read)) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** Verified exact row, or the reason it cannot be trusted. */
function verifiedRow(
  existing: unknown,
  senderId: string,
  sourceRequestId: string,
): RestockPostRow | RestockPostBlockedReason {
  if (existing === 'absent') return 'missing_row';
  if (existing === 'unknown') return 'unknown_row';
  const record = asPlainRecord(existing);
  if (record === null || !hasExactKeys(record, ROW_KEYS)) {
    return 'malformed_row';
  }
  const status = record.status;
  const rowSender = record.senderId;
  const rowSource = record.sourceRequestId;
  const backend = record.backendDecisionId;
  if (!isState(status) || !nonBlank(rowSender) || !nonBlank(rowSource)) {
    return 'malformed_row';
  }
  // Only RECEIPT_RECORDED may carry a UUID backend id; every other state must
  // hold the exact persisted null (never a leaked or partial id).
  if (backend === null) {
    if (status === 'RECEIPT_RECORDED') return 'malformed_row';
  } else if (typeof backend !== 'string' || !UUID.test(backend)) {
    return 'malformed_row';
  } else if (status !== 'RECEIPT_RECORDED') {
    return 'malformed_row';
  }
  if (rowSender !== senderId || rowSource !== sourceRequestId) {
    return 'sender_mismatch';
  }
  return {
    status,
    senderId: rowSender,
    sourceRequestId: rowSource,
    backendDecisionId: backend,
  };
}

function snapshotStep(
  raw: unknown,
): RestockPostStep | RestockPostBlockedReason {
  const record = asPlainRecord(raw);
  const kind = record?.kind;
  if (
    record === null ||
    !isStepKind(kind) ||
    !hasExactKeys(record, STEP_KEYS[kind])
  ) {
    return 'malformed_input';
  }
  if (kind === 'record_receipt') {
    const id = record.backendDecisionId;
    return typeof id === 'string' && UUID.test(id)
      ? { kind: 'record_receipt', backendDecisionId: id }
      : 'invalid_backend_decision_id';
  }
  return { kind };
}

function beginPost(row: RestockPostRow): RestockPostDecision {
  switch (row.status) {
    case 'RESERVED':
      return { action: 'authorize_post' };
    case 'POST_IN_FLIGHT':
      return { action: 'hold', reason: 'post_in_flight' };
    case 'UNKNOWN':
      return { action: 'hold', reason: 'unknown_state' };
    case 'RECEIPT_RECORDED':
      return {
        action: 'historical_receipt',
        backendDecisionId: row.backendDecisionId as string,
      };
  }
}

function recordReceipt(
  row: RestockPostRow,
  backendDecisionId: string,
): RestockPostDecision {
  switch (row.status) {
    case 'POST_IN_FLIGHT':
      return { action: 'record_receipt', backendDecisionId };
    case 'RECEIPT_RECORDED':
      return row.backendDecisionId === backendDecisionId
        ? { action: 'replay_receipt', backendDecisionId }
        : {
            action: 'conflict',
            storedBackendDecisionId: row.backendDecisionId as string,
          };
    case 'RESERVED':
      return blocked('not_in_flight');
    case 'UNKNOWN':
      return blocked('unknown_state');
  }
}

function markUnknown(row: RestockPostRow): RestockPostDecision {
  switch (row.status) {
    case 'RESERVED':
      return { action: 'mark_unknown', reason: 'pre_post' };
    case 'POST_IN_FLIGHT':
      return { action: 'mark_unknown', reason: 'ambiguous_post' };
    case 'UNKNOWN':
      return { action: 'hold', reason: 'already_unknown' };
    case 'RECEIPT_RECORDED':
      return blocked('receipt_recorded');
  }
}

/**
 * Pure decision for one verified step. Only a `RESERVED` row authorizes exactly
 * one POST; in-flight/unknown hold with no POST; a recorded receipt replays its
 * historical id, and any malformed/unknown/mismatched row fails closed.
 */
export function classifyPostTransition(
  input: RestockPostClassifyInput,
): RestockPostDecision {
  try {
    const record = asPlainRecord(input);
    if (record === null || !hasExactKeys(record, INPUT_KEYS)) {
      return blocked('malformed_input');
    }
    const senderId = record.senderId;
    const sourceRequestId = record.sourceRequestId;
    if (
      !nonBlank(senderId) ||
      typeof sourceRequestId !== 'string' ||
      !UUID.test(sourceRequestId)
    ) {
      return blocked('malformed_input');
    }
    const step = snapshotStep(record.step);
    if (typeof step === 'string') return blocked(step);

    const row = verifiedRow(record.existing, senderId, sourceRequestId);
    if (typeof row === 'string') return blocked(row);

    switch (step.kind) {
      case 'begin_post':
        return beginPost(row);
      case 'record_receipt':
        return recordReceipt(row, step.backendDecisionId);
      case 'mark_unknown':
        return markUnknown(row);
    }
  } catch {
    return blocked('malformed_input');
  }
}

export interface RestockPostStartInput {
  readonly senderId: string;
  readonly sourceRequestId: string;
}

export interface RestockPostReceiptInput extends RestockPostStartInput {
  readonly backendDecisionId: string;
}

/**
 * Narrow fenced CAS boundary for a later Postgres adapter. The adapter MUST read
 * the exact `(senderId, sourceRequestId)` row, apply `classifyPostTransition`,
 * and persist only the returned transition atomically; it must never mint a
 * fresh `sourceRequestId` and never auto-retry an ambiguous POST.
 */
export interface RestockPostLedgerPort {
  beginPost(input: RestockPostStartInput): Promise<RestockPostDecision>;
  recordReceipt(input: RestockPostReceiptInput): Promise<RestockPostDecision>;
  markUnknown(input: RestockPostStartInput): Promise<RestockPostDecision>;
}
