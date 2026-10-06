import {
  bindExpirationApplicationOutcomeAck,
  type ExpirationApplicationAckBinding,
} from './expiration-application-ledger-ack-binding';

type BoundAck = Extract<ExpirationApplicationAckBinding, { action: 'bound' }>;
type CompletionRow = Extract<
  BoundAck['expected'],
  { state: 'PROVIDER_ACCEPTED' | 'STALE' }
>;
export type ExpirationApplicationCompletionPreparation =
  | Readonly<{
      action: 'prepared';
      expected: CompletionRow;
      receipt: BoundAck['receipt'];
    }>
  | Readonly<{ action: 'hold' }>;

const HOLD = Object.freeze({ action: 'hold' as const });

/** INACTIVE eligibility only, never permission to close a reservation.
 * The caller must separately prove trusted ACK provenance, the exact durable
 * row/ACK and current reservation identity before an atomic close. STALE also
 * requires no-send history. No HTTP, clock, write, retry or closure occurs here;
 * a valid reporting ACK for LATE must still leave the reservation held.
 */
export function prepareExpirationApplicationCompletion(
  row: unknown,
  receipt: unknown,
): ExpirationApplicationCompletionPreparation {
  // Inspect only the validated detached snapshot, never caller-owned fields.
  const bound = bindExpirationApplicationOutcomeAck(row, receipt);
  if (bound.action !== 'bound') return HOLD;
  const expected = bound.expected;
  if (expected.state !== 'PROVIDER_ACCEPTED' && expected.state !== 'STALE')
    return HOLD;
  return Object.freeze({
    action: 'prepared',
    expected,
    receipt: bound.receipt,
  });
}
