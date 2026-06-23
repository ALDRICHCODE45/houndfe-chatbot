import { Module } from '@nestjs/common';
import { CONVERSATION_STORE } from './domain/conversation-store';
import { InMemoryConversationStore } from './infrastructure/in-memory-conversation.store';

/**
 * ConversationModule
 *
 * Provides the ConversationStore port bound to the in-memory adapter.
 * Later slices swap the adapter to Postgres by replacing the useClass
 * binding here — the rest of the application stays unchanged.
 *
 * Import this module in any feature module that needs to inject
 * the CONVERSATION_STORE token.
 */
@Module({
  providers: [
    {
      provide: CONVERSATION_STORE,
      useClass: InMemoryConversationStore,
    },
  ],
  exports: [CONVERSATION_STORE],
})
export class ConversationModule {}
