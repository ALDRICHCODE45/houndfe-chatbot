import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';

/**
 * Shared dependencies injected into every sale-flow tool factory.
 *
 * Every factory exposes the SAME deps shape so `RealToolRegistry` can
 * wire them uniformly. `cashierUserId` is only consumed by `createSale`;
 * bank data flows through the runtime `getPaymentDetails` tool (Q1 / R11).
 */
export interface ToolDeps {
  chatbotApi: ChatbotApiClient;
  store: ConversationStore;
  cashierUserId: string;
}
