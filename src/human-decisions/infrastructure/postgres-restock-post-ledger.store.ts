/**
 * R3b3-c3a/c3b fenced POST ledger CAS for the RESTOCK POST ledger.
 *
 * `beginPost` flips the exact ACTIVE RESTOCK reservation for
 * `(senderId, sourceRequestId/request_key)` from RESERVED to POST_IN_FLIGHT and
 * authorizes exactly one POST. `recordReceipt` records the backend decision id
 * only from the exact ACTIVE POST_IN_FLIGHT row (attempt timestamp set, no prior
 * id) in one UPDATE. `markUnknown` holds the exact ACTIVE RESERVED|POST_IN_FLIGHT
 * row as UNKNOWN, deriving `pre_post` vs `ambiguous_post` from the actual
 * persisted attempt timestamp.
 *
 * Every method snapshots the caller-owned input as exact own data descriptors
 * before any connection, verifies the ACTUAL persisted projection, and never
 * synthesizes a target or mints an id. A zero-row update is re-read once and
 * classified with the pure c1 state machine but NEVER emits its own transition;
 * a DB error or an ambiguous driver/projection result throws with no retry.
 *
 * This adapter is not DI-wired; HTTP/send/route wiring is a later cut.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  classifyPostTransition,
  type RestockPostBlockedReason,
  type RestockPostClassifyInput,
  type RestockPostDecision,
  type RestockPostLedgerPort,
  type RestockPostReceiptInput,
  type RestockPostRow,
  type RestockPostStartInput,
  type RestockPostState,
} from '../domain/restock-post-ledger';

type Row = Record<string, unknown>;

const POST_COLUMNS =
  'sender_id, route, request_key, status, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at';
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
const RECORD_RECEIPT_SQL = `UPDATE human_decision_reservations
SET post_state = 'RECEIPT_RECORDED',
    backend_decision_id = $3,
    receipt_recorded_at = now(),
    updated_at = now()
WHERE sender_id = $1
  AND route = 'RESTOCK'
  AND request_key = $2
  AND status = 'ACTIVE'
  AND post_state = 'POST_IN_FLIGHT'
  AND backend_decision_id IS NULL
  AND post_attempted_at IS NOT NULL
RETURNING ${POST_COLUMNS}`;
const MARK_UNKNOWN_SQL = `UPDATE human_decision_reservations
SET post_state = 'UNKNOWN',
    unknown_observed_at = now(),
    updated_at = now()
WHERE sender_id = $1
  AND route = 'RESTOCK'
  AND request_key = $2
  AND status = 'ACTIVE'
  AND post_state IN ('RESERVED', 'POST_IN_FLIGHT')
  AND backend_decision_id IS NULL
RETURNING ${POST_COLUMNS}`;
const READ_POST_SQL = `SELECT ${POST_COLUMNS}
FROM human_decision_reservations
WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2
LIMIT 1`;
const START_KEYS = ['senderId', 'sourceRequestId'];
const RECEIPT_KEYS = ['senderId', 'sourceRequestId', 'backendDecisionId'];

const isRow = (row: unknown): boolean =>
  typeof row === 'object' &&
  row !== null &&
  !Array.isArray(row) &&
  (Object.getPrototypeOf(row) === Object.prototype ||
    Object.getPrototypeOf(row) === null);

/** A driver timestamp is trusted only as a real, non-NaN Date so a corrupted
 * projection fails closed instead of faking a durable success. */
const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

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

/** `record_receipt` input: exact three-key own-data snapshot, then the c1
 * classifier against a synthetic valid IN_FLIGHT row proves the backend id is a
 * UUID (an `unknown` existing would short-circuit to `unknown_row` first). */
