import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import type { ExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import {
  normalizeExpirationApplicationLedgerRow as normalize,
  type ExpirationApplicationLedgerRow as Row,
} from '../domain/expiration-application-ledger-row';
import { classifyExpirationApplication } from '../domain/expiration-application-policy';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';

const COLUMNS =
  'decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data';
const CAS = `UPDATE expiration_application_ledger SET row_data = $7::jsonb
WHERE decision_id = $1 AND source_request_id = $2 AND attempt_id = $3
AND sender_id = $4 AND branch_id = $5 AND row_data = $6::jsonb
RETURNING ${COLUMNS}`;
const HOLD = Object.freeze({ action: 'hold' as const });
type Result = Readonly<
  | { action: 'recordedStale'; row: Extract<Row, { state: 'STALE' }> }
  | { action: 'hold' }
>;
function matches(
  result: QueryResult<Record<string, unknown>>,
  expected: Row,
): boolean {
  if (
    result.rowCount !== 1 ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1
  )
    return false;
  const raw = result.rows[0];
  return (
    raw?.decision_id === expected.decisionId &&
    raw.source_request_id === expected.sourceRequestId &&
    raw.attempt_id === expected.attemptId &&
    raw.sender_id === expected.senderId &&
    raw.branch_id === expected.branchId &&
    isDeepStrictEqual(normalize(raw.row_data), expected)
  );
}

function release(client: PoolClient, poisoned?: Error): void {
  try {
    if (poisoned) client.release(poisoned);
    else client.release();
  } catch {
    throw new Error('expiration stale client release failed');
  }
}

/** Inactive local expiration of an originally prepared, still-unsent row.
 * Requires trusted original candidate/remote decision provenance and every send
 * path to persist SEND_STARTED first; cannot prove out-of-band provider history.
 * Reservation then ledger locks exclude competing local claims before a fresh
 * clock sample. checkedAt is never reused. Only confirmed COMMIT yields success.
 * Failure/uncertain COMMIT holds without retry; rollback is cleanup, not proof
 * of undo. No ACK, reservation closure, runtime wiring or WhatsApp permission. */
export class PostgresExpirationApplicationStaleStore {
  constructor(
    private readonly pool: Pool,
    private readonly branchId: string,
    private readonly clock: () => Date,
  ) {}
  async expirePending(
    candidate: ExpirationPreparationCandidate,
  ): Promise<Result> {
    let client: PoolClient | undefined;
    let committed = false;
    try {
      const { branchId, ...original } = candidate.binding;
      const context = {
        ...original,
        reservation: {
          ...original.reservation,
          intake: { ...original.reservation.intake },
        },
      };
      const decision = normalizeExpirationDecision(candidate.decision);
      if (
        candidate.action !== 'candidate' ||
        branchId !== this.branchId ||
        decision?.status !== 'RESOLVED'
      )
        return HOLD;
      const { reservation, backendDecisionId } = context;
      const senderId = reservation.senderId;
      const expected = normalize({
        state: 'PENDING_DELIVERY',
        senderId,
        branchId,
        sourceRequestId: reservation.requestKey,
        decisionId: decision.id,
        resolutionVersion: 2,
        attemptId: deriveExpirationAttemptId(
          reservation.requestKey,
          decision.id,
        ),
        resolvedAt: decision.resolution.resolvedAt,
        applyBefore: decision.applyBefore,
      });
      if (!expected || expected.state !== 'PENDING_DELIVERY') return HOLD;
      client = await this.pool.connect();
      await client.query('BEGIN');
      const locked = await client.query<{ sender_id: string }>(
        "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE",
        [senderId],
      );
      if (
        locked.rowCount !== 1 ||
        !Array.isArray(locked.rows) ||
        locked.rows.length !== 1 ||
        locked.rows[0]?.sender_id !== senderId
      )
        return HOLD;
      const current = await new PostgresExpirationApplicationContextStore(
        client,
      ).readRecordedForSender(senderId);
      if (
        current.action !== 'recorded' ||
        !isDeepStrictEqual(current.context, context)
      )
        return HOLD;
      const pending = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM expiration_application_ledger WHERE decision_id=$1 FOR UPDATE`,
        [decision.id],
      );
      if (!matches(pending, expected)) return HOLD;
      const now = Date.prototype.toISOString.call(this.clock());
      const policy = classifyExpirationApplication({
        senderId,
        branchId,
        reservation,
        backendDecisionId,
        decision,
        now,
      });
      if (policy.classification !== 'expired') return HOLD;
      const next = normalize({
        ...expected,
        state: 'STALE',
        staleObservedAt: now,
      });
      if (!next || next.state !== 'STALE') return HOLD;
      const result = await client.query<Record<string, unknown>>(CAS, [
        expected.decisionId,
        expected.sourceRequestId,
        expected.attemptId,
        senderId,
        branchId,
        JSON.stringify(expected),
        JSON.stringify(next),
      ]);
      if (!matches(result, next)) return HOLD;
      await client.query('COMMIT');
      committed = true;
      return Object.freeze({ action: 'recordedStale', row: next });
    } catch {
      return HOLD;
    } finally {
      if (client) {
        let poisoned: Error | undefined;
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch {
            poisoned = new Error('expiration stale rollback failed');
          }
        }
        release(client, poisoned);
      }
    }
  }
}
