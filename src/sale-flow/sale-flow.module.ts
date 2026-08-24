import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { ConversationModule } from '../conversation/conversation.module';
import { BANK_DETAILS_PROVIDER } from './domain/bank-details.provider';
import { RealToolRegistry } from './infrastructure/real-tool-registry';
import { NullBankDetailsProvider } from './infrastructure/null-bank-details.provider';

/**
 * SaleFlowModule
 *
 * Composition root for the nine sale-flow tools + the cart state +
 * the swappable `BankDetailsProvider` seam. `LlmAgentModule` imports
 * this module and binds `TOOL_REGISTRY` to `RealToolRegistry`
 * (`useExisting` so rollback to `InMemoryToolRegistry` stays a one-line
 * revert).
 *
 * Module graph:
 *   - imports ChatbotApiModule + ConversationModule (transitively
 *     CHATBOT_API_CLIENT + CONVERSATION_STORE)
 *   - provides RealToolRegistry (the production registry)
 *   - provides BANK_DETAILS_PROVIDER (default: NullBankDetailsProvider)
 *   - exports RealToolRegistry + BANK_DETAILS_PROVIDER for downstream
 *     feature modules (e.g., the prompt factory in LlmAgentModule).
 */
@Module({
  imports: [ChatbotApiModule, ConversationModule],
  providers: [
    RealToolRegistry,
    {
      provide: BANK_DETAILS_PROVIDER,
      useClass: NullBankDetailsProvider,
    },
  ],
  exports: [RealToolRegistry, BANK_DETAILS_PROVIDER],
})
export class SaleFlowModule {}
