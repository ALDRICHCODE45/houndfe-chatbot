import type { Pool, PoolClient } from 'pg';
import {
  FEED_CONSUMER_NAME,
  type FeedConsumerLock,
} from '../domain/human-request-feed';

const TRY_LOCK_SQL = `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtextextended($1, 0))`;

/**
 * Session advisory lock on a dedicated pool connection, held for as long as
 * this instance consumes the feed (one consumer per database). If the
 * connection dies, Postgres releases the lock: `isHeld` then reports false
 * and the consumer reacquires before its next page.
 */
export class PostgresFeedConsumerLock implements FeedConsumerLock {
  private client?: PoolClient;

  constructor(
    private readonly pool: Pool,
    private readonly key: string = FEED_CONSUMER_NAME,
  ) {}

  async tryAcquire(): Promise<boolean> {
    if (this.client) return true;
    const client = await this.pool.connect();
    const onError = () => this.drop(client);
    client.on('error', onError);
    try {
      const result = await client.query<{ locked: boolean }>(TRY_LOCK_SQL, [
        this.key,
      ]);
      if (result.rows[0]?.locked === true) {
        this.client = client;
        return true;
      }
      client.off('error', onError);
      client.release();
      return false;
    } catch (error) {
      client.off('error', onError);
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  }

  async isHeld(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    try {
      await client.query('SELECT 1');
      return true;
    } catch {
      this.drop(client);
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    client.removeAllListeners('error');
    try {
      await client.query(UNLOCK_SQL, [this.key]);
      client.release();
    } catch (error) {
      // Destroying the connection releases the session lock as well.
      client.release(error instanceof Error ? error : true);
    }
  }

  /** The connection failed: discard it (its session lock is gone). */
  private drop(client: PoolClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    client.removeAllListeners('error');
    client.release(true);
  }
}
