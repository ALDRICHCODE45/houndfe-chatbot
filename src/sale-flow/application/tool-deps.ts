import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { RestockExistingRequestStatusService } from '../../human-decisions/application/restock-existing-request-status.service';
import type { RestockIntakeService } from '../../human-decisions/application/restock-intake.service';
import type { SharedRouteMarkersPort } from '../../human-decisions/domain/shared-route-markers';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';

/**
 * WU2B runtime RESTOCK capability, threaded into the shared deps ONLY while the
 * experimental gate is exactly `true`.
 *
 * `markers` + `coordinator` serve the NEW intake route. `recovery` is the
 * read-only seam for an ALREADY accepted request whose preflight blocks with
 * `existing_restock`: it can never POST, reserve, release or fall back to legacy.
 */
export interface RestockToolCapability {
  readonly enabled: true;
  readonly markers: SharedRouteMarkersPort;
  readonly coordinator: Pick<RestockIntakeService, 'coordinate'>;
  readonly recovery: Pick<RestockExistingRequestStatusService, 'recover'>;
  /**
   * Bounded, on-demand expired-only reconciliation of THIS sender's recorded
   * old RESTOCK request. Optional so the main registry keeps its exact legacy
   * wiring; the minimal confirmation factory provides it. A `true` result
   * means the old reservation was durably ACKed and closed, never a send.
   */
  readonly reconcileExpired?: (senderId: string) => Promise<boolean>;
}

/**
 * Shared dependencies injected into every sale-flow tool factory.
 *
 * Every factory except the zero-dep `attachReceipt` compatibility tool
 * exposes the SAME deps shape so `RealToolRegistry` can wire them
 * uniformly. `cashierUserId` is only consumed by `createSale`; bank data
 * flows through the runtime `getPaymentDetails` tool (Q1 / R11);
 * `humanHandoffService` is consumed only by `requestHumanAssistance`
 * (the 12th tool) — the other 11 are signal-only and never call the
 * handoff service directly (ADR-27).
 */
export interface ToolDeps {
  chatbotApi: ChatbotApiClient;
  store: ConversationStore;
  cashierUserId: string;
  humanHandoffService: HumanHandoffService;
  /**
   * ABSENT while the experimental RESTOCK gate is off, so the legacy deps stay
   * byte-identical; present only when the gate reads exactly `true`.
   */
  restock?: RestockToolCapability;
}
