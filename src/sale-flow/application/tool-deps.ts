import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';

/**
 * Shared dependencies injected into every sale-flow tool factory.
 *
 * Every factory exposes the SAME deps shape so `RealToolRegistry` can
 * wire them uniformly. `cashierUserId` is only consumed by `createSale`;
 * bank data flows through the runtime `getPaymentDetails` tool (Q1 / R11);
 * `humanHandoffService` is consumed only by `requestHumanAssistance`
 * (the 12th tool) — the other 11 are signal-only and never call the
 * handoff service directly (ADR-27).
 */
export interface ToolDeps {
  chatbotApi: ChatbotApiClient;
  store: ConversationStore;
  cashierUserId: string;
  humanHandoffService: HumanHandoffService;
}
