import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { normalizeRestockDecision } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { RestockCandidateResult } from '../application/restock-application-candidate.service';
import {
  normalizeRestockApplicationLedgerRow,
  type RestockApplicationLedgerRow as Row,
} from '../domain/restock-application-ledger-row';
import { classifyRestockApplication } from '../domain/restock-application-policy';
import type { RestockInboundEvidence } from '../domain/restock-inbound-evidence';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';
import { PostgresRestockClaimCollisionsStore } from './postgres-restock-claim-collisions.store';
import { PostgresRestockInboundEvidenceStore } from './postgres-restock-inbound-evidence.store';

type Pending = Extract<Row, { state: 'PENDING_DELIVERY' }>;
type Success<A, S> = Readonly<{
  action: A;
  row: Extract<Row, { state: S }>;
  evidence: RestockInboundEvidence;
}>;
type Result =
  | Success<'started', 'SEND_STARTED'>
  | Success<'stale', 'STALE'>
  | Readonly<{ action: 'hold' }>;
const HOLD = Object.freeze({ action: 'hold' as const });
const LOCK =
  "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE";
function validText(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex -- reject C0/DEL/C1, preserve bytes
  const controls = /[\u0000-\u001f\u007f-\u009f]/u;
  return typeof value === 'string' && !!value.trim() && !controls.test(value);
}
function releaseClient(client: PoolClient, poisoned?: Error): void {
  try {
    if (poisoned) client.release(poisoned);
    else client.release();
  } catch {
    throw new Error('restock claim client release failed');
  }
}
/** Unwired local CAS winner only, not Meta fencing or device delivery.
 * Trusted resolved GET immutability assumed. Original ingress evidence is not
 * latest-interest/cancellation proof; locks do not exclude external old writers.
 * Fresh DB, single current bot, legacy receipt OFF/no-ops remain release gates.
 * Evidence is a frozen snapshot, NOT permission: future HTTP coordinator MUST
 * check a fresh clock/24h window again after COMMIT and before HTTP.
 * Errors/uncertain COMMIT never authorize retry; rollback is cleanup only. */
export class PostgresRestockApplicationClaimStore {
  constructor(
    private readonly pool: Pool,
    private readonly branchId: string,
    private readonly receivingPhoneNumberId: string,
    private readonly clock: () => Date,
  ) {}

  async claimPending(
    candidate: Extract<RestockCandidateResult, { action: 'candidate' }>,
    expectedPending: Pending,
    sendToken: string,
  ): Promise<Result> {
    let client: PoolClient | undefined;
    let committed = false;
    try {
      // Detach all nested authority synchronously, before the first await.
      const detached = { ...candidate.context.reservation };
      detached.intake = { ...detached.intake };
      const context = { ...candidate.context, reservation: detached };
      const decision = normalizeRestockDecision(candidate.decision);
      const expected = normalizeRestockApplicationLedgerRow(expectedPending);
      const branchId = this.branchId;
      const phone = this.receivingPhoneNumberId;
      const token = sendToken;
      const senderId = context.reservation.senderId;
      if (
        candidate.action !== 'candidate' ||
        decision?.status !== 'RESOLVED' ||
        expected?.state !== 'PENDING_DELIVERY' ||
        !validText(branchId) ||
        !validText(senderId) ||
        senderId !== senderId.trim() ||
        senderId.length > 200 ||
        typeof phone !== 'string' ||
        !/^[0-9]{1,24}$/.test(phone) ||
        typeof token !== 'string'
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
      const { reservation, backendDecisionId } = locked.context;
      const read = await new PostgresRestockInboundEvidenceStore(
        client,
      ).readBySource(reservation.requestKey);
      if (
        read.action !== 'found' ||
        read.evidence.sourceRequestId !== reservation.requestKey ||
        read.evidence.sourceRequestId !== decision.sourceRequestId ||
        read.evidence.senderId !== senderId ||
        read.evidence.receivingPhoneNumberId !== phone
      )
        return HOLD;
      const evidence = read.evidence;
      const collisions = await new PostgresRestockClaimCollisionsStore(
        client,
      ).readForSender(senderId);
      if (collisions.action !== 'clear') return HOLD;
      const now = Date.prototype.toISOString.call(this.clock());
      const nowMs = Date.parse(now);
      const providerMs = Number(evidence.providerTimestampSeconds) * 1000;
      if (
        !Number.isFinite(nowMs) ||
        providerMs > nowMs ||
        Date.parse(evidence.observedAt) > nowMs ||
        nowMs >= providerMs + 86_400_000
      )
        return HOLD;
      const policy = classifyRestockApplication({
        senderId,
        branchId,
        reservation,
        backendDecisionId,
        decision,
        now,
      });
      if (policy.action !== 'ready' && policy.action !== 'stale') return HOLD;
      const derived = normalizeRestockApplicationLedgerRow({
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
      if (!derived || !isDeepStrictEqual(derived, expected)) return HOLD;
      const changed = await new PostgresRestockApplicationLedgerStore(
        client,
      ).transitionPending({
        row: expected,
        event:
          policy.action === 'ready'
            ? { kind: 'begin_send', sendToken: token, attemptedAt: now }
            : { kind: 'expire_unsent', observedAt: now },
      });
      if (changed.action !== 'updated') return HOLD;
      const row = changed.row;
      if (row.state !== (policy.action === 'ready' ? 'SEND_STARTED' : 'STALE'))
        return HOLD;
      await client.query('COMMIT');
      committed = true;
      return row.state === 'SEND_STARTED'
        ? Object.freeze({ action: 'started', row, evidence })
        : Object.freeze({ action: 'stale', row, evidence });
    } catch {
      return HOLD;
    } finally {
      if (client) {
        let poisoned: Error | undefined;
        if (!committed) {
          try {
            await client.query('ROLLBACK');
          } catch {
            poisoned = new Error('restock claim rollback failed');
          }
        }
        releaseClient(client, poisoned);
      }
    }
  }
}
