import { WebhookDedupStore } from '../domain/webhook-dedup.store';

/**
 * In-memory WebhookDedupStore — used by unit tests only.
 *
 * The runtime binding is the durable Postgres adapter; a per-process Set
 * would forget processed ids on every restart and re-open the duplicate
 * window that caused the production bug.
 */
export class InMemoryWebhookDedupStore implements WebhookDedupStore {
  private readonly seen = new Set<string>();

  isDuplicate(messageId: string): Promise<boolean> {
    return Promise.resolve(this.seen.has(messageId));
  }

  markSeen(messageId: string): Promise<void> {
    this.seen.add(messageId);
    return Promise.resolve();
  }
}
