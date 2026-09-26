import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  normalizeRestockDecision,
  normalizeRestockIntake,
  type RestockDecisionResolved,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  classifyRestockApplication,
  type RestockApplicationDecision as Policy,
} from '../domain/restock-application-policy';
import type {
  PostgresRestockApplicationContextStore as ContextStore,
  RecordedRestockContext,
} from '../infrastructure/postgres-restock-application-context.store';
type Frozen<T> = { readonly [K in keyof T]: Frozen<T[K]> };
export type RestockCandidateResult =
  | { readonly action: 'hold' | 'pending' }
  | {
      readonly action: 'candidate';
      readonly context: Frozen<RecordedRestockContext>;
      readonly decision: Frozen<RestockDecisionResolved>;
      readonly classification: Extract<Policy, { action: 'ready' | 'stale' }>;
      readonly checkedAt: string;
    };
const HOLD = Object.freeze({ action: 'hold' as const });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Unwired snapshot, NOT permission/ownership/provenance or a claim/ACK.
 * Not atomic: future transaction must lock/re-read/compare full context and
 * reevaluate fresh policy. Context lacks full historical receipt; lastMessageAt
 * is not trusted 24h evidence; original receive-phone binding is absent.
 * T3d legacy truth remains a release blocker, without waiver. */
export class RestockApplicationCandidateService {
  constructor(
    private readonly reader: Pick<ContextStore, 'readRecordedForSender'>,
    private readonly backend: Pick<ChatbotApiClient, 'getRestockDecision'>,
    private readonly branchId: string,
    private readonly clock: () => Date,
  ) {}

  async pollForSender(
    senderId: string,
    expectedSourceRequestId?: string,
  ): Promise<RestockCandidateResult> {
    try {
      if (
        typeof this.branchId !== 'string' ||
        !this.branchId.trim() ||
        typeof senderId !== 'string' ||
        !senderId ||
        senderId !== senderId.trim() ||
        Array.from(senderId).some((c) => {
          const n = c.charCodeAt(0);
          return n <= 31 || (n >= 127 && n <= 159);
        })
      )
        return HOLD;
      const read = await this.reader.readRecordedForSender(senderId);
      if (read?.action !== 'recorded') return HOLD;
      // Trusted validated snapshot port; defensive binding, not a general parser.
      const reservation = { ...read.context.reservation };
      reservation.intake = { ...reservation.intake };
      const context = { ...read.context, reservation };
      const intake = normalizeRestockIntake(reservation.intake);
      if (
        reservation.senderId !== senderId ||
        reservation.status !== 'ACTIVE' ||
        reservation.route !== 'RESTOCK' ||
        !intake ||
        Object.keys(reservation.intake).length !== Object.keys(intake).length ||
        Object.entries(intake).some(
          ([k, v]) =>
            !Object.is(reservation.intake[k as keyof typeof intake], v),
        ) ||
        reservation.requestKey !== intake.sourceRequestId ||
        (expectedSourceRequestId !== undefined &&
          expectedSourceRequestId !== reservation.requestKey) ||
        typeof context.backendDecisionId !== 'string' ||
        !UUID.test(context.backendDecisionId)
      )
        return HOLD;
      Object.freeze(reservation.intake);
      Object.freeze(reservation);
      Object.freeze(context);
      const decision = normalizeRestockDecision(
        await this.backend.getRestockDecision(context.backendDecisionId),
      );
      if (!decision) return HOLD;
      const checkedAt = Date.prototype.toISOString.call(this.clock());
      const classification = classifyRestockApplication({
        senderId,
        branchId: this.branchId,
        reservation,
        backendDecisionId: context.backendDecisionId,
        decision,
        now: checkedAt,
      });
      if (classification.action === 'hold') return HOLD;
      if (classification.action === 'pending')
        return Object.freeze({ action: 'pending' });
      if (decision.status !== 'RESOLVED') return HOLD;
      Object.freeze(decision.snapshot);
      Object.freeze(decision.resolution);
      return Object.freeze({
        action: 'candidate',
        context,
        decision: Object.freeze(decision),
        classification: Object.freeze(classification),
        checkedAt,
      });
    } catch {
      return HOLD;
    }
  }
}
