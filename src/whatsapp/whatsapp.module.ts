import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { WHATSAPP_SENDER } from './domain/whatsapp-sender.port';
import { MetaWhatsappSender } from './infrastructure/meta-whatsapp.sender';
import { SignatureGuard } from './presentation/signature.guard';

@Module({
  imports: [HttpModule],
  providers: [
    MetaWhatsappSender,
    {
      provide: WHATSAPP_SENDER,
      useExisting: MetaWhatsappSender,
    },
    SignatureGuard,
  ],
  exports: [WHATSAPP_SENDER, SignatureGuard],
})
export class WhatsappModule {}
