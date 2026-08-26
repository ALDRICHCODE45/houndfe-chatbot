import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { DatabaseModule } from '../database/database.module';
import { HumanHandoffModule } from '../human-handoff/human-handoff.module';
import { LlmAgentModule } from '../llm-agent/llm-agent.module';
import { WebhookDispatcherService } from './application/webhook-dispatcher.service';
import { RECENT_OUTBOUND } from './domain/recent-outbound.store';
import { WEBHOOK_DEDUP } from './domain/webhook-dedup.store';
import { InMemoryRecentOutboundStore } from './infrastructure/in-memory-recent-outbound.store';
import { PostgresWebhookDedupStore } from './infrastructure/postgres-webhook-dedup.store';
import { WebhookController } from './presentation/webhook.controller';
import { SignatureGuard } from './presentation/signature.guard';
import { WhatsappSenderModule } from './whatsapp-sender.module';

/**
 * WhatsappModule
 *
 * Wires the inbound webhook side:
 *   - `WebhookController` (HTTP endpoint + SignatureGuard)
 *   - `WebhookDispatcherService` (echo + dedup + ops pre-routing +
 *     pending-marker short-circuit + AgentRunner + send)
 *   - `RECENT_OUTBOUND` (in-memory echo filter)
 *   - `WEBHOOK_DEDUP` (Postgres durable dedup)
 *
 * The outbound sender lives in `WhatsappSenderModule` (ADR-30) and is
 * re-exported here so any existing consumer of `WHATSAPP_SENDER` keeps
 * working unchanged.
 *
 * HumanHandoffModule is imported so the dispatcher can inject
 * `HumanHandoffService` for the ops pre-routing hook (Commit 2 wires the
 * hook — Commit 1 just imports the module).
 */
@Module({
  imports: [
    ConversationModule,
    LlmAgentModule,
    DatabaseModule,
    HumanHandoffModule,
    WhatsappSenderModule,
  ],
  controllers: [WebhookController],
  providers: [
    WebhookDispatcherService,
    {
      // Durable dedup across restarts — Meta re-delivery window spans ~24h.
      provide: WEBHOOK_DEDUP,
      useClass: PostgresWebhookDedupStore,
    },
    {
      // Echo filter — bounded in-memory window (echoes arrive in seconds).
      provide: RECENT_OUTBOUND,
      useClass: InMemoryRecentOutboundStore,
    },
    SignatureGuard,
  ],
  exports: [SignatureGuard, WebhookDispatcherService],
})
export class WhatsappModule {}
