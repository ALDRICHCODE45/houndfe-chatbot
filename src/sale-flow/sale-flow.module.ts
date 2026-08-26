import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { ConversationModule } from '../conversation/conversation.module';
import { HumanHandoffModule } from '../human-handoff/human-handoff.module';
import { RealToolRegistry } from './infrastructure/real-tool-registry';

/**
 * SaleFlowModule
 *
 * Composition root for the twelve sale-flow tools + the cart state.
 * `LlmAgentModule` imports this module and binds `TOOL_REGISTRY` to
 * `RealToolRegistry` (`useExisting` so rollback to `InMemoryToolRegistry`
 * stays a one-line revert).
 *
 * Module graph:
 *   - imports ChatbotApiModule + ConversationModule (transitively
 *     CHATBOT_API_CLIENT + CONVERSATION_STORE)
 *   - imports HumanHandoffModule (transitively HumanHandoffService +
 *     WHATSAPP_SENDER for the 12th tool `requestHumanAssistance`)
 *   - provides RealToolRegistry (the production registry)
 *   - exports RealToolRegistry
 *
 * Bank data flows through the runtime `getPaymentDetails` AI-SDK tool
 * (Q1 / R11); human-handoff flows through `requestHumanAssistance`
 * (human-handoff slice).
 */
@Module({
  imports: [ChatbotApiModule, ConversationModule, HumanHandoffModule],
  providers: [RealToolRegistry],
  exports: [RealToolRegistry],
})
export class SaleFlowModule {}
