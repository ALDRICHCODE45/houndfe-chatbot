import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  isEmptyProfilePatch,
  isValidProfileSenderId,
  normalizeCustomerProfilePatch,
  type CustomerPet,
  type CustomerProfile,
  type CustomerProfilePatch,
  type CustomerProfileStore,
} from '../domain/customer-profile';
import type {
  CustomerRegister,
  CustomerTone,
} from '../../llm-agent/domain/customer-style';

interface CustomerProfileRow {
  sender_id: string;
  display_name: string | null;
  preferred_name: string | null;
  register: CustomerRegister;
  emojis: boolean;
  tone: CustomerTone;
  pet: CustomerPet | null;
  last_order_folio: string | null;
  last_order_confirmed_at: Date | null;
  last_order_total_cents: string | number | null;
  updated_at: Date;
}

type Queryable = Pick<Pool, 'query'>;

const COLUMNS =
  'sender_id, display_name, preferred_name, register, emojis, tone, pet, ' +
  'last_order_folio, last_order_confirmed_at, last_order_total_cents, updated_at';

/**
 * Merge-only upsert in ONE statement: every column keeps the stored value
 * when the patch has none (COALESCE), pet facts are concatenated per key,
 * and the last-order pointer is replaced as a whole. No read-modify-write,
 * so concurrent writers never erase each other's fields.
 */
const UPSERT = `
INSERT INTO customer_profiles (${COLUMNS}, created_at)
VALUES ($1, $2, $3, COALESCE($4::text, 'usted'), COALESCE($5::boolean, false),
        COALESCE($6::text, 'neutral'), $7::jsonb, $8::text, $9::timestamptz,
        $10::bigint, $11::timestamptz, $11::timestamptz)
ON CONFLICT (sender_id) DO UPDATE SET
  display_name = COALESCE(EXCLUDED.display_name, customer_profiles.display_name),
  preferred_name = COALESCE(EXCLUDED.preferred_name, customer_profiles.preferred_name),
  register = COALESCE($4::text, customer_profiles.register),
  emojis = COALESCE($5::boolean, customer_profiles.emojis),
  tone = COALESCE($6::text, customer_profiles.tone),
  pet = CASE WHEN $7::jsonb IS NULL THEN customer_profiles.pet
             ELSE COALESCE(customer_profiles.pet, '{}'::jsonb) || $7::jsonb END,
  last_order_folio = COALESCE($8::text, customer_profiles.last_order_folio),
  last_order_confirmed_at = CASE WHEN $8::text IS NULL
    THEN customer_profiles.last_order_confirmed_at ELSE $9::timestamptz END,
  last_order_total_cents = CASE WHEN $8::text IS NULL
    THEN customer_profiles.last_order_total_cents ELSE $10::bigint END,
  updated_at = $11::timestamptz
RETURNING ${COLUMNS}`;

function toProfile(row: CustomerProfileRow): CustomerProfile {
  const pet =
    row.pet !== null && typeof row.pet === 'object' && !Array.isArray(row.pet)
      ? row.pet
      : null;
  return {
    senderId: row.sender_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.preferred_name === null
      ? {}
      : { preferredName: row.preferred_name }),
    register: row.register,
    emojis: row.emojis,
    tone: row.tone,
    ...(pet === null || Object.keys(pet).length === 0 ? {} : { pet }),
    ...(row.last_order_folio === null ||
    row.last_order_confirmed_at === null ||
    row.last_order_total_cents === null
      ? {}
      : {
          lastOrder: {
            folio: row.last_order_folio,
            confirmedAt: row.last_order_confirmed_at.toISOString(),
            totalCents: Number(row.last_order_total_cents),
          },
        }),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Durable CustomerProfileStore over `customer_profiles` (migration 3700). */
@Injectable()
export class PostgresCustomerProfileStore implements CustomerProfileStore {
  constructor(@Inject(PG_POOL) private readonly pool: Queryable) {}

  async read(senderId: string): Promise<CustomerProfile | null> {
    if (!isValidProfileSenderId(senderId)) return null;
    const result = await this.pool.query<CustomerProfileRow>(
      `SELECT ${COLUMNS} FROM customer_profiles WHERE sender_id = $1`,
      [senderId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toProfile(row);
  }

  async upsert(
    senderId: string,
    patch: CustomerProfilePatch,
    now: Date,
  ): Promise<CustomerProfile | null> {
    if (!isValidProfileSenderId(senderId)) return null;
    const next = normalizeCustomerProfilePatch(patch);
    if (isEmptyProfilePatch(next)) return this.read(senderId);
    const result = await this.pool.query<CustomerProfileRow>(UPSERT, [
      senderId,
      next.displayName ?? null,
      next.preferredName ?? null,
      next.register ?? null,
      next.emojis ?? null,
      next.tone ?? null,
      next.pet === undefined ? null : JSON.stringify(next.pet),
      next.lastOrder?.folio ?? null,
      next.lastOrder?.confirmedAt ?? null,
      next.lastOrder?.totalCents ?? null,
      now.toISOString(),
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toProfile(row);
  }

  async delete(senderId: string): Promise<boolean> {
    if (!isValidProfileSenderId(senderId)) return false;
    const result = await this.pool.query(
      'DELETE FROM customer_profiles WHERE sender_id = $1',
      [senderId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
