import { deriveRestockAttemptId } from './restock-attempt-identity';

type Common = Readonly<{
  senderId: string;
  branchId: string;
  sourceRequestId: string;
  decisionId: string;
  resolutionVersion: 2;
  attemptId: string;
  resolvedAt: string;
  applyBefore: string;
}>;
type Started = Readonly<{ sendToken: string; attemptedAt: string }>;
type Accepted = Started &
  Readonly<{
    providerMessageId: string;
    providerAcceptedObservedAt: string;
  }>;

/**
 * Inert snapshots, not history proofs or send/STALE authorization. Active
 * reservation/frozen subject binding and coordinator/DB CAS remain required.
 * sendToken identifies an immutable claim instance, unlike stable attemptId.
 * DELIVERY_UNKNOWN is deliberately not constructible: uncertain SEND_STARTED
 * stays held. Restart/lease expiry cannot establish sender closure; that
 * reconciliation proof must be specified separately before terminal UNKNOWN.
 */
export type RestockApplicationLedgerRow = Common &
  (
    | Readonly<{ state: 'PENDING_DELIVERY' }>
    | (Readonly<{ state: 'SEND_STARTED' }> & Started)
    | (Readonly<{ state: 'PROVIDER_ACCEPTED' }> & Accepted)
    | (Readonly<{ state: 'PROVIDER_ACCEPTED_LATE' }> & Accepted)
    | Readonly<{ state: 'STALE'; staleObservedAt: string }>
  );

const COMMON =
  'senderId branchId sourceRequestId decisionId resolutionVersion attemptId resolvedAt applyBefore state'.split(
    ' ',
  );
const STARTED = ['sendToken', 'attemptedAt'];
const ACCEPTED = [
  ...STARTED,
  'providerMessageId',
  'providerAcceptedObservedAt',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const nonblank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const opaque = (value: unknown): value is string =>
  nonblank(value) &&
  !Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? epoch
    : null;
}

/** Exact own plain data snapshot; never retain caller-owned objects. */
function snapshot(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const row = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    if (!Object.is(descriptor.value, (value as Record<string, unknown>)[key]))
      return null;
    row[key] = descriptor.value;
  }
  return row;
}

/** Fail closed without clocks, token minting, transitions or external effects. */
export function normalizeRestockApplicationLedgerRow(
  value: unknown,
): RestockApplicationLedgerRow | null {
  try {
    const row = snapshot(value);
    if (!row) return null;
    const state = row.state;
    const evidence =
      state === 'PENDING_DELIVERY'
        ? []
        : state === 'SEND_STARTED'
          ? STARTED
          : state === 'PROVIDER_ACCEPTED' || state === 'PROVIDER_ACCEPTED_LATE'
            ? ACCEPTED
            : state === 'STALE'
              ? ['staleObservedAt']
              : null;
    if (evidence === null) return null;
    const keys = [...COMMON, ...evidence];
    const own = Object.keys(row);
    if (own.length !== keys.length || own.some((key) => !keys.includes(key)))
      return null;
    if (
      !nonblank(row.senderId) ||
      row.senderId !== row.senderId.trim() ||
      !opaque(row.branchId) ||
      !uuid(row.sourceRequestId) ||
      !uuid(row.decisionId) ||
      row.resolutionVersion !== 2 ||
      row.attemptId !==
        deriveRestockAttemptId(row.sourceRequestId, row.decisionId)
    )
      return null;
    const resolved = instant(row.resolvedAt);
    const deadline = instant(row.applyBefore);
    if (
      resolved === null ||
      deadline === null ||
      deadline - resolved !== 3_600_000
    )
      return null;
    if (state === 'STALE') {
      const observed = instant(row.staleObservedAt);
      if (observed === null || observed < deadline) return null;
    } else if (state !== 'PENDING_DELIVERY') {
      if (!uuid(row.sendToken) || row.sendToken.toLowerCase() === row.attemptId)
        return null;
      const attempted = instant(row.attemptedAt);
      if (attempted === null || attempted < resolved || attempted >= deadline)
        return null;
      if (state !== 'SEND_STARTED') {
        const observed = instant(row.providerAcceptedObservedAt);
        if (
          !opaque(row.providerMessageId) ||
          observed === null ||
          observed < attempted
        )
          return null;
        if (
          state === 'PROVIDER_ACCEPTED'
            ? observed >= deadline
            : observed < deadline
        )
          return null;
      }
    }
    return Object.freeze(row) as RestockApplicationLedgerRow;
  } catch {
    return null;
  }
}
