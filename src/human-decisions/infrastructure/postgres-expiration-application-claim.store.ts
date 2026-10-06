import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import type { ExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import {
  normalizeExpirationApplicationLedgerRow,
  type ExpirationApplicationLedgerRow,
} from '../domain/expiration-application-ledger-row';
import { classifyExpirationApplication } from '../domain/expiration-application-policy';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';

type Result = Readonly<
  | {
      action: 'claimed';
      row: Extract<ExpirationApplicationLedgerRow, { state: 'SEND_STARTED' }>;
    }
  | { action: 'hold' }
>;
const HOLD = Object.freeze({ action: 'hold' as const });
const LOCK_RESERVATION =
  "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE";
const LOCK_LEDGER =
  'SELECT decision_id FROM expiration_application_ledger WHERE decision_id=$1 FOR UPDATE';

function releaseClient(client: PoolClient, poisoned?: Error): void {
  try {
    if (poisoned) client.release(poisoned);
    else client.release();
  } catch {
    throw new Error('expiration claim client release failed');
  }
}

/** Inactive local claim only, not WhatsApp send/ACK/STALE authority.
 * Trusted candidate provenance and remote resolved GET immutability remain
 * caller prerequisites. Rechecks original context and pending binding while
 * holding both row locks, then samples current time (never checkedAt).
 * Later CAS/COMMIT can still wait: this is not delivery-time eligibility.
 * Only confirmed COMMIT exposes a claim; uncertainty holds without retry.
 * ROLLBACK is cleanup, not proof an uncertain COMMIT was undone.
 * Release failure throws a bounded error, never compensation authority. */
export class PostgresExpirationApplicationClaimStore {
  constructor(
    private readonly pool: Pool,
    private readonly branchId: string,
    private readonly clock: () => Date,
    private readonly tokenFactory: () => string = randomUUID,
  ) {}

  async claimPending(
    candidate: ExpirationPreparationCandidate,
  ): Promise<Result> {
    let client: PoolClient | undefined;
    let committed = false;
    try {
      // Snapshot original authority before the first await.
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
      const { reservation, backendDecisionId } = context;
      const senderId = reservation.senderId;
      if (
        candidate.action !== 'candidate' ||
        candidateBranch !== branchId ||
        decision?.status !== 'RESOLVED'
      )
        return HOLD;
      const expected = normalizeExpirationApplicationLedgerRow({
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
      const reservationLock = await client.query<{ sender_id: string }>(
        LOCK_RESERVATION,
        [senderId],
      );
      if (
        !Array.isArray(reservationLock.rows) ||
        reservationLock.rowCount !== 1 ||
        reservationLock.rows.length !== 1 ||
        reservationLock.rows[0]?.sender_id !== senderId
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
      // The reservation lock alone does not exclude low-level ledger writers.
      const ledgerLock = await client.query<{ decision_id: string }>(
        LOCK_LEDGER,
        [decision.id],
      );
      if (
        !Array.isArray(ledgerLock.rows) ||
        ledgerLock.rowCount !== 1 ||
        ledgerLock.rows.length !== 1 ||
        ledgerLock.rows[0]?.decision_id !== decision.id
      )
        return HOLD;
      const ledger = new PostgresExpirationApplicationLedgerStore(client);
      const pending = await ledger.readByDecision(decision.id);
      if (
        pending.action !== 'foundPending' ||
        !isDeepStrictEqual(pending.row, expected)
      )
        return HOLD;
      const sendToken = this.tokenFactory();
      const now = Date.prototype.toISOString.call(this.clock());
      const policy = classifyExpirationApplication({
        senderId,
        branchId,
        reservation,
        backendDecisionId,
        decision,
        now,
      });
      if (policy.classification !== 'within_window') return HOLD;
      const transition = await ledger.transitionPending({
        row: pending.row,
        event: { kind: 'begin_send', sendToken, attemptedAt: now },
      });
      if (transition.action !== 'updated') return HOLD;
      await client.query('COMMIT');
      committed = true;
      return Object.freeze({ action: 'claimed', row: transition.row });
    } catch {
      return HOLD;
    } finally {
      if (client) {
        let poisoned: Error | undefined;
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch {
            poisoned = new Error('expiration claim rollback failed');
          }
        }
        releaseClient(client, poisoned);
      }
    }
  }
}
