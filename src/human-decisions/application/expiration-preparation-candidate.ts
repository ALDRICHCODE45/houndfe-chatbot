import {
  normalizeExpirationDecision,
  type ExpirationDecisionResolved,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import { classifyExpirationApplication } from '../domain/expiration-application-policy';
import type {
  ExpirationDecisionBinding,
  ExpirationExistingDecisionOutcome,
} from './expiration-existing-decision.service';

type Frozen<T> = { readonly [K in keyof T]: Frozen<T[K]> };
export type ExpirationPreparationCandidate = Readonly<{
  action: 'candidate';
  binding: ExpirationDecisionBinding;
  decision: Frozen<ExpirationDecisionResolved>;
  checkedAt: string;
}>;
export type ExpirationPreparationCandidateResult =
  | ExpirationPreparationCandidate
  | Readonly<{ action: 'hold' }>;
const HOLD = Object.freeze({ action: 'hold' as const });

/** Pure, inactive preparation INPUT, not a prepared row or authority to send.
 * The sender and existing-service outcome are trusted caller prerequisites;
 * checkedAt must be sampled by the caller after its read/GET await. A timestamp
 * supplied here proves no freshness at a later write. Future preparation must
 * lock/re-read/compare the original context and reclassify with a fresh clock.
 * Pending, expired, failed or invalid observations hold without side effects.
 * No I/O, attempt creation, reservation mutation, START, ACK or STALE marking.
 * This does not prove ownership, remote immutability or WhatsApp eligibility. */
export function createExpirationPreparationCandidate(
  senderId: string,
  outcome: ExpirationExistingDecisionOutcome,
  checkedAt: string,
): ExpirationPreparationCandidateResult {
  try {
    if (outcome.outcome !== 'resolved') return HOLD;
    const decision = normalizeExpirationDecision(outcome.decision);
    if (decision?.status !== 'RESOLVED') return HOLD;
    // Detach before classification so validation and output use the same values.
    const binding: ExpirationDecisionBinding = {
      ...outcome.binding,
      reservation: {
        ...outcome.binding.reservation,
        intake: { ...outcome.binding.reservation.intake },
      },
    };
    const classification = classifyExpirationApplication({
      senderId,
      branchId: binding.branchId,
      reservation: binding.reservation,
      backendDecisionId: binding.backendDecisionId,
      decision,
      now: checkedAt,
    });
    if (classification.classification !== 'within_window') return HOLD;
    Object.freeze(binding.reservation.intake);
    Object.freeze(binding.reservation);
    Object.freeze(binding);
    Object.freeze(decision.snapshot);
    Object.freeze(decision.resolution);
    return Object.freeze({
      action: 'candidate',
      binding,
      decision: Object.freeze(decision),
      checkedAt,
    });
  } catch {
    return HOLD;
  }
}
