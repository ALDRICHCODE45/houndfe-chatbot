import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  normalizeLocalPets,
  type LocalPet,
  type LocalPetStore,
} from '../domain/customer-pets';
import { isValidProfileSenderId } from '../domain/customer-profile';

/**
 * F1: bound of one read or write, connection acquire included. Shorter than
 * the service's CUSTOMER_PETS_LOCAL_IO_TIMEOUT_MS (10 s): the margin covers
 * the network, so a timed-out write is committed or aborted on the server
 * before the service moves on and reads again.
 */
export const LOCAL_PET_STORE_TIMEOUT_MS = 8_000;

type Connectable = Pick<Pool, 'connect'>;

class LocalPetStoreTimeoutError extends Error {
  constructor(stage: string) {
    super(`local pet store ${stage} timed out`);
    this.name = 'LocalPetStoreTimeoutError';
  }
}

/**
 * T4b (S8): the prospect's local pet list in `customer_profiles.pets`
 * (migration 5700). Replace semantics in one statement; every other
 * column is never touched. An empty list clears an
 * existing row and never creates a profile.
 *
 * F1: every call runs in its own transaction on a client taken from the
 * shared pool (the pool's settings are untouched), bounded by
 * LOCAL_PET_STORE_TIMEOUT_MS:
 *   - the acquire is raced against the deadline; a client that arrives late
 *     is released without sending anything;
 *   - `statement_timeout` and `idle_in_transaction_session_timeout` are set
 *     LOCAL to the time left, so the server cancels a statement (COMMIT
 *     included) or an abandoned transaction by the deadline;
 *   - at the deadline (or on any error) the connection is destroyed, which
 *     aborts the open transaction; COMMIT is only sent before the deadline.
 * So a timed-out write cannot land later than the deadline. Its outcome is
 * still unknown to the caller: a COMMIT sent just before the deadline may
 * have committed although the call rejects, so callers must treat any
 * rejected write as possibly landed (the pets service rereads).
 */
@Injectable()
export class PostgresLocalPetStore implements LocalPetStore {
  constructor(@Inject(PG_POOL) private readonly pool: Connectable) {}

  async read(senderId: string): Promise<LocalPet[]> {
    if (!isValidProfileSenderId(senderId)) return [];
    const result = await this.bounded((client) =>
      client.query<{ pets: unknown }>(
        'SELECT pets FROM customer_profiles WHERE sender_id = $1',
        [senderId],
      ),
    );
    return normalizeLocalPets(result.rows[0]?.pets ?? null);
  }

  async write(senderId: string, pets: LocalPet[], now: Date): Promise<void> {
    if (!isValidProfileSenderId(senderId)) return;
    await this.bounded(async (client) => {
      if (pets.length === 0) {
        await client.query(
          'UPDATE customer_profiles SET pets = NULL, updated_at = $2::timestamptz WHERE sender_id = $1',
          [senderId, now.toISOString()],
        );
        return;
      }
      await client.query(
        `INSERT INTO customer_profiles (sender_id, pets, created_at, updated_at)
VALUES ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)
ON CONFLICT (sender_id) DO UPDATE SET pets = $2::jsonb, updated_at = $3::timestamptz`,
        [senderId, JSON.stringify(pets), now.toISOString()],
      );
    });
  }

  /** Runs `work` in a transaction that ends (committed or aborted) by the
   *  deadline; see the class comment. */
  private async bounded<T>(work: (client: PoolClient) => Promise<T>) {
    const deadline = Date.now() + LOCAL_PET_STORE_TIMEOUT_MS;
    const left = () => deadline - Date.now();
    const client = await this.acquire(left());
    let released = false;
    const release = (error?: Error) => {
      if (released) return;
      released = true;
      client.release(error);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new LocalPetStoreTimeoutError('statement');
        // Destroys the connection: the server aborts the open transaction.
        release(error);
        reject(error);
      }, left());
      timer.unref?.();
    });
    const transaction = async (): Promise<T> => {
      await client.query('BEGIN');
      const ms = Math.floor(left());
      if (ms <= 0) throw new LocalPetStoreTimeoutError('statement');
      await client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $1, true)",
        [String(ms)],
      );
      const value = await work(client);
      if (released || left() <= 0)
        throw new LocalPetStoreTimeoutError('commit');
      await client.query('COMMIT');
      return value;
    };
    const run = transaction();
    // The deadline may win the race: the abandoned run must not go unhandled.
    run.catch(() => undefined);
    try {
      const value = await Promise.race([run, expired]);
      release();
      return value;
    } catch (error) {
      release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A pooled client within `ms`; one that arrives later is released
   *  untouched (nothing was sent on it). */
  private acquire(ms: number): Promise<PoolClient> {
    return new Promise<PoolClient>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new LocalPetStoreTimeoutError('connection acquire'));
      }, ms);
      timer.unref?.();
      this.pool.connect().then(
        (client) => {
          if (settled) {
            client.release();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(client);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
