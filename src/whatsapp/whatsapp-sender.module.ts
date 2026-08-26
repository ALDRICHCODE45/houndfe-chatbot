import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetaWhatsappSender } from './infrastructure/meta-whatsapp.sender';
import { WHATSAPP_SENDER } from './domain/whatsapp-sender.port';

/**
 * WhatsappSenderModule
 *
 * Leaf module that binds `WHATSAPP_SENDER` to `MetaWhatsappSender`.
 *
 * Extracted from `WhatsappModule` so both `WhatsappModule` and
 * `HumanHandoffModule` can import the sender without creating a
 * `forwardRef` cycle (ADR-30). The dispatcher needs
 * `HumanHandoffService`; the service needs `WHATSAPP_SENDER`. The
 * acyclic graph is:
 *
 *   WhatsappSenderModule → HumanHandoffModule → SaleFlowModule → ...
 *                  ↑              ↑
 *              used by        used by
 *                  ↓              ↓
 *            WhatsappModule (uses both: dispatcher injects HumanHandoffService
 *                             and the sender; re-exports WHATSAPP_SENDER)
 */
@Module({
  imports: [ConfigModule, HttpModule],
  providers: [
    MetaWhatsappSender,
    { provide: WHATSAPP_SENDER, useExisting: MetaWhatsappSender },
  ],
  exports: [WHATSAPP_SENDER],
})
export class WhatsappSenderModule {}
