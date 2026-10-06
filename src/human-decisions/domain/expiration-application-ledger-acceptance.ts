import {
  normalizeExpirationApplicationLedgerRow as normalize,
  type ExpirationApplicationLedgerRow as Row,
} from './expiration-application-ledger-row';

type Started = Extract<Row, { state: 'SEND_STARTED' }>;
type Accepted = Extract<
  Row,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' }
>;
export type ExpirationApplicationAcceptanceDecision =
  | Readonly<{ action: 'propose_cas'; expected: Started; next: Accepted }>
  | Readonly<{
      action: 'hold';
      reason: 'invalid_snapshot' | 'not_started' | 'conflict';
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
    ExpirationApplicationAcceptanceDecision,
    { action: 'hold' }
  >['reason'],
): ExpirationApplicationAcceptanceDecision =>
  Object.freeze({ action: 'hold', reason });

/** Pure, inactive recommendation for a definite successful provider response.
 * Its provenance and fresh observation time are trusted caller prerequisites;
 * a message ID alone cannot establish acceptance, much less device delivery.
 * Exact attempt/token bytes bind the event to the original started snapshot.
 * Only SEND_STARTED can propose acceptance; terminal observations hold without
 * replay, overwrite, ACK, closure or resend. Ambiguous results stay held.
 * No I/O, CAS, clocks, token minting, runtime wiring or WhatsApp eligibility. */
export function classifyExpirationApplicationAcceptance(
  input: unknown,
): ExpirationApplicationAcceptanceDecision {
  try {
    const envelope = snapshot(input, ['row', 'event']);
    if (!envelope) return hold('invalid_snapshot');
    const row = normalize(envelope.row);
    const event = snapshot(envelope.event, [
      'kind',
      'attemptId',
      'sendToken',
      'providerMessageId',
      'providerAcceptedObservedAt',
    ]);
    if (!row || !event || event.kind !== 'provider_accepted')
      return hold('invalid_snapshot');
    if (row.state !== 'SEND_STARTED') return hold('not_started');
    if (event.attemptId !== row.attemptId || event.sendToken !== row.sendToken)
      return hold('conflict');
    const observed = event.providerAcceptedObservedAt;
    const next = normalize({
      ...row,
      state:
        typeof observed === 'string' &&
        Date.parse(observed) < Date.parse(row.applyBefore)
          ? 'PROVIDER_ACCEPTED'
          : 'PROVIDER_ACCEPTED_LATE',
      providerMessageId: event.providerMessageId,
      providerAcceptedObservedAt: observed,
    });
    if (
      !next ||
      (next.state !== 'PROVIDER_ACCEPTED' &&
        next.state !== 'PROVIDER_ACCEPTED_LATE')
    )
      return hold('invalid_snapshot');
    return Object.freeze({ action: 'propose_cas', expected: row, next });
  } catch {
    return hold('invalid_snapshot');
  }
}
