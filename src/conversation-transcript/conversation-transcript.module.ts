import { Module } from '@nestjs/common';
import { BackendOutboxEnqueueModule } from '../backend-outbox/backend-outbox.module';
import { DatabaseModule } from '../database/database.module';
import {
  OUTBOUND_TRANSCRIPT_RECORDER,
  TranscriptRecorder,
} from './application/transcript-recorder';
import { CONVERSATION_TRANSCRIPT } from './domain/transcript.port';
import { PostgresTranscriptStore } from './infrastructure/postgres-transcript.store';

/**
 * ConversationTranscriptModule (S1 durable transcript)
 *
 *   - `CONVERSATION_TRANSCRIPT` → `conversation_messages` (migration 3800).
 *   - `TranscriptRecorder` → best-effort writes for the dispatcher (inbound)
 *     and, as `OUTBOUND_TRANSCRIPT_RECORDER`, for the WhatsApp sender. Each
 *     inserted row also enqueues its MESSAGE_MIRROR in the same transaction.
 *
 * No worker here: the sender and webhook graphs import this module, and
 * the purge worker runs once per process from `TranscriptPurgeModule`.
 */
@Module({
  imports: [DatabaseModule, BackendOutboxEnqueueModule],
  providers: [
    { provide: CONVERSATION_TRANSCRIPT, useClass: PostgresTranscriptStore },
    TranscriptRecorder,
    { provide: OUTBOUND_TRANSCRIPT_RECORDER, useExisting: TranscriptRecorder },
  ],
  exports: [
    CONVERSATION_TRANSCRIPT,
    TranscriptRecorder,
    OUTBOUND_TRANSCRIPT_RECORDER,
  ],
})
export class ConversationTranscriptModule {}
