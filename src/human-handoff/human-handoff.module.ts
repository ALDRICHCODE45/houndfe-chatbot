import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { ConversationModule } from '../conversation/conversation.module';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { HUMAN_HANDOFF_SERVICE_TOKEN } from '../sale-flow/infrastructure/real-tool-registry';
import { shippingApprovalPolicyAdapter } from '../shipping/application/shipping-approval-policy.adapter';
import { HumanHandoffService } from './application/human-handoff.service';
import { HUMAN_HANDOFF_STORE } from './domain/human-handoff-store.port';
import { SHIPPING_APPROVAL_POLICY } from './domain/shipping-approval-policy.port';
import { PostgresHumanHandoffStore } from './infrastructure/postgres-human-handoff.store';

/**
 * HumanHandoffModule
 *
 * Owns the durable human-handoff request lifecycle (create → digest →
 * customer notice → wait for reply → resolve). Provides:
 *   - `HUMAN_HANDOFF_STORE` → `PostgresHumanHandoffStore` (writes to
 *     `human_handoff_requests`).
 *   - `HUMAN_HANDOFF_SERVICE_TOKEN` → `HumanHandoffService` (the
 *     application service used by the 12th AI-SDK tool
 *     `requestHumanAssistance` AND by `WebhookDispatcherService` for
 *     ops-side inbound routing).
 *
 * Imports:
 *   - `DatabaseModule` for `PG_POOL` (PostgresHumanHandoffStore).
 *   - `ConversationModule` for `CONVERSATION_STORE` (the marker lives
 *     under `ConversationState.data.pendingHumanRequest`).
 *   - `WhatsappSenderModule` for `WHATSAPP_SENDER` (digest + customer
 *     notice + ops ask-for-ref).
 *   - `ConfigModule` for typed `humanHandoff` config.
 *
 * Module graph (acyclic, ADR-30):
 *   WhatsappSenderModule → HumanHandoffModule → SaleFlowModule → LlmAgentModule
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    WhatsappSenderModule,
  ],
  providers: [
    { provide: HUMAN_HANDOFF_STORE, useClass: PostgresHumanHandoffStore },
    // Bind the domain-owned policy token to the committed frozen adapter
    // (identity via `useValue`); the token stays module-private and is
    // never exported to model-facing consumers.
    {
      provide: SHIPPING_APPROVAL_POLICY,
      useValue: shippingApprovalPolicyAdapter,
    },
    HumanHandoffService,
    // Re-export the service under the symbol the registry / dispatcher
    // resolve, so consumers don't have to import the internal class.
    {
      provide: HUMAN_HANDOFF_SERVICE_TOKEN,
      useExisting: HumanHandoffService,
    },
  ],
  exports: [HUMAN_HANDOFF_STORE, HUMAN_HANDOFF_SERVICE_TOKEN],
})
export class HumanHandoffModule {}
