import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_DEDUP_CLOCK,
  WebhookClaimInFlightError,
  type WebhookDedupStore,
} from '../domain/webhook-dedup.store';

// The insert takes a fresh id; on conflict it takes over only an expired
// PROCESSING claim. Two concurrent claims serialize on the row lock and the
// loser re-checks the WHERE against the winner's row, so it gets no row.
const CLAIM = `
INSERT INTO processed_webhook_messages AS p
  (message_id, status, claim_token, claimed_at, lease_expires_at, seen_at)
VALUES ($1, 'PROCESSING', $2, $3::timestamptz, $4::timestamptz, $3::timestamptz)
ON CONFLICT (message_id) DO UPDATE
   SET claim_token = EXCLUDED.claim_token,
       claimed_at = EXCLUDED.claimed_at,
       lease_expires_at = EXCLUDED.lease_expires_at,
       seen_at = EXCLUDED.seen_at
 WHERE p.status = 'PROCESSING' AND p.lease_expires_at <= EXCLUDED.claimed_at
RETURNING p.claim_token`;

const STATUS = `
SELECT status FROM processed_webhook_messages WHERE message_id = $1`;

const MARK_DONE = `
INSERT INTO processed_webhook_messages AS p (message_id, status, seen_at)
VALUES ($1, 'DONE', $2::timestamptz)
ON CONFLICT (message_id) DO UPDATE
   SET status = 'DONE', claim_token = NULL, lease_expires_at = NULL,
       seen_at = EXCLUDED.seen_at
 WHERE p.status = 'PROCESSING'`;

const RELEASE = `
DELETE FROM processed_webhook_messages
 WHERE message_id = $1 AND status = 'PROCESSING' AND claim_token = $2::uuid`;

// One bounded batch over the seen_at index; SKIP LOCKED lets two purgers
// (or a purger and a claim) never block each other.
const PURGE = `
DELETE FROM processed_webhook_messages
 WHERE message_id IN (
   SELECT message_id FROM processed_webhook_messages
    WHERE seen_at < $1::timestamptz
      AND (status = 'DONE' OR lease_expires_at < $1::timestamptz)
    ORDER BY seen_at
    LIMIT $2
    FOR UPDATE SKIP LOCKED
 )`;

/**
 * Durable (Postgres) WebhookDedupStore.
 *
 * Schema: migrations 1800 (table keyed by message_id) and 4100 (claim
 * status, token and lease; see docs/webhook-dedup.md). Timestamps come from
 * the app clock so leases and purge cutoffs are testable; `seen_at` is the
 * last state change (claim, takeover or DONE) and drives the purge.
 */
@Injectable()
export class PostgresWebhookDedupStore implements WebhookDedupStore {
  private readonly now: () => Date;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(WEBHOOK_DEDUP_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async claim(messageId: string): Promise<string | null> {
    const now = this.now();
    const { rows } = await this.pool.query<{ claim_token: string }>(CLAIM, [
      messageId,
      randomUUID(),
      now.toISOString(),
      new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS).toISOString(),
    ]);
    if (rows[0] !== undefined) return rows[0].claim_token;
    // No row back: DONE (a duplicate) or a live claim. Anything but DONE,
    // including a row released or purged since, is retried by Meta.
    const status = await this.pool.query<{ status: string }>(STATUS, [
      messageId,
    ]);
    if (status.rows[0]?.status === 'DONE') return null;
    throw new WebhookClaimInFlightError(messageId);
  }

  async markSeen(messageId: string): Promise<void> {
    await this.pool.query(MARK_DONE, [messageId, this.now().toISOString()]);
  }

  async release(messageId: string, claimToken: string): Promise<void> {
    await this.pool.query(RELEASE, [messageId, claimToken]);
  }

  async purgeBefore(cutoff: Date, limit: number): Promise<number> {
    const { rowCount } = await this.pool.query(PURGE, [
      cutoff.toISOString(),
      limit,
    ]);
    return rowCount ?? 0;
  }
}
