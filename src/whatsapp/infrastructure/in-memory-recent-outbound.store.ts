import { RecentOutboundStore } from '../domain/recent-outbound.store';

/**
 * Bounded in-memory RecentOutboundStore (echo filter).
 *
 * Echoes of a sent message arrive within seconds, so a short TTL window
 * and a small cap are sufficient. On eviction the OLDEST entry is dropped
 * (FIFO by expiry), keeping the store bounded in memory.
 */
export class InMemoryRecentOutboundStore implements RecentOutboundStore {
  private readonly entries = new Map<string, { expiresAt: number }>();

  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxEntries = 500,
  ) {}

  remember(providerMessageId: string): void {
    this.sweep();

    if (this.entries.has(providerMessageId)) {
      this.entries.delete(providerMessageId);
    }

    this.entries.set(providerMessageId, {
      expiresAt: Date.now() + this.ttlMs,
    });

    if (this.entries.size > this.maxEntries) {
      const oldestId = [...this.entries.entries()].sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt,
      )[0]?.[0];

      if (oldestId !== undefined) {
        this.entries.delete(oldestId);
      }
    }
  }

  isKnown(providerMessageId: string): boolean {
    this.sweep();

    const entry = this.entries.get(providerMessageId);
    if (!entry) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(providerMessageId);
      return false;
    }

    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
      }
    }
  }
}
