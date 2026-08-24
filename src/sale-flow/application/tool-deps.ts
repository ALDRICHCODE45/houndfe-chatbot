import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { BankDetailsProvider } from '../domain/bank-details.provider';

/**
 * Shared dependencies injected into every sale-flow tool factory.
 *
 * Every factory exposes the SAME deps shape so `RealToolRegistry` can
 * wire them uniformly. `cashierUserId` is only consumed by `createSale`;
 * the others are reserved for future bank-details / shipping tools
 * (Q1 / R2-R5 follow-up slices).
 */
export interface ToolDeps {
  chatbotApi: ChatbotApiClient;
  store: ConversationStore;
  bankDetails: BankDetailsProvider;
  cashierUserId: string;
}
