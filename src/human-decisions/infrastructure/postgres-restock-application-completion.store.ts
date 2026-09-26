import type { Pool } from 'pg';
import { normalizeRestockApplicationAckRecord } from '../domain/restock-application-ledger-ack-record';

type Result = Readonly<{ action: 'closed' | 'replay' | 'hold' }>;
const HOLD: Result = Object.freeze({ action: 'hold' });
const MATCH = `r.route = 'RESTOCK' AND r.sender_id = $4::text
  AND r.request_key = $2::text AND r.post_state = 'RECEIPT_RECORDED'
  AND r.backend_decision_id = $1::text
  AND r.post_attempted_at IS NOT NULL AND r.receipt_recorded_at IS NOT NULL
  AND r.unknown_observed_at IS NULL
  AND r.intake ->> 'sourceRequestId' = $2::text
  AND r.intake ->> 'type' = 'RESTOCK'
  AND EXISTS (
    SELECT 1 FROM restock_application_ledger AS l
    WHERE l.decision_id = $1::uuid AND l.source_request_id = $2::uuid
      AND l.attempt_id = $3::uuid AND l.sender_id = $4::text
      AND l.branch_id = $5::text AND l.row_data = $6::jsonb
      AND l.ack_receipt = $7::jsonb
  )`;
const PROJECTION = 'r.sender_id, r.route, r.request_key, r.status';
const CLOSE = `UPDATE human_decision_reservations AS r
  SET status = 'CLOSED', updated_at = NOW()
  WHERE r.status = 'ACTIVE' AND ${MATCH}
  RETURNING ${PROJECTION}`;
const REPLAY = `SELECT ${PROJECTION} FROM human_decision_reservations AS r
  WHERE r.status = 'CLOSED' AND ${MATCH}`;

function count(
  result: unknown,
  senderId: string,
  sourceRequestId: string,
  status: string,
): 0 | 1 | null {
  if (!result || typeof result !== 'object') return null;
  const { rows, rowCount } = result as { rows?: unknown; rowCount?: unknown };
  if (
    !Array.isArray(rows) ||
    !Number.isInteger(rowCount) ||
    rowCount !== rows.length ||
    rows.length > 1
  )
    return null;
  if (rows.length === 0) return 0;
  const row: unknown = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const found = row as Record<string, unknown>;
  return found.sender_id === senderId &&
    found.route === 'RESTOCK' &&
    found.request_key === sourceRequestId &&
    found.status === status
    ? 1
    : null;
}

/** Local close after a matching durable terminal ACK; no delivery proof.
 * Snapshot CAS is not a fence against arbitrary raw-SQL writers. An uncertain
 * query outcome is HOLD, never an automatic write retry or reconciliation.
 */
export class PostgresRestockApplicationCompletionStore {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly branchId: string,
  ) {}

  async closeAcknowledged(value: unknown): Promise<Result> {
    // Validate and detach the full record synchronously before the first await.
    const record = normalizeRestockApplicationAckRecord(value);
    if (!record || record.row.branchId !== this.branchId) return HOLD;
    const { row, receipt } = record;
    const values = [
      row.decisionId,
      row.sourceRequestId,
      row.attemptId,
      row.senderId,
      row.branchId,
      JSON.stringify(row),
      JSON.stringify(receipt),
    ];
    try {
      const changed = count(
        await this.pool.query(CLOSE, values),
        row.senderId,
        row.sourceRequestId,
        'CLOSED',
      );
      if (changed === 1) return Object.freeze({ action: 'closed' });
      if (changed !== 0) return HOLD;
      const previous = count(
        await this.pool.query(REPLAY, values),
        row.senderId,
        row.sourceRequestId,
        'CLOSED',
      );
      return previous === 1 ? Object.freeze({ action: 'replay' }) : HOLD;
    } catch {
      return HOLD;
    }
  }
}
