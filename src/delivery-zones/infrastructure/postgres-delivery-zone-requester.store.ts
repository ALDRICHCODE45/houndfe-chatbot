import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  OPEN_DELIVERY_ZONE_STATUSES,
  type DeliveryZonePollPolicy,
  type DeliveryZoneRequesterPatch,
  type DeliveryZoneRequesterRow,
  type DeliveryZoneRequesterStatus,
  type DeliveryZoneRequesterStore,
} from '../domain/delivery-zone-requester';

const TABLE = 'delivery_zone_requesters';
/** Row field → column. JSON columns hold the intake body and resolution. */
const COLUMNS = {
  sourceRequestId: 'source_request_id',
  senderId: 'sender_id',
  zipCode: 'zip_code',
  intake: 'intake',
  requesterId: 'requester_id',
  status: 'status',
  lastPolledAt: 'last_polled_at',
  resolution: 'resolution',
  applyBefore: 'apply_before',
  channel: 'channel',
  attemptId: 'attempt_id',
  attemptedAt: 'attempted_at',
  deliveryOutcome: 'delivery_outcome',
  providerMessageId: 'provider_message_id',
  providerAcceptedObservedAt: 'provider_accepted_observed_at',
  notifiedAt: 'notified_at',
  ackOutcome: 'ack_outcome',
  ackedAt: 'acked_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof DeliveryZoneRequesterRow, string>;
type Field = keyof typeof COLUMNS;
const FIELDS = Object.keys(COLUMNS) as Field[];
const JSON_FIELDS = new Set<Field>(['intake', 'resolution']);
const TIME_FIELDS = new Set<Field>([
  'lastPolledAt',
  'applyBefore',
  'attemptedAt',
  'providerAcceptedObservedAt',
  'notifiedAt',
  'ackedAt',
  'createdAt',
  'updatedAt',
]);
const SELECT = FIELDS.map((field) => `${COLUMNS[field]} AS "${field}"`).join(
  ', ',
);
const OPEN = OPEN_DELIVERY_ZONE_STATUSES.map((s) => `'${s}'`).join(', ');

type Param = string | number | null;

function toParam(field: Field, value: unknown): Param {
  if (value === null || value === undefined) return null;
  if (JSON_FIELDS.has(field)) return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new TypeError(`Unsupported DELIVERY_ZONE column value for ${field}`);
}

/** pg returns timestamptz as Date and jsonb parsed; map back to the row shape. */
function toRow(raw: Record<string, unknown>): DeliveryZoneRequesterRow {
  const row: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = raw[field];
    row[field] =
      value instanceof Date && TIME_FIELDS.has(field)
        ? value.toISOString()
        : (value ?? null);
  }
  // SAFETY: rows are written only by this adapter from typed rows (intake
  // and resolution are normalized DTOs before storage) and the table CHECKs
  // pin status, channel and outcome enums, so every column maps 1:1.
  return row as unknown as DeliveryZoneRequesterRow;
}

/**
 * Durable DELIVERY_ZONE requester table. Each mutation is a single-statement
 * status CAS; the partial unique index keeps one open requester per
 * (sender, ZIP). Due selection mirrors `isDeliveryZoneRequesterDue`.
 */
@Injectable()
export class PostgresDeliveryZoneRequesterStore implements DeliveryZoneRequesterStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findOpen(
    senderId: string,
    zipCode: string,
  ): Promise<DeliveryZoneRequesterRow | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${SELECT} FROM ${TABLE}
       WHERE sender_id = $1 AND zip_code = $2 AND status IN (${OPEN})`,
      [senderId, zipCode],
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async createOrGetOpen(
    row: DeliveryZoneRequesterRow,
  ): Promise<DeliveryZoneRequesterRow> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO ${TABLE} (${FIELDS.map((f) => COLUMNS[f]).join(', ')})
       VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT DO NOTHING
       RETURNING ${SELECT}`,
      FIELDS.map((field) => toParam(field, row[field])),
    );
    if (result.rows[0]) return toRow(result.rows[0]);
    const open = await this.findOpen(row.senderId, row.zipCode);
    if (open) return open;
    const same = await this.pool.query<Record<string, unknown>>(
      `SELECT ${SELECT} FROM ${TABLE} WHERE source_request_id = $1`,
      [row.sourceRequestId],
    );
    if (same.rows[0]) return toRow(same.rows[0]);
    throw new Error('DELIVERY_ZONE requester insert conflicted without a row');
  }

  async transition(
    sourceRequestId: string,
    from: DeliveryZoneRequesterStatus,
    patch: DeliveryZoneRequesterPatch,
  ): Promise<DeliveryZoneRequesterRow | null> {
    const fields = (Object.keys(patch) as Field[]).filter(
      (field) =>
        field in COLUMNS && patch[field as keyof typeof patch] !== undefined,
    );
    const sets = fields.map(
      (field, index) =>
        `${COLUMNS[field]} = $${index + 3}${JSON_FIELDS.has(field) ? '::jsonb' : ''}`,
    );
    if (sets.length === 0) sets.push('status = status');
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE ${TABLE} SET ${sets.join(', ')}
       WHERE source_request_id = $1 AND status = $2
       RETURNING ${SELECT}`,
      [
        sourceRequestId,
        from,
        ...fields.map((field) =>
          toParam(field, patch[field as keyof typeof patch]),
        ),
      ],
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async listDue(
    now: string,
    limit: number,
    policy: DeliveryZonePollPolicy,
  ): Promise<DeliveryZoneRequesterRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${SELECT} FROM ${TABLE}
       WHERE status IN ('RESOLVED', 'SEND_STARTED', 'NOTIFIED')
          OR (status IN ('INTAKE_PENDING', 'PENDING') AND (
                last_polled_at IS NULL
             OR $1::timestamptz - last_polled_at >=
                CASE WHEN $1::timestamptz - created_at >= $3 * interval '1 millisecond'
                     THEN $4 * interval '1 millisecond'
                     ELSE $5 * interval '1 millisecond' END))
       ORDER BY last_polled_at ASC NULLS FIRST, created_at ASC
       LIMIT $2`,
      [
        now,
        limit,
        policy.slowAfterMs,
        policy.slowIntervalMs,
        policy.intervalMs,
      ],
    );
    return result.rows.map(toRow);
  }
}
