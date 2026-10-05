/** INACTIVE, unwired EXPIRATION application composition: a plain class with no
 * DI, Nest decorator, module wiring or runtime instantiation. It composes the
 * already-reviewed reader->GET service with the pure application policy: one
 * `readExistingDecision(senderId)` call, then a single clock sample taken AFTER
 * the await (so it includes the real GET latency) is fed to the REAL policy
 * together with the service's trusted branch binding. Held and failed reads
 * short-circuit before the clock, and no outcome authorizes a send, ACK, STALE
 * or reservation change. It never inspects current browsing and never rebinds
 * the original inquiry. Nothing is sent or written. */
import {
  classifyExpirationApplication,
  type ExpirationApplicationClassification,
} from '../domain/expiration-application-policy';
import type {
  ExpirationExistingDecisionOutcome,
  ExpirationExistingDecisionService,
} from './expiration-existing-decision.service';

/** Closed result union: the two short-circuit query stages, or the full policy
 * classification (its `held` reason stays nested and is never dropped). The
 * binding and decision are deliberately NOT projected as a delivery payload. */
export type ExpirationApplicationClassifierResult =
  | { readonly stage: 'query_held' }
  | { readonly stage: 'query_failed' }
  | {
      readonly stage: 'classified';
      readonly classification: ExpirationApplicationClassification;
    };

const QUERY_HELD: ExpirationApplicationClassifierResult = Object.freeze({
  stage: 'query_held' as const,
});
const QUERY_FAILED: ExpirationApplicationClassifierResult = Object.freeze({
  stage: 'query_failed' as const,
});

/** Read the trusted clock exactly once and render a canonical UTC instant. An
 * out-of-range Date, a non-Date value or a throwing clock yields `null`, which
 * the policy maps to `held invalid_clock` — a bad clock never escapes as text. */
function readCanonicalNow(clock: () => Date): string | null {
  try {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  } catch {
    return null;
  }
}

export class ExpirationApplicationClassifier {
  constructor(
    private readonly service: Pick<
      ExpirationExistingDecisionService,
      'readExistingDecision'
    >,
    private readonly clock: () => Date,
  ) {}

  async classify(
    senderId: string,
  ): Promise<ExpirationApplicationClassifierResult> {
    let outcome: ExpirationExistingDecisionOutcome;
    try {
      outcome = await this.service.readExistingDecision(senderId);
    } catch {
      return QUERY_FAILED;
    }
    if (outcome.outcome === 'held') return QUERY_HELD;
    if (outcome.outcome === 'query_failed') return QUERY_FAILED;
    // The clock is read exactly once, strictly after the GET await, immediately
    // before the pure policy. A changed sender or browsing never rebinds here:
    // the trusted branch binding and the pre-await reservation come from the
    // service, not from any caller-supplied or currently browsed context.
    const classification = classifyExpirationApplication({
      senderId,
      branchId: outcome.binding.branchId,
      reservation: outcome.binding.reservation,
      backendDecisionId: outcome.binding.backendDecisionId,
      decision: outcome.decision,
      now: readCanonicalNow(this.clock),
    });
    return Object.freeze({ stage: 'classified' as const, classification });
  }
}
