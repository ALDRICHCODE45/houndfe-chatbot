import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConversationGates } from './application/conversation-gates';
import { CONVERSATION_GATE_STORE } from './domain/conversation-gate.store';
import { PostgresConversationGateStore } from './infrastructure/postgres-conversation-gate.store';

/**
 * ConversationGatesModule (S4 durable conversation gates)
 *
 *   - `CONVERSATION_GATE_STORE` → `conversation_gates` (migration 4200).
 *   - `ConversationGates` → the one per-process sync of the minimal route's
 *     in-memory gates with that store.
 *
 * No worker here: the purge runs once per process from
 * `ConversationGatePurgeModule`, imported only by `AppModule`.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: CONVERSATION_GATE_STORE,
      useClass: PostgresConversationGateStore,
    },
    ConversationGates,
  ],
  exports: [CONVERSATION_GATE_STORE, ConversationGates],
})
export class ConversationGatesModule {}
