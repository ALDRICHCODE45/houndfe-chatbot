import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { ConversationModule } from '../conversation/conversation.module';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { HumanHandoffModule } from '../human-handoff/human-handoff.module';
import { ShippingModule } from '../shipping/shipping.module';
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
 *   - imports HumanDecisionsModule DIRECTLY: it supplies SHARED_ROUTE_MARKERS +
 *     RESTOCK_INTAKE_SERVICE for the optional WU2B RESTOCK capability, and
 *     HumanHandoffModule does NOT re-export them
 *   - imports the default-off `ShippingModule.forRoot()` (SQ-5A): this is the
 *     single dynamic shipping import in the whole application graph, so the
 *     optional `ShippingQuoteOrchestrator` is reachable only when shipping is
 *     enabled. `AppModule` reaches it transitively.
 *   - provides RealToolRegistry (the production registry)
 *   - exports RealToolRegistry
 *
 * Bank data flows through the runtime `getPaymentDetails` AI-SDK tool
 * (Q1 / R11); human-handoff flows through `requestHumanAssistance`
 * (human-handoff slice). The RESTOCK capability is threaded into the tool deps
 * only while `humanDecisions.restockEnabled` is exactly true. Shipping stays
 * inert unless `SHIPPING_QUOTES_ENABLED === 'true'`.
 */
@Module({
  imports: [
    ChatbotApiModule,
    ConversationModule,
    HumanHandoffModule,
    HumanDecisionsModule,
    ShippingModule.forRoot(),
  ],
  providers: [RealToolRegistry],
  exports: [RealToolRegistry],
})
export class SaleFlowModule {}
