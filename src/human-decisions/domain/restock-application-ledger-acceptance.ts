import {
  normalizeRestockApplicationLedgerRow as normalize,
  RestockApplicationLedgerRow as Row,
} from './restock-application-ledger-row';

type Started = Extract<Row, { state: 'SEND_STARTED' }>;
type Accepted = Extract<
  Row,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' }
>;
export type RestockApplicationAcceptanceDecision =
  | Readonly<{ action: 'propose_cas'; expected: Started; next: Accepted }>
  | Readonly<{ action: 'replay'; row: Accepted }>
  | Readonly<{
      action: 'hold';
      reason: 'invalid_snapshot' | 'conflict' | 'not_started';
    }>;

function snapshot(
  value: unknown,
  keys: string[],
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
    if (descriptor.value === undefined) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
const hold = (
  reason: Extract<
    RestockApplicationAcceptanceDecision,
    { action: 'hold' }
  >['reason'],
): RestockApplicationAcceptanceDecision =>
  Object.freeze({ action: 'hold', reason });

/**
 * Inert recommendations only, not provider provenance, current ownership or
 * sender quiescence proof. Adapters must establish those and perform real CAS.
 * Acceptance is not delivery and grants neither ACK nor send authority.
 * Recovery, timeouts and crashes cannot supply acceptance evidence here.
 */
export function classifyRestockApplicationAcceptance(
  input: unknown,
): RestockApplicationAcceptanceDecision {
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
    if (row.state === 'PENDING_DELIVERY' || row.state === 'STALE')
      return hold('not_started');
    if (
      event.attemptId !== row.attemptId ||
      typeof event.sendToken !== 'string' ||
      event.sendToken.toLowerCase() !== row.sendToken.toLowerCase()
    )
      return hold('conflict');
    if (row.state !== 'SEND_STARTED') {
      if (
        event.providerMessageId !== row.providerMessageId ||
        event.providerAcceptedObservedAt !== row.providerAcceptedObservedAt
      )
        return hold('conflict');
      return Object.freeze({ action: 'replay', row });
    }
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
