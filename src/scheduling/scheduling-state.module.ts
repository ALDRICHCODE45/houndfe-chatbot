import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  LIVE_CONVERSATION_CLIENT,
  type LiveConversationClient,
} from '../chatbot-api/domain/live-conversation.port';
import { ConversationModule } from '../conversation/conversation.module';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../conversation/domain/conversation-store';
import { SchedulingStateService } from './application/scheduling-state.service';

/**
 * Unit 14: the durable offer / appointment state, on its own so both the
 * scheduling policy and the human-requests feed handlers (which read and
 * write it) can import it without importing each other. One instance for
 * the whole app.
 */
@Module({
  imports: [ConversationModule, ChatbotApiModule],
  providers: [
    {
      provide: SchedulingStateService,
      useFactory: (
        store: ConversationStore,
        live: LiveConversationClient,
      ): SchedulingStateService => new SchedulingStateService({ store, live }),
      inject: [CONVERSATION_STORE, LIVE_CONVERSATION_CLIENT],
    },
  ],
  exports: [SchedulingStateService],
})
export class SchedulingStateModule {}
