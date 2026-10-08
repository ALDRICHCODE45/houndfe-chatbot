import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import { normalizeExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import { classifyExpirationApplication } from '../domain/expiration-application-policy';
import type { ExpirationExistingDecisionOutcome } from './expiration-existing-decision.service';
import {
  createExpirationPreparationCandidate,
  type ExpirationPreparationCandidate,
} from './expiration-preparation-candidate';

type Resolved = Extract<
  ExpirationExistingDecisionOutcome,
  { outcome: 'resolved' }
>;
export type ExpirationOutcomeContext =
  | ExpirationPreparationCandidate
  | Resolved;

/** Terminal-only validation, never send authority. Resolved evidence is accepted
 * only for STALE written by the guarded local stale-store transaction (exact
 * PENDING transition or conflict-safe insertion from explicit absence).
 * This relies on controlled application writers, not shape as historical proof;
 * out-of-band sends/manual ledger writes are outside that trust boundary.
 * staleObservedAt is preserved evidence of expiry, not a reconstructed candidate
 * check time. Callers must still bind and reread durable context/row/ACK.
 */
export function validateExpirationOutcomeContext(
  input: ExpirationOutcomeContext,
  terminal: unknown,
): ExpirationOutcomeContext | Readonly<{ action: 'hold' }> {
  try {
    if ('action' in input) {
      if (input.action !== 'candidate') return { action: 'hold' };
      return createExpirationPreparationCandidate(
        input.binding.reservation.senderId,
        {
          outcome: 'resolved',
          binding: input.binding,
          decision: input.decision,
        },
        input.checkedAt,
      );
    }
    if (input.outcome !== 'resolved') return { action: 'hold' };
    const row = normalizeExpirationApplicationLedgerRow(terminal);
    const decision = normalizeExpirationDecision(input.decision);
    if (row?.state !== 'STALE' || decision?.status !== 'RESOLVED')
      return { action: 'hold' };
    const binding = {
      ...input.binding,
      reservation: {
        ...input.binding.reservation,
        intake: { ...input.binding.reservation.intake },
      },
    };
    const policy = classifyExpirationApplication({
      senderId: row.senderId,
      branchId: binding.branchId,
      reservation: binding.reservation,
      backendDecisionId: binding.backendDecisionId,
      decision,
      now: row.staleObservedAt,
    });
    if (policy.classification !== 'expired') return { action: 'hold' };
    Object.freeze(binding.reservation.intake);
    Object.freeze(binding.reservation);
    Object.freeze(binding);
    Object.freeze(decision.snapshot);
    Object.freeze(decision.resolution);
    return Object.freeze({
      outcome: 'resolved',
      binding,
      decision: Object.freeze(decision),
    });
  } catch {
    return { action: 'hold' };
  }
}
