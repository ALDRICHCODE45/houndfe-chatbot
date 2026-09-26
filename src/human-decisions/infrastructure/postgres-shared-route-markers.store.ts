/**
 * HD-R3b3-c4c2a read-only Postgres adapter for SharedRouteMarkersPort: ONE
 * parameterized statement snapshots the ACTIVE reservation count+route and the
 * pending-legacy-handoff EXISTS in a single round trip. No write, CAS, release,
 * transaction, or DI wiring.
 *
 * `count(*)::int` arrives as a number and `EXISTS` as a boolean; every other
 * shape — an invalid sender, a wrong rowCount, a multiple/unknown/null active
 * route, a non-integer or negative count, a non-boolean EXISTS, or a SQL error
 * — fails closed to the explicit `'unknown'` reading, never `false`. This read
 * proves nothing about concurrency or a pre-R3b3 legacy writer; the final
 * reserve CAS is still required.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import type {
  SharedRouteMarkers,
  SharedRouteMarkersPort,
} from '../domain/shared-route-markers';

const MAX_SENDER_ID = 200;
const UNKNOWN: SharedRouteMarkers = Object.freeze({
  legacyRequestPending: 'unknown',
  restockIntentPresent: 'unknown',
});

/**
 * One statement, three scalars: the ACTIVE reservation count and its route
 * (the partial unique index keeps this at most 1) plus whether a pending
 * legacy handoff exists for the same customer. Every scalar is bound to `$1`.
 */
const SNAPSHOT_SQL = `SELECT
  (SELECT count(*)::int FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE') AS active_count,
  (SELECT route FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE' LIMIT 1) AS active_route,
  EXISTS (SELECT 1 FROM human_handoff_requests WHERE customer_id = $1 AND status = 'pending') AS legacy_pending`;

/** Strict sender identity: a plain, non-blank, untrimmed, bounded string. */
function validSenderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SENDER_ID &&
    value === value.trim()
  );
}

const ROW_KEYS = ['active_count', 'active_route', 'legacy_pending'] as const;

/** Read own data descriptors only, and reject a Proxy's divergent `get`. */
function snapshotRow(row: unknown): Record<string, unknown> | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row))
    return null;
  const prototype = Object.getPrototypeOf(row) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(row);
  if (
    keys.length !== ROW_KEYS.length ||
    keys.some((key) => !ROW_KEYS.some((expected) => expected === key))
  ) {
    return null;
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of ROW_KEYS) {
    const descriptor = Reflect.getOwnPropertyDescriptor(row, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      !Object.is(descriptor.value, (row as Record<string, unknown>)[key])
    ) {
      return null;
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Map one verified snapshot row, or the fail-closed `UNKNOWN` reading. */
function mapSnapshot(result: {
  rows: unknown[];
  rowCount: number | null;
}): SharedRouteMarkers {
  const { rows, rowCount } = result;
  if (
    !Array.isArray(rows) ||
    typeof rowCount !== 'number' ||
    !Number.isInteger(rowCount) ||
    rowCount !== 1 ||
    rows.length !== 1
  ) {
    return UNKNOWN;
  }
  const row = snapshotRow(rows[0]);
  if (row === null) return UNKNOWN;
  const count = row.active_count;
  const route = row.active_route;
  const pending = row.legacy_pending;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 0 ||
    typeof pending !== 'boolean'
  ) {
    return UNKNOWN;
  }
  if (count === 0) {
    return route === null
      ? { legacyRequestPending: pending, restockIntentPresent: false }
      : UNKNOWN;
  }
  if (count === 1 && route === 'LEGACY_OPS') {
    return { legacyRequestPending: true, restockIntentPresent: false };
  }
  if (count === 1 && route === 'RESTOCK') {
    return { legacyRequestPending: pending, restockIntentPresent: true };
  }
  return UNKNOWN;
}

@Injectable()
export class PostgresSharedRouteMarkersStore implements SharedRouteMarkersPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  async readForSender(senderId: string): Promise<SharedRouteMarkers> {
    if (!validSenderId(senderId)) return UNKNOWN;
    try {
      const result = await this.pool.query(SNAPSHOT_SQL, [senderId]);
      return mapSnapshot(result);
    } catch {
      return UNKNOWN;
    }
  }
}
