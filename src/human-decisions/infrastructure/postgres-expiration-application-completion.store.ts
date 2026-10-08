import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  validateExpirationOutcomeContext,
  type ExpirationOutcomeContext,
} from '../application/expiration-outcome-context';
import { prepareExpirationApplicationCompletion } from '../domain/expiration-application-completion-preparation';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';

type Result = Readonly<{ action: 'closed' | 'hold' }>;
const HOLD: Result = Object.freeze({ action: 'hold' });
const CLOSE = `UPDATE human_decision_reservations SET status = 'CLOSED', updated_at = NOW()
WHERE sender_id = $1 AND request_key = $2 AND backend_decision_id = $3
AND route = 'EXPIRATION' AND status = 'ACTIVE' AND post_state = 'RECEIPT_RECORDED'
AND intake = $4::jsonb AND unknown_observed_at IS NULL
RETURNING sender_id, route, request_key, status, backend_decision_id`;
function exact(result: QueryResult, expected: Record<string, string>): boolean {
  return (
    result.rowCount === 1 &&
    Array.isArray(result.rows) &&
    result.rows.length === 1 &&
    isDeepStrictEqual(result.rows[0], expected)
  );
}

function release(client: PoolClient, poisoned?: Error): void {
  try {
    if (poisoned) client.release(poisoned);
    else client.release();
  } catch {
    throw new Error('expiration completion client release failed');
  }
}

/** Inactive local closure; requires the trusted original candidate and ACK
 * provenance. STALE still requires no out-of-band send history. Rechecking
 * checkedAt binds the historical candidate, not current send eligibility.
 * Lock reservation then ledger, and compare full context and durable row/ACK.
 * Only confirmed COMMIT yields closed; uncertainty holds without retry/replay.
 * ROLLBACK is cleanup, not proof of undo. No ledger mutation, HTTP or runtime
 * wiring. A release failure may reject after COMMIT without compensation. */
export class PostgresExpirationApplicationCompletionStore {
  constructor(
    private readonly pool: Pool,
    private readonly branchId: string,
  ) {}

  async closeAcknowledged(
    candidate: ExpirationOutcomeContext,
    row: unknown,
    receipt: unknown,
  ): Promise<Result> {
    let client: PoolClient | undefined;
    let committed = false;
    try {
      const original = validateExpirationOutcomeContext(candidate, row);
      const prepared = prepareExpirationApplicationCompletion(row, receipt);
      if (!('binding' in original) || prepared.action !== 'prepared')
        return HOLD;
      const { branchId, ...context } = original.binding;
      const { reservation } = context;
      const { expected, receipt: ack } = prepared;
      if (
        branchId !== this.branchId ||
        expected.branchId !== branchId ||
        expected.senderId !== reservation.senderId ||
        expected.sourceRequestId !== reservation.requestKey ||
        expected.decisionId !== original.decision.id ||
        expected.resolvedAt !== original.decision.resolution.resolvedAt ||
        expected.applyBefore !== original.decision.applyBefore
      )
        return HOLD;
      client = await this.pool.connect();
      await client.query('BEGIN');
      const locked = await client.query(
        "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE",
        [expected.senderId],
      );
      if (!exact(locked, { sender_id: expected.senderId })) return HOLD;
      const current = await new PostgresExpirationApplicationContextStore(
        client,
      ).readRecordedForSender(expected.senderId);
      if (
        current.action !== 'recorded' ||
        !isDeepStrictEqual(current.context, context)
      )
        return HOLD;
      const ledger = await client.query(
        'SELECT decision_id FROM expiration_application_ledger WHERE decision_id=$1 FOR UPDATE',
        [expected.decisionId],
      );
      if (!exact(ledger, { decision_id: expected.decisionId })) return HOLD;
      const found = await new PostgresExpirationApplicationLedgerStore(
        client,
      ).readOutcomeByDecision(expected.decisionId);
      if (
        found.action !== 'foundOutcome' ||
        !isDeepStrictEqual(found.row, expected) ||
        !isDeepStrictEqual(found.receipt, ack)
      )
        return HOLD;
      const changed = await client.query(CLOSE, [
        expected.senderId,
        expected.sourceRequestId,
        expected.decisionId,
        JSON.stringify(reservation.intake),
      ]);
      if (
        !exact(changed, {
          sender_id: expected.senderId,
          route: 'EXPIRATION',
          request_key: expected.sourceRequestId,
          status: 'CLOSED',
          backend_decision_id: expected.decisionId,
        })
      )
        return HOLD;
      await client.query('COMMIT');
      committed = true;
      return Object.freeze({ action: 'closed' });
    } catch {
      return HOLD;
    } finally {
      if (client) {
        let poisoned: Error | undefined;
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch {
            poisoned = new Error('expiration completion rollback failed');
          }
        }
        release(client, poisoned);
      }
    }
  }
}
