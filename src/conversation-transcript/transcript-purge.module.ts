import { Module } from '@nestjs/common';
import { TranscriptPurgeWorker } from './application/transcript-purge.worker';
import { ConversationTranscriptModule } from './conversation-transcript.module';

/**
 * TranscriptPurgeModule (S1 retention)
 *
 * Runs `TranscriptPurgeWorker`, which deletes transcript rows past their
 * 12-month purge time in batches of 1000. Imported only by `AppModule`, so
 * feature-module graphs that record messages never start a timer.
 */
@Module({
  imports: [ConversationTranscriptModule],
  providers: [TranscriptPurgeWorker],
})
export class TranscriptPurgeModule {}
