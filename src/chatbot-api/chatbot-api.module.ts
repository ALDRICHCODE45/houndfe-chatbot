import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CHATBOT_API_CLIENT } from './domain/chatbot-api.client';
import { ChatbotApiHttpClient } from './infrastructure/chatbot-api-http.client';

@Module({
  imports: [HttpModule],
  providers: [
    ChatbotApiHttpClient,
    {
      provide: CHATBOT_API_CLIENT,
      useExisting: ChatbotApiHttpClient,
    },
  ],
  exports: [CHATBOT_API_CLIENT, ChatbotApiHttpClient],
})
export class ChatbotApiModule {}
