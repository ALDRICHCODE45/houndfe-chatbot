import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { DatabaseModule } from '../database/database.module';
import { LlmAgentModule } from '../llm-agent/llm-agent.module';
import { WebhookDispatcherService } from './application/webhook-dispatcher.service';
import { RECENT_OUTBOUND } from './domain/recent-outbound.store';
import { WEBHOOK_DEDUP } from './domain/webhook-dedup.store';
import { WHATSAPP_SENDER } from './domain/whatsapp-sender.port';
import { InMemoryRecentOutboundStore } from './infrastructure/in-memory-recent-outbound.store';
import { MetaWhatsappSender } from './infrastructure/meta-whatsapp.sender';
import { PostgresWebhookDedupStore } from './infrastructure/postgres-webhook-dedup.store';
import { WebhookController } from './presentation/webhook.controller';
import { SignatureGuard } from './presentation/signature.guard';

@Module({
  imports: [HttpModule, ConversationModule, LlmAgentModule, DatabaseModule],
  controllers: [WebhookController],
  providers: [
    MetaWhatsappSender,
    WebhookDispatcherService,
    {
      provide: WHATSAPP_SENDER,
      useExisting: MetaWhatsappSender,
    },
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
  exports: [WHATSAPP_SENDER, SignatureGuard, WebhookDispatcherService],
})
export class WhatsappModule {}
