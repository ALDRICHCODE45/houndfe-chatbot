import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import {
  CHATBOT_API_CLIENT,
  HUMAN_REQUESTS_CLIENT,
} from './domain/chatbot-api.client';
import { CONVERSATION_MIRROR_CLIENT } from './domain/conversation-mirror.port';
import { LIVE_CONVERSATION_CLIENT } from './domain/live-conversation.port';
import { SCHEDULING_CLIENT } from './domain/scheduling.port';
import { ChatbotApiHttpClient } from './infrastructure/chatbot-api-http.client';

@Module({
  imports: [HttpModule],
  providers: [
    ChatbotApiHttpClient,
    {
      provide: CHATBOT_API_CLIENT,
      useExisting: ChatbotApiHttpClient,
    },
    {
      provide: HUMAN_REQUESTS_CLIENT,
      useExisting: ChatbotApiHttpClient,
    },
    {
      provide: CONVERSATION_MIRROR_CLIENT,
      useExisting: ChatbotApiHttpClient,
    },
    {
      provide: LIVE_CONVERSATION_CLIENT,
      useExisting: ChatbotApiHttpClient,
    },
    {
      provide: SCHEDULING_CLIENT,
      useExisting: ChatbotApiHttpClient,
    },
  ],
  exports: [
    CHATBOT_API_CLIENT,
    HUMAN_REQUESTS_CLIENT,
    CONVERSATION_MIRROR_CLIENT,
    LIVE_CONVERSATION_CLIENT,
    SCHEDULING_CLIENT,
    ChatbotApiHttpClient,
  ],
})
export class ChatbotApiModule {}
