import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatbotApiModule } from './chatbot-api/chatbot-api.module';
import { ConversationModule } from './conversation/conversation.module';
import { AppConfigModule } from './config/config.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ConversationModule,
    ChatbotApiModule,
    WhatsappModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
