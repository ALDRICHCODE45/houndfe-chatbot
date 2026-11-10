import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  boundedListLimit,
  boundedPurgeBatch,
  isValidTranscriptSenderId,
  normalizeTranscriptMessage,
  type ConversationTranscriptStore,
  type TranscriptAuthor,
  type TranscriptDirection,
  type TranscriptMedia,
  type TranscriptMessage,
  type TranscriptMessageInput,
} from '../domain/transcript.port';

interface TranscriptRow {
  sender_id: string;
  wa_message_id: string;
  direction: TranscriptDirection;
  author: TranscriptAuthor;
  type: string;
  text: string | null;
  media: TranscriptMedia | null;
  details: Record<string, unknown> | null;
  provider_timestamp: Date | null;
  observed_at: Date;
  purge_after: Date;
}

type Queryable = Pick<Pool, 'query'>;

const COLUMNS =
  'sender_id, wa_message_id, direction, author, type, text, media, details, ' +
  'provider_timestamp, observed_at, purge_after';

const APPEND = `
INSERT INTO conversation_messages (${COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz,
        $10::timestamptz, $11::timestamptz)
ON CONFLICT (wa_message_id) DO NOTHING`;

// Newest N by the (sender_id, observed_at) index, returned oldest first.
const LIST_RECENT = `
SELECT ${COLUMNS} FROM (
  SELECT ${COLUMNS}, id FROM conversation_messages
   WHERE sender_id = $1
   ORDER BY observed_at DESC, id DESC
   LIMIT $2
) recent
ORDER BY observed_at ASC, id ASC`;

// One bounded batch; SKIP LOCKED lets two purgers never block each other.
const PURGE = `
DELETE FROM conversation_messages
 WHERE id IN (
   SELECT id FROM conversation_messages
    WHERE purge_after <= $1
    ORDER BY purge_after
    LIMIT $2
    FOR UPDATE SKIP LOCKED
 )`;

function toMessage(row: TranscriptRow): TranscriptMessage {
  return {
    senderId: row.sender_id,
    waMessageId: row.wa_message_id,
    direction: row.direction,
    author: row.author,
    type: row.type,
    text: row.text,
    media: row.media,
    details: row.details,
    providerTimestamp: row.provider_timestamp?.toISOString() ?? null,
    observedAt: row.observed_at.toISOString(),
    purgeAfter: row.purge_after.toISOString(),
  };
}

/** Durable transcript over `conversation_messages` (migration 3800). */
@Injectable()
export class PostgresTranscriptStore implements ConversationTranscriptStore {
  constructor(@Inject(PG_POOL) private readonly pool: Queryable) {}

  async append(message: TranscriptMessageInput): Promise<boolean> {
    const row = normalizeTranscriptMessage(message);
    const result = await this.pool.query(APPEND, [
      row.senderId,
      row.waMessageId,
      row.direction,
      row.author,
      row.type,
      row.text,
      row.media === null ? null : JSON.stringify(row.media),
      row.details === null ? null : JSON.stringify(row.details),
      row.providerTimestamp,
      row.observedAt,
      row.purgeAfter,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async listRecent(
    senderId: string,
    limit: number,
  ): Promise<TranscriptMessage[]> {
    if (!isValidTranscriptSenderId(senderId)) return [];
    const result = await this.pool.query<TranscriptRow>(LIST_RECENT, [
      senderId,
      boundedListLimit(limit),
    ]);
    return result.rows.map(toMessage);
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    const result = await this.pool.query(PURGE, [
      now.toISOString(),
      boundedPurgeBatch(batchSize),
    ]);
    return result.rowCount ?? 0;
  }
}
