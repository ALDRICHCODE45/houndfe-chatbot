/**
 * INACTIVE, unwired EXPIRATION preparation and claim CAS (no DI/HTTP/send).
 * `preparePost` initializes NULL -> RESERVED; `beginPost` claims RESERVED ->
 * POST_IN_FLIGHT. Only the successful CAS authorizes a POST. Persistence
 * cannot prove customer intent: the caller MUST first run
 * `bindExpirationInboundEvent` and `preflightExpirationSubject`, then reserve
 * the row. SQL `intake = $3::jsonb` + the exact own-data snapshot forbid
 * substitution; a zero-row UPDATE re-reads once, classifies, and never emits
 * its own transition or retries.
 */
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import {
  classifyExpirationPostTransition,
  type ExpirationPostDecision,
} from '../domain/expiration-post-ledger';
import { PG_POOL } from '../../database/postgres-pool.provider';

export type ExpirationPrepareBlockedReason =
  | 'malformed_input'
  | 'missing_row'
  | 'intake_mismatch'
  | 'unknown_row';

export type ExpirationPrepareDecision =
  | { readonly action: 'prepared' }
  | { readonly action: 'already_prepared' }
  | {
      readonly action: 'blocked';
      readonly reason: ExpirationPrepareBlockedReason;
    };

/** Exact caller input: reservation identity plus its validated intake. */
export interface ExpirationPostPrepareInput {
  readonly senderId: string;
  readonly sourceRequestId: string;
  readonly intake: ExpirationIntakeInput;
}

type Row = Record<string, unknown>;
const COLUMNS = 'sender_id, route, request_key, status, post_state, intake';
const PREPARE_SQL = `UPDATE human_decision_reservations
SET post_state = 'RESERVED', updated_at = now()
WHERE route = 'EXPIRATION'
  AND sender_id = $1
  AND request_key = $2
  AND status = 'ACTIVE'
  AND post_state IS NULL
  AND intake = $3::jsonb
RETURNING ${COLUMNS}`;
const READ_SQL = `SELECT ${COLUMNS} FROM human_decision_reservations
WHERE route = 'EXPIRATION' AND sender_id = $1 AND request_key = $2
LIMIT 1`;
const CLAIM_COLUMNS = `${COLUMNS}, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at`;
const BEGIN_POST_SQL = `UPDATE human_decision_reservations
SET post_state = 'POST_IN_FLIGHT', post_attempted_at = now(), updated_at = now()
WHERE route = 'EXPIRATION'
  AND sender_id = $1
  AND request_key = $2
  AND status = 'ACTIVE'
  AND post_state = 'RESERVED'
  AND intake = $3::jsonb
  AND backend_decision_id IS NULL
  AND post_attempted_at IS NULL
  AND receipt_recorded_at IS NULL
  AND unknown_observed_at IS NULL
RETURNING ${CLAIM_COLUMNS}`;
const CLAIM_READ_SQL = `SELECT ${CLAIM_COLUMNS} FROM human_decision_reservations
WHERE route = 'EXPIRATION' AND sender_id = $1 AND request_key = $2
LIMIT 1`;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_KEYS = ['senderId', 'sourceRequestId', 'intake'];
const INTAKE_KEYS = ['sourceRequestId', 'type', 'productId', 'variantId'];
const blocked = (
  reason: ExpirationPrepareBlockedReason,
): ExpirationPrepareDecision => ({ action: 'blocked', reason });

const isRow = (row: unknown): boolean =>
  typeof row === 'object' &&
  row !== null &&
  !Array.isArray(row) &&
  (Object.getPrototypeOf(row) === Object.prototype ||
    Object.getPrototypeOf(row) === null);

/** Driver result trusted only as an array whose integer rowCount equals
 * `rows.length` (<=1); anything else is ambiguous and throws. */
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
  if (!ok) throw new Error('inconsistent expiration prepare read');
  return rows as Row[];
}

/** Exact own-data snapshot of a plain object with exactly `keys`; any extra,
 * inherited, accessor, or mutating descriptor fails closed. */
function snapshotOwn(value: unknown, keys: readonly string[]): Row | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === 'string' && keys.includes(key))
    ) {
      return null;
    }
    const snap = Object.create(null) as Row;
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return null;
      const read = (value as Record<string, unknown>)[key as string];
      if (!Object.is(descriptor.value, read)) return null;
      snap[key as string] = descriptor.value;
    }
    return snap;
  } catch {
    return null;
  }
}

/** Exact intake snapshot; extra/accessor keys fail closed, then the strict
 * normalizer validates every byte. */
function snapshotIntake(value: unknown): ExpirationIntakeInput | null {
  const snap = snapshotOwn(value, INTAKE_KEYS);
  return snap === null ? null : normalizeExpirationIntake(snap);
}

/** Exact three-key snapshot; null on bad keys, a UUID-invalid source id, or an
 * intake not bound byte-exactly to that id. */
function snapshotInput(input: unknown): ExpirationPostPrepareInput | null {
  const snap = snapshotOwn(input, INPUT_KEYS);
  if (snap === null) return null;
  const { senderId, sourceRequestId } = snap;
  if (typeof senderId !== 'string' || !senderId.trim()) return null;
  // UUID syntax only; case is preserved byte-for-byte, never normalized.
  if (typeof sourceRequestId !== 'string' || !UUID.test(sourceRequestId)) {
    return null;
  }
  const intake = snapshotIntake(snap.intake);
  if (intake === null || intake.sourceRequestId !== sourceRequestId) {
    return null;
  }
  return { senderId, sourceRequestId, intake };
}

