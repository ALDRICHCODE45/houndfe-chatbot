import { randomUUID } from 'node:crypto';
import {
  WEBHOOK_CLAIM_LEASE_MS,
  type WebhookDedupStore,
} from '../domain/webhook-dedup.store';

type Row =
  | { status: 'DONE'; seenAt: number }
  | {
      status: 'PROCESSING';
      seenAt: number;
      claimToken: string;
      leaseExpiresAt: number;
    };

/**
 * In-memory WebhookDedupStore — used by unit tests and the demo harness.
 *
 * The runtime binding is the durable Postgres adapter; a per-process Map
 * would forget processed ids on every restart and re-open the duplicate
 * window that caused the production bug. Every method is synchronous inside,
 * so a claim is atomic within the process.
 */
export class InMemoryWebhookDedupStore implements WebhookDedupStore {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  claim(messageId: string): Promise<string | null> {
    const now = this.now().getTime();
    const row = this.rows.get(messageId);
    if (
      row !== undefined &&
      (row.status === 'DONE' || row.leaseExpiresAt > now)
    ) {
      return Promise.resolve(null);
    }
    const claimToken = randomUUID();
    this.rows.set(messageId, {
      status: 'PROCESSING',
      seenAt: now,
      claimToken,
      leaseExpiresAt: now + WEBHOOK_CLAIM_LEASE_MS,
    });
    return Promise.resolve(claimToken);
  }

  markSeen(messageId: string): Promise<void> {
    if (this.rows.get(messageId)?.status !== 'DONE') {
      this.rows.set(messageId, {
        status: 'DONE',
        seenAt: this.now().getTime(),
      });
    }
    return Promise.resolve();
  }

  release(messageId: string, claimToken: string): Promise<void> {
    const row = this.rows.get(messageId);
    if (row?.status === 'PROCESSING' && row.claimToken === claimToken) {
      this.rows.delete(messageId);
    }
    return Promise.resolve();
  }

  purgeBefore(cutoff: Date, limit: number): Promise<number> {
    const before = cutoff.getTime();
    let deleted = 0;
    for (const [messageId, row] of this.rows) {
      if (deleted >= limit) break;
      if (
        row.seenAt < before &&
        (row.status === 'DONE' || row.leaseExpiresAt < before)
      ) {
        this.rows.delete(messageId);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
