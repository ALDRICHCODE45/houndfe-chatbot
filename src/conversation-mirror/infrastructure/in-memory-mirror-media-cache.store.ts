import type {
  MirrorMediaCacheEntry,
  MirrorMediaCacheStore,
} from '../domain/mirror-media-cache.store';

/** Process-local cache store (tests and a DB-less fallback). */
export class InMemoryMirrorMediaCacheStore implements MirrorMediaCacheStore {
  private readonly entries = new Map<string, MirrorMediaCacheEntry>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  get(idempotencyKey: string): Promise<MirrorMediaCacheEntry | null> {
    const entry = this.entries.get(idempotencyKey);
    return Promise.resolve(entry === undefined ? null : { ...entry });
  }

  put(
    entry: Pick<
      MirrorMediaCacheEntry,
      'idempotencyKey' | 'mediaId' | 'mimeType' | 'sizeBytes'
    >,
  ): Promise<void> {
    const now = this.clock();
    this.entries.set(entry.idempotencyKey, {
      ...entry,
      createdAt: now,
      lastUsedAt: now,
    });
    return Promise.resolve();
  }

  touch(idempotencyKey: string): Promise<void> {
    const entry = this.entries.get(idempotencyKey);
    if (entry !== undefined) entry.lastUsedAt = this.clock();
    return Promise.resolve();
  }

  forget(idempotencyKey: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(idempotencyKey));
  }

  pruneUnusedBefore(cutoff: Date): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.entries)
      if (entry.lastUsedAt.getTime() < cutoff.getTime()) {
        this.entries.delete(key);
        removed += 1;
      }
    return Promise.resolve(removed);
  }
}
