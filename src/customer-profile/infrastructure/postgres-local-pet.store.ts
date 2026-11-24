import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  normalizeLocalPets,
  type LocalPet,
  type LocalPetStore,
} from '../domain/customer-pets';
import { isValidProfileSenderId } from '../domain/customer-profile';

type Queryable = Pick<Pool, 'query'>;

/**
 * T4b (S8): the prospect's local pet list in `customer_profiles.pets`
 * (migration 5700). Replace semantics in one statement; the legacy `pet`
 * column and every other column are never touched. An empty list clears an
 * existing row and never creates a profile.
 */
@Injectable()
export class PostgresLocalPetStore implements LocalPetStore {
  constructor(@Inject(PG_POOL) private readonly pool: Queryable) {}

  async read(senderId: string): Promise<LocalPet[]> {
    if (!isValidProfileSenderId(senderId)) return [];
    const result = await this.pool.query<{ pets: unknown }>(
      'SELECT pets FROM customer_profiles WHERE sender_id = $1',
      [senderId],
    );
    return normalizeLocalPets(result.rows[0]?.pets ?? null);
  }

  async write(senderId: string, pets: LocalPet[], now: Date): Promise<void> {
    if (!isValidProfileSenderId(senderId)) return;
    if (pets.length === 0) {
      await this.pool.query(
        'UPDATE customer_profiles SET pets = NULL, updated_at = $2::timestamptz WHERE sender_id = $1',
        [senderId, now.toISOString()],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO customer_profiles (sender_id, pets, created_at, updated_at)
VALUES ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)
ON CONFLICT (sender_id) DO UPDATE SET pets = $2::jsonb, updated_at = $3::timestamptz`,
      [senderId, JSON.stringify(pets), now.toISOString()],
    );
  }
}
