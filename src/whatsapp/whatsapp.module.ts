import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { WebhookDispatcherService } from './application/webhook-dispatcher.service';
import { WHATSAPP_SENDER } from './domain/whatsapp-sender.port';
import { MetaWhatsappSender } from './infrastructure/meta-whatsapp.sender';
import { WebhookController } from './presentation/webhook.controller';
import { SignatureGuard } from './presentation/signature.guard';

@Module({
  imports: [HttpModule, ConversationModule],
  controllers: [WebhookController],
  providers: [
    MetaWhatsappSender,
    WebhookDispatcherService,
    {
      provide: WHATSAPP_SENDER,
      useExisting: MetaWhatsappSender,
    },
    SignatureGuard,
  ],
  exports: [WHATSAPP_SENDER, SignatureGuard, WebhookDispatcherService],
})
export class WhatsappModule {}
