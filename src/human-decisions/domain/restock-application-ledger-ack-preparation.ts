import {
  normalizeRestockApplicationOutcome,
  type RestockApplicationOutcomeRequest,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  normalizeRestockApplicationLedgerRow,
  type RestockApplicationLedgerRow,
} from './restock-application-ledger-row';

type TerminalRow = Extract<
  RestockApplicationLedgerRow,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' | 'STALE' }
>;
export type RestockApplicationOutcomePreparation =
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

/** Inert projection only: not API permission, durable history/no-send proof,
 * or customer delivery evidence. Before reporting, an adapter must prove the
 * current exact terminal row. A caller-driven retry after a lost ACK reuses
 * this same request; preparation never mints an attempt or reconciles UNKNOWN.
 * `expected` is local-only; only `request` is the HTTP body.
 */
export function prepareRestockApplicationOutcome(
  value: unknown,
): RestockApplicationOutcomePreparation {
  const row = normalizeRestockApplicationLedgerRow(value);
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
  // Validation must not repair or rewrite even one projected value or key.
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
