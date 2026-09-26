import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { normalizeRestockDecision } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { RestockCandidateResult } from '../application/restock-application-candidate.service';
import {
  normalizeRestockApplicationLedgerRow,
  type RestockApplicationLedgerRow,
} from '../domain/restock-application-ledger-row';
import { classifyRestockApplication } from '../domain/restock-application-policy';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';

type Pending = Extract<
  RestockApplicationLedgerRow,
  { state: 'PENDING_DELIVERY' }
>;
type Result = Readonly<
  { action: 'prepared'; row: Pending } | { action: 'hold' }
>;
const HOLD = Object.freeze({ action: 'hold' as const });
const LOCK =
  "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE";

function releaseClient(client: PoolClient, poisoned?: Error): void {
  try {
    if (poisoned) client.release(poisoned);
    else client.release();
  } catch {
    throw new Error('restock preparation client release failed');
  }
}

/** Unwired preparation only, not START/send/ACK or 24h/provider/device authority.
 * Trusted validated candidate port; resolved GET immutability is assumed, not
 * remote atomicity. START must revalidate trusted inbound/channel/collision.
 * No fabricated historical receipt; T3d remains a release gate.
 * DB/clock errors hold, including COMMIT uncertainty; release failure throws
 * a bounded cleanup error.
 * Neither means rollback or authorizes retry.
 * Rollback is cleanup only; no compensating writes or deletion of intent. */
export class PostgresRestockApplicationPreparationStore {
  constructor(
    private readonly pool: Pool,
    private readonly branchId: string,
    private readonly clock: () => Date,
  ) {}

  async preparePending(
    candidate: Extract<RestockCandidateResult, { action: 'candidate' }>,
  ): Promise<Result> {
    let client: PoolClient | undefined;
    let committed = false;
    try {
      // Detach every nested authority value synchronously, before connect/lock.
      const context = {
        ...candidate.context,
        reservation: {
          ...candidate.context.reservation,
          intake: { ...candidate.context.reservation.intake },
        },
      };
      const decision = normalizeRestockDecision(candidate.decision);
      const branchId = this.branchId;
      if (
        candidate.action !== 'candidate' ||
        !context?.reservation?.intake ||
        decision?.status !== 'RESOLVED' ||
        typeof branchId !== 'string' ||
        !branchId.trim() ||
        Array.from(branchId).some((c) => {
          const n = c.charCodeAt(0);
          return n <= 31 || (n >= 127 && n <= 159);
        })
      )
        return HOLD;
      const senderId = context.reservation.senderId;
      if (
        typeof senderId !== 'string' ||
        !senderId ||
        senderId !== senderId.trim()
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
      const locked = await new PostgresRestockApplicationContextStore(
        client,
      ).readRecordedForSender(senderId);
      if (
        locked.action !== 'recorded' ||
        !isDeepStrictEqual(locked.context, context)
      )
        return HOLD;
      const now = Date.prototype.toISOString.call(this.clock());
      const { reservation, backendDecisionId } = locked.context;
      const policy = classifyRestockApplication({
        senderId,
        branchId,
        reservation,
        backendDecisionId,
        decision,
        now,
      });
      if (policy.action !== 'ready' && policy.action !== 'stale') return HOLD;
      const row = normalizeRestockApplicationLedgerRow({
        state: 'PENDING_DELIVERY',
        senderId: reservation.senderId,
        sourceRequestId: reservation.requestKey,
        branchId,
        decisionId: decision.id,
        resolutionVersion: 2,
        attemptId: policy.attemptId,
        resolvedAt: decision.resolution.resolvedAt,
        applyBefore: decision.applyBefore,
      });
      if (!row || row.state !== 'PENDING_DELIVERY') return HOLD;
      const inserted = await new PostgresRestockApplicationLedgerStore(
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
            poisoned = new Error('restock preparation rollback failed');
          }
        }
        releaseClient(client, poisoned);
      }
    }
  }
}
