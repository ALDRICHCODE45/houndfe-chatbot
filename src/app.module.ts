import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatbotApiModule } from './chatbot-api/chatbot-api.module';
import { ConversationModule } from './conversation/conversation.module';
import { AppConfigModule } from './config/config.module';
import { LlmAgentModule } from './llm-agent/llm-agent.module';
import { ShippingModule } from './shipping/shipping.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ConversationModule,
    LlmAgentModule,
    ChatbotApiModule,
    WhatsappModule,
    ShippingModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
