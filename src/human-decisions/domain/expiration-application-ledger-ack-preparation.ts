import {
  normalizeRestockApplicationOutcome,
  type RestockApplicationOutcomeRequest,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  normalizeExpirationApplicationLedgerRow,
  type ExpirationApplicationLedgerRow,
} from './expiration-application-ledger-row';

type TerminalRow = Extract<
  ExpirationApplicationLedgerRow,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' | 'STALE' }
>;
export type ExpirationApplicationOutcomePreparation =
  | Readonly<{
      action: 'prepared';
      decisionId: string;
      expected: TerminalRow;
      request: Readonly<RestockApplicationOutcomeRequest>;
    }>
  | Readonly<{
      action: 'hold';
      reason: 'invalid_row' | 'nonterminal_row' | 'invalid_request';
    }>;

/** INACTIVE pure projection into the shared flat outcome contract.
 * A terminal shape is neither durable history nor permission to report it:
 * the caller must separately prove the current exact persisted terminal row.
 * STALE requires independent no-send proof; LATE never permits automatic
 * closure or retry. This does not send, persist an ACK, mint an attempt,
 * consult a clock, release a reservation, or reconcile ambiguous SEND_STARTED.
 * `expected` stays local; only `request` is the prospective HTTP body.
 */
export function prepareExpirationApplicationOutcome(
  value: unknown,
): ExpirationApplicationOutcomePreparation {
  const row = normalizeExpirationApplicationLedgerRow(value);
  if (!row) return Object.freeze({ action: 'hold', reason: 'invalid_row' });
  if (row.state === 'PENDING_DELIVERY' || row.state === 'SEND_STARTED') {
    return Object.freeze({ action: 'hold', reason: 'nonterminal_row' });
  }
  const base = {
    attemptId: row.attemptId,
    expectedResolutionVersion: 2 as const,
    outcome: row.state,
  };
  const request =
    row.state === 'STALE'
      ? base
      : {
          ...base,
          attemptedAt: row.attemptedAt,
          providerMessageId: row.providerMessageId,
          providerAcceptedObservedAt: row.providerAcceptedObservedAt,
        };
  const validated = normalizeRestockApplicationOutcome(request);
  // The shared parser must not repair or rewrite any projected key/value.
  if (!validated || JSON.stringify(validated) !== JSON.stringify(request)) {
    return Object.freeze({ action: 'hold', reason: 'invalid_request' });
  }
  return Object.freeze({
    action: 'prepared',
    decisionId: row.decisionId,
    expected: row,
    request: Object.freeze(validated),
  });
}
