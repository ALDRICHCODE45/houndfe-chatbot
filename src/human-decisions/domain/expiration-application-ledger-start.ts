import {
  normalizeExpirationApplicationLedgerRow as normalize,
  type ExpirationApplicationLedgerRow as Row,
} from './expiration-application-ledger-row';

type Pending = Extract<Row, { state: 'PENDING_DELIVERY' }>;
type Started = Extract<Row, { state: 'SEND_STARTED' }>;
export type ExpirationApplicationStartDecision =
  | Readonly<{ action: 'propose_cas'; expected: Pending; next: Started }>
  | Readonly<{
      action: 'hold';
      reason: 'invalid_snapshot' | 'not_pending' | 'invalid_transition';
    }>;

function snapshot(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return null;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    if (!Object.is(descriptor.value, (value as Record<string, unknown>)[key]))
      return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
const hold = (
  reason: Extract<
    ExpirationApplicationStartDecision,
    { action: 'hold' }
  >['reason'],
): ExpirationApplicationStartDecision =>
  Object.freeze({ action: 'hold', reason });

/** Pure, inactive begin_send recommendation, never CAS or send authority.
 * Token/time are supplied observations, not minted identity or a fresh clock.
 * A future transaction must revalidate original reservation, trusted sender,
 * branch/subject, collisions and current time, then atomically claim expected.
 * WhatsApp service-window/template eligibility is separate from this 24h
 * decision window [resolvedAt, applyBefore). No SQL, I/O, retries, ACK or STALE
 * transition; expired/nonpending states hold. SEND_STARTED is not recoverable
 * send permission, and this proposal proves no persisted attempt or delivery. */
export function classifyExpirationApplicationStart(
  input: unknown,
): ExpirationApplicationStartDecision {
  try {
    const envelope = snapshot(input, ['row', 'event']);
    if (!envelope) return hold('invalid_snapshot');
    const row = normalize(envelope.row);
    const event = snapshot(envelope.event, [
      'kind',
      'sendToken',
      'attemptedAt',
    ]);
    if (!row || !event || event.kind !== 'begin_send')
      return hold('invalid_snapshot');
    if (row.state !== 'PENDING_DELIVERY') return hold('not_pending');
    const next = normalize({
      ...row,
      state: 'SEND_STARTED',
      sendToken: event.sendToken,
      attemptedAt: event.attemptedAt,
    });
    if (!next || next.state !== 'SEND_STARTED')
      return hold('invalid_transition');
    return Object.freeze({ action: 'propose_cas', expected: row, next });
  } catch {
    return hold('invalid_snapshot');
  }
}
