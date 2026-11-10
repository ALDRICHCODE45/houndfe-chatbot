import { Injectable } from '@nestjs/common';
import {
  boundedListLimit,
  boundedPurgeBatch,
  isValidTranscriptSenderId,
  normalizeTranscriptMessage,
  type ConversationTranscriptStore,
  type TranscriptInsertHook,
  type TranscriptMessage,
  type TranscriptMessageInput,
} from '../domain/transcript.port';

/** Test/dev transcript; same semantics as the Postgres adapter. */
@Injectable()
export class InMemoryTranscriptStore implements ConversationTranscriptStore {
  // Insertion order breaks observed_at ties, like the Postgres id.
  private readonly rows = new Map<string, TranscriptMessage>();

  async append(
    message: TranscriptMessageInput,
    onInserted?: TranscriptInsertHook,
  ): Promise<boolean> {
    const row = normalizeTranscriptMessage(message);
    if (this.rows.has(row.waMessageId)) return false;
    this.rows.set(row.waMessageId, structuredClone(row));
    if (onInserted === undefined) return true;
    try {
      await onInserted(structuredClone(row));
    } catch (error) {
      // Same outcome as the Postgres rollback.
      this.rows.delete(row.waMessageId);
      throw error;
    }
    return true;
  }

  listRecent(senderId: string, limit: number): Promise<TranscriptMessage[]> {
    if (!isValidTranscriptSenderId(senderId)) return Promise.resolve([]);
    const mine = [...this.rows.values()]
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.senderId === senderId)
      .sort(
        (a, b) =>
          a.row.observedAt.localeCompare(b.row.observedAt) || a.index - b.index,
      )
      .map(({ row }) => structuredClone(row));
    return Promise.resolve(mine.slice(-boundedListLimit(limit)));
  }

  purgeExpired(now: Date, batchSize: number): Promise<number> {
    const cutoff = now.toISOString();
    const due = [...this.rows.values()]
      .filter((row) => row.purgeAfter <= cutoff)
      .sort((a, b) => a.purgeAfter.localeCompare(b.purgeAfter))
      .slice(0, boundedPurgeBatch(batchSize));
    for (const row of due) this.rows.delete(row.waMessageId);
    return Promise.resolve(due.length);
  }
}
