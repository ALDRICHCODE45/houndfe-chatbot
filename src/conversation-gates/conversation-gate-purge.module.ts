import { Module } from '@nestjs/common';
import { ConversationGatePurgeWorker } from './application/conversation-gate-purge.worker';
import { ConversationGatesModule } from './conversation-gates.module';

/**
 * ConversationGatePurgeModule (S4)
 *
 * Runs `ConversationGatePurgeWorker`, which deletes expired gates in batches.
 * Imported only by `AppModule`, so feature graphs never start a timer.
 */
@Module({
  imports: [ConversationGatesModule],
  providers: [ConversationGatePurgeWorker],
})
export class ConversationGatePurgeModule {}
