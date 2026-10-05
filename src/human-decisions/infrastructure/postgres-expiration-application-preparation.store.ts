import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import type { ExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import type { ExpirationApplicationPendingRow } from '../domain/expiration-application-ledger.port';
import { normalizeExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import { classifyExpirationApplication } from '../domain/expiration-application-policy';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';

type Result = Readonly<
  | { action: 'prepared'; row: ExpirationApplicationPendingRow }
  | { action: 'hold' }
>;
const HOLD = Object.freeze({ action: 'hold' as const });
const LOCK =
  "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE";

function releaseClient(client: PoolClient, poisoned?: Error): void {
  try {
    if (poisoned) client.release(poisoned);
    else client.release();
  } catch {
    throw new Error('expiration preparation client release failed');
  }
}

/** Inactive trusted-candidate adapter, not START/send/ACK/STALE authority.
 * Locks local original context only; remote resolved GET immutability remains
 * an assumption. checkedAt is not transaction freshness. Expired observations
 * leave even existing pending rows untouched. Errors hold without retry;
 * COMMIT uncertainty does not prove rollback. ROLLBACK is cleanup only.
 * A release failure throws a bounded error, never compensation authority. */
export class PostgresExpirationApplicationPreparationStore {
  constructor(
    private readonly pool: Pool,
    private readonly branchId: string,
    private readonly clock: () => Date,
  ) {}

  async preparePending(
    candidate: ExpirationPreparationCandidate,
  ): Promise<Result> {
    let client: PoolClient | undefined;
    let committed = false;
    try {
      // Detach every authority value before connect can yield to caller mutation.
      const { branchId: candidateBranch, ...original } = candidate.binding;
      const context = {
        ...original,
        reservation: {
          ...original.reservation,
          intake: { ...original.reservation.intake },
        },
      };
      const branchId = this.branchId;
      const decision = normalizeExpirationDecision(candidate.decision);
      const senderId = context.reservation.senderId;
      if (
        candidate.action !== 'candidate' ||
        candidateBranch !== branchId ||
        typeof branchId !== 'string' ||
        !branchId.trim() ||
        typeof senderId !== 'string' ||
        !senderId ||
        senderId !== senderId.trim() ||
        decision?.status !== 'RESOLVED'
      )
        return HOLD;
      client = await this.pool.connect();
      await client.query('BEGIN');
      const lock = await client.query<{ sender_id: string }>(LOCK, [senderId]);
      if (
        !Array.isArray(lock.rows) ||
        lock.rowCount !== 1 ||
        lock.rows.length !== 1 ||
        lock.rows[0]?.sender_id !== senderId
      )
        return HOLD;
      const locked = await new PostgresExpirationApplicationContextStore(
        client,
      ).readRecordedForSender(senderId);
      if (
        locked.action !== 'recorded' ||
        !isDeepStrictEqual(locked.context, context)
      )
        return HOLD;
      const now = Date.prototype.toISOString.call(this.clock());
      const { reservation, backendDecisionId } = locked.context;
      const policy = classifyExpirationApplication({
        senderId,
        branchId,
        reservation,
        backendDecisionId,
        decision,
        now,
      });
      if (policy.classification !== 'within_window') return HOLD;
      const row = normalizeExpirationApplicationLedgerRow({
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
      if (!row || row.state !== 'PENDING_DELIVERY') return HOLD;
      const inserted = await new PostgresExpirationApplicationLedgerStore(
        client,
      ).insertPending(row);
      if (inserted.action === 'hold') return HOLD;
      await client.query('COMMIT');
      committed = true;
      return Object.freeze({ action: 'prepared', row: inserted.row });
    } catch {
      return HOLD;
    } finally {
      if (client) {
        let poisoned: Error | undefined;
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch {
            poisoned = new Error('expiration preparation rollback failed');
          }
        }
        releaseClient(client, poisoned);
      }
    }
  }
}
