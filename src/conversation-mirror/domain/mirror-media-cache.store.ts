/** Persistent `idempotencyKey → mediaId` cache (S1): a file is downloaded and
 *  uploaded once; product photos sent to many customers reuse the id. */
export const MIRROR_MEDIA_CACHE_STORE = Symbol('MIRROR_MEDIA_CACHE_STORE');

export interface MirrorMediaCacheEntry {
  /** The lookup key: `mediaIdempotencyKey(source[, version])`. */
  idempotencyKey: string;
  mediaId: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface MirrorMediaCacheStore {
  get(idempotencyKey: string): Promise<MirrorMediaCacheEntry | null>;
  /** Upsert: a forced refresh replaces the media id and resets `createdAt`. */
  put(
    entry: Pick<
      MirrorMediaCacheEntry,
      'idempotencyKey' | 'mediaId' | 'mimeType' | 'sizeBytes'
    >,
  ): Promise<void>;
  /** Marks the entry as used now (cheap recency, throttled by the caller). */
  touch(idempotencyKey: string): Promise<void>;
  /** `true` when an entry was removed. */
  forget(idempotencyKey: string): Promise<boolean>;
  /** Removes entries not used since `cutoff`; returns how many. */
  pruneUnusedBefore(cutoff: Date): Promise<number>;
}
