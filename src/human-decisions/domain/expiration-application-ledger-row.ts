import { deriveExpirationAttemptId } from './expiration-attempt-identity';

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

/** INACTIVE inert snapshots, not persisted history or transition authority.
 * PENDING_DELIVERY describes application of a RESOLVED v2 decision, not a
 * backend PENDING decision. Shape checks prove neither original inquiry/sender
 * binding nor acquisition/CAS, provider acceptance, ACK or closure. A STALE
 * shape does not prove that no send started. Those require separate evidence.
 * sendToken identifies a claim instance, unlike stable attemptId. Ambiguous
 * SEND_STARTED stays held: DELIVERY_UNKNOWN is not constructible here, and
 * restart/timeout never authorizes retry or closure. No runtime wiring. */
export type ExpirationApplicationLedgerRow = Common &
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
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 36 && UUID.test(value);
/** Original ids match the GET projection verbatim; do not fold or trim them. */
const canonicalUuid = (value: unknown): value is string =>
  uuid(value) && value === value.toLowerCase();
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

/** Fail closed without clocks, token minting, transitions or external effects.
 * Branch is only nonblank, preserving the EXPIRATION policy's opaque bytes. */
export function normalizeExpirationApplicationLedgerRow(
  value: unknown,
): ExpirationApplicationLedgerRow | null {
  try {
    const row = snapshot(value);
    if (!row) return null;
    const state = row.state;
    let evidence: readonly string[];
    switch (state) {
      case 'PENDING_DELIVERY':
        evidence = [];
        break;
      case 'SEND_STARTED':
        evidence = STARTED;
        break;
      case 'PROVIDER_ACCEPTED':
      case 'PROVIDER_ACCEPTED_LATE':
        evidence = ACCEPTED;
        break;
      case 'STALE':
        evidence = ['staleObservedAt'];
        break;
      default:
        return null;
    }
    const keys = [...COMMON, ...evidence];
    const own = Object.keys(row);
    if (own.length !== keys.length || own.some((key) => !keys.includes(key)))
      return null;
    if (
      !opaque(row.senderId) ||
      row.senderId !== row.senderId.trim() ||
      !nonblank(row.branchId) ||
      !canonicalUuid(row.sourceRequestId) ||
      !canonicalUuid(row.decisionId) ||
      row.resolutionVersion !== 2 ||
      row.attemptId !==
        deriveExpirationAttemptId(row.sourceRequestId, row.decisionId)
    )
      return null;
    const resolved = instant(row.resolvedAt);
    const deadline = instant(row.applyBefore);
    if (
      resolved === null ||
      deadline === null ||
      deadline - resolved !== 86_400_000
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
    return Object.freeze(row) as ExpirationApplicationLedgerRow;
  } catch {
    return null;
  }
}