/** The ACTUAL persisted projection must match the fenced target exactly. */
function matches(row: Row, senderId: string, sourceRequestId: string): boolean {
  return (
    row.sender_id === senderId &&
    row.route === 'EXPIRATION' &&
    row.request_key === sourceRequestId &&
    row.status === 'ACTIVE'
  );
}

/** A driver timestamp is trusted only as a real, non-NaN Date so a corrupted
 * projection fails closed instead of faking a durable attempt. */
const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

/** The ACTUAL RETURNING row of the successful claim must be the exact fenced
 * target: same identity/intake, POST_IN_FLIGHT, a valid attempt instant, and
 * every other metadata column still NULL. Anything else throws, never retries. */
function authorizes(
  row: Row,
  senderId: string,
  sourceRequestId: string,
  intake: ExpirationIntakeInput,
): boolean {
  return (
    matches(row, senderId, sourceRequestId) &&
    row.post_state === 'POST_IN_FLIGHT' &&
    isDeepStrictEqual(row.intake, intake) &&
    isValidDate(row.post_attempted_at) &&
    row.backend_decision_id === null &&
    row.receipt_recorded_at === null &&
    row.unknown_observed_at === null
  );
}

@Injectable()
export class PostgresExpirationPostClaimStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async preparePost(input: unknown): Promise<ExpirationPrepareDecision> {
    const target = snapshotInput(input);
    if (target === null) return blocked('malformed_input');
    const { senderId, sourceRequestId, intake } = target;

    const updated = await this.pool.query(PREPARE_SQL, [
      senderId,
      sourceRequestId,
      JSON.stringify(intake),
    ]);
    const updatedRows = singleRow(updated);
    if (updatedRows.length === 1) {
      const row = updatedRows[0];
      if (
        !matches(row, senderId, sourceRequestId) ||
        row.post_state !== 'RESERVED' ||
        !isDeepStrictEqual(row.intake, intake)
      ) {
        throw new Error(
          'expiration prepare CAS returned an unexpected projection',
        );
      }
      return { action: 'prepared' };
    }

    // Zero-row: never authorize. Re-read the exact row and classify it; a still
    // NULL row that matched the predicate would be a non-applying anomaly, so
    // it fails closed as unknown rather than being retried.
    const read = await this.pool.query(READ_SQL, [senderId, sourceRequestId]);
    const readRows = singleRow(read);
    if (readRows.length === 0) return blocked('missing_row');
    const row = readRows[0];
    if (!matches(row, senderId, sourceRequestId)) return blocked('unknown_row');
    if (!isDeepStrictEqual(row.intake, intake)) {
      return blocked('intake_mismatch');
    }
    return row.post_state === 'RESERVED'
      ? { action: 'already_prepared' }
      : blocked('unknown_row');
  }

  /** Claim exactly one RESERVED row as POST_IN_FLIGHT. Only the validated
   * RETURNING projection authorizes; a zero-row update is re-read once and
   * classified (never authorizing), and any error/ambiguity throws. */
  async beginPost(input: unknown): Promise<ExpirationPostDecision> {
    const target = snapshotInput(input);
    if (target === null) {
      return { action: 'blocked', reason: 'malformed_input' };
    }
    const { senderId, sourceRequestId, intake } = target;

    const updated = await this.pool.query(BEGIN_POST_SQL, [
      senderId,
      sourceRequestId,
      JSON.stringify(intake),
    ]);
    const updatedRows = singleRow(updated);
    if (updatedRows.length === 1) {
      if (!authorizes(updatedRows[0], senderId, sourceRequestId, intake)) {
        throw new Error(
          'expiration begin CAS returned an unexpected projection',
        );
      }
      return { action: 'authorize_post' };
    }

    // Zero-row: never authorize. Re-read the exact row, verify identity+intake,
    // then classify with the pure state machine. A still-RESERVED row means the
    // CAS did not visibly apply -> fail closed rather than authorize a POST.
    const read = await this.pool.query(CLAIM_READ_SQL, [
      senderId,
      sourceRequestId,
    ]);
    const readRows = singleRow(read);
    if (readRows.length === 0) {
      return { action: 'blocked', reason: 'missing_row' };
    }
    const row = readRows[0];
    if (!matches(row, senderId, sourceRequestId)) {
      return { action: 'blocked', reason: 'unknown_row' };
    }
    if (!isDeepStrictEqual(row.intake, intake)) {
      return { action: 'blocked', reason: 'intake_mismatch' };
    }
    const decision = classifyExpirationPostTransition({
      senderId,
      sourceRequestId,
      existing: {
        type: row.route,
        status: row.post_state,
        senderId: row.sender_id,
        sourceRequestId: row.request_key,
        backendDecisionId: row.backend_decision_id,
      },
      step: { kind: 'begin_post' },
    });
    return decision.action === 'authorize_post'
      ? { action: 'blocked', reason: 'unknown_state' }
      : decision;
  }
}
