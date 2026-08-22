import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import { WebhookDedupStore } from '../domain/webhook-dedup.store';

/**
 * Durable (Postgres) WebhookDedupStore.
 *
 * Schema: see migrations/1800000000000_create-processed-webhook-messages.js
 * — one table keyed by message_id (PK). `isDuplicate` is a PK lookup;
 * `markSeen` is `INSERT ... ON CONFLICT (message_id) DO NOTHING` so it is
 * idempotent under concurrent re-deliveries.
 *
 * Rows are never purged: volume is one row per inbound message and the
 * permanent record keeps the dedup immune to Meta's ~24h re-delivery
 * window.
 */
@Injectable()
export class PostgresWebhookDedupStore implements WebhookDedupStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async isDuplicate(messageId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM processed_webhook_messages WHERE message_id = $1',
      [messageId],
    );
    return rows.length > 0;
  }

  async markSeen(messageId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_webhook_messages (message_id)
       VALUES ($1)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId],
    );
  }
}
