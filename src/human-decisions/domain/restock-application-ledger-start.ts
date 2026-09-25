import {
  normalizeRestockApplicationLedgerRow as normalize,
  RestockApplicationLedgerRow as Row,
} from './restock-application-ledger-row';

type Pending = Extract<Row, { state: 'PENDING_DELIVERY' }>;
type Next = Extract<Row, { state: 'SEND_STARTED' | 'STALE' }>;
export type RestockApplicationStartDecision =
  | Readonly<{ action: 'propose_cas'; expected: Pending; next: Next }>
  | Readonly<{
      action: 'hold';
      reason: 'invalid_snapshot' | 'not_pending' | 'invalid_transition';
    }>;

function snapshot(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    if (!Object.is(descriptor.value, (value as Record<string, unknown>)[key]))
      return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}
const hold = (
  reason: Extract<
    RestockApplicationStartDecision,
    { action: 'hold' }
  >['reason'],
): RestockApplicationStartDecision => Object.freeze({ action: 'hold', reason });

/**
 * Recommendation only: grants no send authority or delivery evidence.
 * A future adapter must atomically compare the active reservation and expected
 * row/state; only one CAS winner may proceed through coordinator checks.
 * Sender/branch/frozen subject and WhatsApp 24h eligibility remain external:
 * the one-hour row window is insufficient. Recovery of SEND_STARTED always
 * holds, never retries or infers STALE/UNKNOWN. Outcome replay is separate.
 */
export function classifyRestockApplicationStart(
  input: unknown,
): RestockApplicationStartDecision {
  try {
    const envelope = snapshot(input);
    if (!envelope || !exact(envelope, ['row', 'event']))
      return hold('invalid_snapshot');
    const row = normalize(envelope.row);
    const event = snapshot(envelope.event);
    if (!row || !event) return hold('invalid_snapshot');
    const begin = event.kind === 'begin_send';
    const expire = event.kind === 'expire_unsent';
    if (
      (!begin && !expire) ||
      !exact(
        event,
        begin ? ['kind', 'sendToken', 'attemptedAt'] : ['kind', 'observedAt'],
      )
    )
      return hold('invalid_snapshot');
    if (row.state !== 'PENDING_DELIVERY') return hold('not_pending');
    const next = normalize(
      begin
        ? {
            ...row,
            state: 'SEND_STARTED',
            sendToken: event.sendToken,
            attemptedAt: event.attemptedAt,
          }
        : { ...row, state: 'STALE', staleObservedAt: event.observedAt },
    );
    if (!next || (next.state !== 'SEND_STARTED' && next.state !== 'STALE'))
      return hold('invalid_transition');
    return Object.freeze({ action: 'propose_cas', expected: row, next });
  } catch {
    return hold('invalid_snapshot');
  }
}
