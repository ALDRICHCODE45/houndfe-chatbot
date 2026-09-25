import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { RestockIntakeService } from '../../human-decisions/application/restock-intake.service';
import type { SharedRouteMarkersPort } from '../../human-decisions/domain/shared-route-markers';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';

/**
 * WU2B runtime RESTOCK capability, threaded into the shared deps ONLY while the
 * experimental gate is exactly `true`. It is a carrier: no tool reads it yet,
 * so the flag cannot trigger a marker read, a reserve, or a POST.
 */
export interface RestockToolCapability {
  readonly enabled: true;
  readonly markers: SharedRouteMarkersPort;
  readonly coordinator: Pick<RestockIntakeService, 'coordinate'>;
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
   * byte-identical; present only when the gate reads exactly `true`. No tool
   * branches on it yet.
   */
  restock?: RestockToolCapability;
}
