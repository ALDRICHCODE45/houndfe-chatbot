import type { Pool } from 'pg';
import type {
  MirrorMediaCacheEntry,
  MirrorMediaCacheStore,
} from '../domain/mirror-media-cache.store';

interface Row {
  idempotency_key: string;
  media_id: string;
  mime_type: string;
  size_bytes: string | number;
  created_at: Date;
  last_used_at: Date;
}

/** `mirror_media_cache` (migration 4800000000000): single-statement queries,
 *  no transactions needed; times are the database clock. */
export class PostgresMirrorMediaCacheStore implements MirrorMediaCacheStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(idempotencyKey: string): Promise<MirrorMediaCacheEntry | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT idempotency_key, media_id, mime_type, size_bytes, created_at, last_used_at
         FROM mirror_media_cache WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          idempotencyKey: row.idempotency_key,
          mediaId: row.media_id,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        };
  }

  async put(
    entry: Pick<
      MirrorMediaCacheEntry,
      'idempotencyKey' | 'mediaId' | 'mimeType' | 'sizeBytes'
    >,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mirror_media_cache (idempotency_key, media_id, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET media_id = EXCLUDED.media_id,
             mime_type = EXCLUDED.mime_type,
             size_bytes = EXCLUDED.size_bytes,
             created_at = now(),
             last_used_at = now()`,
      [entry.idempotencyKey, entry.mediaId, entry.mimeType, entry.sizeBytes],
    );
  }

  async touch(idempotencyKey: string): Promise<void> {
    await this.pool.query(
      'UPDATE mirror_media_cache SET last_used_at = now() WHERE idempotency_key = $1',
      [idempotencyKey],
    );
  }

  async forget(idempotencyKey: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM mirror_media_cache WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async pruneUnusedBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM mirror_media_cache WHERE last_used_at < $1',
      [cutoff],
    );
    return result.rowCount ?? 0;
  }
}