function snapshotReceiptInput(input: unknown): {
  senderId: string;
  sourceRequestId: string;
  backendDecisionId: string;
} | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(input);
    if (
      own.length !== RECEIPT_KEYS.length ||
      !own.every((key) => typeof key === 'string' && RECEIPT_KEYS.includes(key))
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
      existing: {
        status: 'POST_IN_FLIGHT',
        senderId: snapshot.senderId as string,
        sourceRequestId: snapshot.sourceRequestId as string,
        backendDecisionId: null,
      },
      step: {
        kind: 'record_receipt',
        backendDecisionId: snapshot.backendDecisionId,
      },
    } as RestockPostClassifyInput);
    if (probe.action !== 'record_receipt') return null;
    return {
      senderId: snapshot.senderId as string,
      sourceRequestId: snapshot.sourceRequestId as string,
      backendDecisionId: probe.backendDecisionId,
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

/** One SELECT of the exact row after a zero-row update; returns the row or the
 * fail-closed reason (never a synthesized target). */
async function readExact(
  pool: Pool,
  senderId: string,
  sourceRequestId: string,
): Promise<Row | RestockPostBlockedReason> {
  const read = await pool.query(READ_POST_SQL, [senderId, sourceRequestId]);
  const rows = singleRow(read);
  if (rows.length === 0) return 'missing_row';
  if (!matchesTarget(rows[0], senderId, sourceRequestId)) return 'unknown_row';
  return rows[0];
}

@Injectable()
export class PostgresRestockPostLedgerStore implements RestockPostLedgerPort {
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
    const read = await readExact(this.pool, senderId, sourceRequestId);
    if (typeof read === 'string') return { action: 'blocked', reason: read };
    const decision = classifyPostTransition({
      senderId,
      sourceRequestId,
      existing: toPostRow(read),
      step: { kind: 'begin_post' },
    });
    // A zero-row UPDATE that still reads RESERVED did not visibly apply: fail
    // closed as uncertain rather than authorizing a second POST.
    return decision.action === 'authorize_post'
      ? { action: 'blocked', reason: 'unknown_state' }
      : decision;
  }

  async recordReceipt(
    input: RestockPostReceiptInput,
  ): Promise<RestockPostDecision> {
    const target = snapshotReceiptInput(input);
    if (target === null) {
      return { action: 'blocked', reason: 'malformed_input' };
    }
    const { senderId, sourceRequestId, backendDecisionId } = target;

    const updated = await this.pool.query(RECORD_RECEIPT_SQL, [
      senderId,
      sourceRequestId,
      backendDecisionId,
    ]);
    const updatedRows = singleRow(updated);
    if (updatedRows.length === 1) {
      const row = updatedRows[0];
      if (
        !matchesTarget(row, senderId, sourceRequestId) ||
        row.post_state !== 'RECEIPT_RECORDED' ||
        row.backend_decision_id !== backendDecisionId ||
        !isValidDate(row.post_attempted_at) ||
        !isValidDate(row.receipt_recorded_at)
      ) {
        throw new Error(
          'restock receipt CAS returned an unexpected projection',
        );
      }
      return { action: 'record_receipt', backendDecisionId };
    }

    // Zero-row: never record. Re-read, verify and classify; a still
    // POST_IN_FLIGHT row means the CAS did not visibly apply -> fail closed.
    const read = await readExact(this.pool, senderId, sourceRequestId);
    if (typeof read === 'string') return { action: 'blocked', reason: read };
    const decision = classifyPostTransition({
      senderId,
      sourceRequestId,
      existing: toPostRow(read),
      step: { kind: 'record_receipt', backendDecisionId },
    });
    return decision.action === 'record_receipt'
      ? { action: 'blocked', reason: 'unknown_state' }
      : decision;
  }

  async markUnknown(
    input: RestockPostStartInput,
  ): Promise<RestockPostDecision> {
    const target = snapshotStartInput(input);
    if (target === null) {
      return { action: 'blocked', reason: 'malformed_input' };
    }
    const { senderId, sourceRequestId } = target;

    const updated = await this.pool.query(MARK_UNKNOWN_SQL, [
      senderId,
      sourceRequestId,
    ]);
    const updatedRows = singleRow(updated);
    if (updatedRows.length === 1) {
      const row = updatedRows[0];
      const attempted = row.post_attempted_at;
      if (
        !matchesTarget(row, senderId, sourceRequestId) ||
        row.post_state !== 'UNKNOWN' ||
        row.backend_decision_id !== null ||
        !isValidDate(row.unknown_observed_at) ||
        !(attempted === null || isValidDate(attempted))
      ) {
        throw new Error(
          'restock unknown CAS returned an unexpected projection',
        );
      }
      // The actual persisted attempt timestamp distinguishes a pre-attempt hold
      // from an ambiguous in-flight POST.
      return {
        action: 'mark_unknown',
        reason: attempted === null ? 'pre_post' : 'ambiguous_post',
      };
    }

    // Zero-row: never mark. Re-read, verify and classify; a still-transitionable
    // row means the CAS did not visibly apply -> fail closed.
    const read = await readExact(this.pool, senderId, sourceRequestId);
    if (typeof read === 'string') return { action: 'blocked', reason: read };
    const decision = classifyPostTransition({
      senderId,
      sourceRequestId,
      existing: toPostRow(read),
      step: { kind: 'mark_unknown' },
    });
    return decision.action === 'mark_unknown'
      ? { action: 'blocked', reason: 'unknown_state' }
      : decision;
  }
}
