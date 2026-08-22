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

  async isDuplicate(messageId: string): Promise<boolean> {
    return this.seen.has(messageId);
  }

  async markSeen(messageId: string): Promise<void> {
    this.seen.add(messageId);
  }
}
