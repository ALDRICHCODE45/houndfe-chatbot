import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { ConversationModule } from '../conversation/conversation.module';
import { RealToolRegistry } from './infrastructure/real-tool-registry';

/**
 * SaleFlowModule
 *
 * Composition root for the ten sale-flow tools + the cart state.
 * `LlmAgentModule` imports this module and binds `TOOL_REGISTRY` to
 * `RealToolRegistry` (`useExisting` so rollback to `InMemoryToolRegistry`
 * stays a one-line revert).
 *
 * Module graph:
 *   - imports ChatbotApiModule + ConversationModule (transitively
 *     CHATBOT_API_CLIENT + CONVERSATION_STORE)
 *   - provides RealToolRegistry (the production registry)
 *   - exports RealToolRegistry
 *
 * Bank data flows through the runtime `getPaymentDetails` AI-SDK tool
 * (Q1 / R11) — there is no boot-time bank-details seam. The runtime
 * tool is registered by `RealToolRegistry`; nothing else injects bank
 * data anywhere.
 */
@Module({
  imports: [ChatbotApiModule, ConversationModule],
  providers: [RealToolRegistry],
  exports: [RealToolRegistry],
})
export class SaleFlowModule {}
