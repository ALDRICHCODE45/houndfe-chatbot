/**
 * R3b3-c3a fenced `beginPost` compare-and-set for the RESTOCK POST ledger.
 *
 * One atomic UPDATE flips the exact ACTIVE RESTOCK reservation for
 * `(senderId, sourceRequestId/request_key)` from RESERVED to POST_IN_FLIGHT
 * (recording `post_attempted_at`/`updated_at`). Exactly one returned row whose
 * ACTUAL projection matches the fenced target authorizes a single POST. A
 * zero-row update is re-read; if the actual persisted row is not the exact
 * ACTIVE RESTOCK target it fails closed as `unknown_row` (never leaking a stored
 * backend id), otherwise it is classified with the pure c1 state machine and
 * NEVER authorizes. A DB error or an ambiguous driver/projection result throws
 * so the caller must hold and must never auto-POST. `sourceRequestId` is
 * caller-owned: it is never minted here and webhook dedup is not assumed.
 *
 * This adapter is not DI-wired and implements only `beginPost`; `recordReceipt`
 * and `markUnknown` are later cuts.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  classifyPostTransition,
  type RestockPostClassifyInput,
  type RestockPostDecision,
  type RestockPostLedgerPort,
  type RestockPostRow,
  type RestockPostStartInput,
  type RestockPostState,
} from '../domain/restock-post-ledger';

type Row = Record<string, unknown>;
type BeginPostPort = Pick<RestockPostLedgerPort, 'beginPost'>;

const POST_COLUMNS =
  'sender_id, route, request_key, status, post_state, backend_decision_id';
const BEGIN_POST_SQL = `UPDATE human_decision_reservations
SET post_state = 'POST_IN_FLIGHT',
    post_attempted_at = now(),
    updated_at = now()
WHERE sender_id = $1
  AND route = 'RESTOCK'
  AND request_key = $2
  AND status = 'ACTIVE'
  AND post_state = 'RESERVED'
  AND backend_decision_id IS NULL
RETURNING ${POST_COLUMNS}`;
const READ_POST_SQL = `SELECT ${POST_COLUMNS}
FROM human_decision_reservations
WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2
LIMIT 1`;
const START_KEYS = ['senderId', 'sourceRequestId'];

const isRow = (row: unknown): boolean =>
  typeof row === 'object' &&
  row !== null &&
  !Array.isArray(row) &&
  (Object.getPrototypeOf(row) === Object.prototype ||
    Object.getPrototypeOf(row) === null);

/** A driver result is trusted only as an array whose integer rowCount matches
 * `rows.length` and is <= 1; anything else is ambiguous and throws. */
function singleRow(result: {
  rows: unknown[];
  rowCount: number | null;
}): Row[] {
  const { rows, rowCount } = result;
  const ok =
    Array.isArray(rows) &&
    typeof rowCount === 'number' &&
    Number.isInteger(rowCount) &&
    rowCount === rows.length &&
    rowCount <= 1 &&
    rows.every(isRow);
  if (!ok) throw new Error('inconsistent restock post ledger read');
  return rows as Row[];
}

/** Exact two-key own-data snapshot of the caller input, checked against a live
 * reread so a hostile or mutating Proxy cannot substitute a field. The pure c1
 * classifier then enforces a nonblank sender and UUID key; null fails closed. */
function snapshotStartInput(
  input: unknown,
): { senderId: string; sourceRequestId: string } | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(input);
    if (
      own.length !== START_KEYS.length ||
      !own.every((key) => typeof key === 'string' && START_KEYS.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) return null;
      const read = (input as Record<string, unknown>)[key as string];
      if (!Object.is(descriptor.value, read)) return null;
      snapshot[key as string] = descriptor.value;
    }
    const probe = classifyPostTransition({
      senderId: snapshot.senderId,
      sourceRequestId: snapshot.sourceRequestId,
      existing: 'unknown',
      step: { kind: 'begin_post' },
    } as RestockPostClassifyInput);
    if (probe.action === 'blocked' && probe.reason === 'malformed_input') {
      return null;
    }
    return {
      senderId: snapshot.senderId as string,
      sourceRequestId: snapshot.sourceRequestId as string,
    };
  } catch {
    return null;
  }
}

/** The ACTUAL persisted projection must match the fenced target exactly; a
 * CLOSED or mismatched row is untrusted and must never be classified. */
function matchesTarget(
  row: Row,
  senderId: string,
  sourceRequestId: string,
): boolean {
  return (
    row.sender_id === senderId &&
    row.route === 'RESTOCK' &&
    row.request_key === sourceRequestId &&
    row.status === 'ACTIVE'
  );
}

/** Build the c1 row from the ACTUAL persisted values, never the input target. */
function toPostRow(row: Row): RestockPostRow {
  return {
    status: row.post_state as RestockPostState,
    senderId: row.sender_id as string,
    sourceRequestId: row.request_key as string,
    backendDecisionId: row.backend_decision_id as string | null,
  };
}

@Injectable()
export class PostgresRestockPostLedgerStore implements BeginPostPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async beginPost(input: RestockPostStartInput): Promise<RestockPostDecision> {
    const target = snapshotStartInput(input);
    if (target === null) {
      return { action: 'blocked', reason: 'malformed_input' };
    }
    const { senderId, sourceRequestId } = target;

    const updated = await this.pool.query(BEGIN_POST_SQL, [
      senderId,
      sourceRequestId,
    ]);
    const updatedRows = singleRow(updated);
    if (updatedRows.length === 1) {
      const row = updatedRows[0];
      if (
        !matchesTarget(row, senderId, sourceRequestId) ||
        row.post_state !== 'POST_IN_FLIGHT' ||
        row.backend_decision_id !== null
      ) {
        throw new Error('restock post CAS returned an unexpected projection');
      }
      return { action: 'authorize_post' };
    }

    // Zero-row: never authorize. Re-read the exact RESTOCK row, verify the
    // actual projection, then classify it.
    const read = await this.pool.query(READ_POST_SQL, [
      senderId,
      sourceRequestId,
    ]);
    const readRows = singleRow(read);
    if (readRows.length === 0) {
      return { action: 'blocked', reason: 'missing_row' };
    }
    const row = readRows[0];
    if (!matchesTarget(row, senderId, sourceRequestId)) {
      return { action: 'blocked', reason: 'unknown_row' };
    }
    const decision = classifyPostTransition({
      senderId,
      sourceRequestId,
      existing: toPostRow(row),
      step: { kind: 'begin_post' },
    });
    // A zero-row UPDATE that still reads RESERVED did not visibly apply: fail
    // closed as uncertain rather than authorizing a second POST.
    return decision.action === 'authorize_post'
      ? { action: 'blocked', reason: 'unknown_state' }
      : decision;
  }
}
