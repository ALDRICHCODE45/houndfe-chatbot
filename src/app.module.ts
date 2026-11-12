import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BackendOutboxModule } from './backend-outbox/backend-outbox.module';
import { ChatbotApiModule } from './chatbot-api/chatbot-api.module';
import { ConversationModule } from './conversation/conversation.module';
import { ConversationMirrorModule } from './conversation-mirror/conversation-mirror.module';
import { ConversationGatePurgeModule } from './conversation-gates/conversation-gate-purge.module';
import { TranscriptPurgeModule } from './conversation-transcript/transcript-purge.module';
import { AppConfigModule } from './config/config.module';
import { HumanRequestsModule } from './human-requests/human-requests.module';
import { LlmAgentModule } from './llm-agent/llm-agent.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ConversationModule,
    TranscriptPurgeModule,
    ConversationGatePurgeModule,
    BackendOutboxModule,
    HumanRequestsModule,
    ConversationMirrorModule,
    LlmAgentModule,
    ChatbotApiModule,
    WhatsappModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
