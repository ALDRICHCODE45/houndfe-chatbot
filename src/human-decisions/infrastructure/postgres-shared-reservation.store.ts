/**
 * HD-R3b2b offline Postgres adapter for SharedReservationPort: one pooled client,
 * one transaction (BEGIN → read one ACTIVE sender + legacy pending → classify →
 * `INSERT ... ON CONFLICT DO NOTHING` on the ACTIVE-sender and route+request_key
 * unique indexes → COMMIT); a zero-row insert re-reads durable rows and no winner
 * or CLOSED replay key fails closed. No release, retry, or store CAS.
 * Defensive: the RAW proposal is classified before normalization (present-null
 * omissions, explicit `undefined`, extra keys, throwing getters reject
 * pre-connection); LIMIT-1 reads require an array with an integer rowCount equal
 * to `rows.length` and <= 1; a non-ACTIVE row under an ACTIVE filter throws. Only
 * then is a frozen canonical snapshot re-classified and serialized.
 * Route-exclusivity gap: absence of a pending legacy row is NOT a CAS against a
 * pre-R3b3 legacy writer; exclusivity holds only after R3b3 routes both entries.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { normalizeRestockIntake } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  classifyReservation,
  type ActiveReservation,
  type ReservationBlockedReason,
  type ReservationDecision,
  type ReservationProposal,
  type SharedReservationPort,
} from '../domain/shared-reservation';

type Row = Record<string, unknown>;
const COLUMNS = 'route, request_key, status, sender_id, intake';
const blocked = (reason: ReservationBlockedReason): ReservationDecision => ({
  action: 'blocked',
  reason,
});

const isRow = (row: unknown): boolean =>
  typeof row === 'object' &&
  row !== null &&
  !Array.isArray(row) &&
  (Object.getPrototypeOf(row) === Object.prototype ||
    Object.getPrototypeOf(row) === null);

/** A LIMIT-1 read must be an array with an integer rowCount equal to
 * `rows.length` (and <= 1) of plain records; anything else is a driver anomaly,
 * not "absent". */
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
  if (!ok) throw new Error('inconsistent reservation read');
  return rows as Row[];
}

/** Read one proposal before any connection; null on a throwing getter, an
 * unknown route, a legacy payload, or a RESTOCK intake not bound to its id. */
function materialize(
  proposal: ReservationProposal,
): ReservationProposal | null {
  try {
    const senderId = proposal.senderId;
    const requestKey = proposal.requestKey;
    const route: string = proposal.route;
    if (route === 'RESTOCK') {
      const intake = normalizeRestockIntake(proposal.intake);
      if (intake === null || intake.sourceRequestId !== requestKey) return null;
      return Object.freeze({
        senderId,
        route: 'RESTOCK' as const,
        requestKey,
        intake: Object.freeze(intake),
      });
    }
    if (route !== 'LEGACY_OPS' || proposal.intake !== null) return null;
    return Object.freeze({
      senderId,
      route: 'LEGACY_OPS' as const,
      requestKey,
      intake: null,
    });
  } catch {
    return null;
  }
}

/** A row read under an ACTIVE filter that is not ACTIVE is a driver anomaly;
 * never overwrite the status. */
function toActive(row: Row): ActiveReservation {
  if (row.status !== 'ACTIVE') {
    throw new Error('inconsistent reservation read');
  }
  return {
    status: 'ACTIVE',
    route: row.route as ActiveReservation['route'],
    senderId: row.sender_id as string,
    requestKey: row.request_key as string,
    intake: row.intake as ActiveReservation['intake'],
  };
}

const readOne = async (
  client: PoolClient,
  where: string,
  params: unknown[],
): Promise<Row | null> => {
  const result = await client.query<Row>(
    `SELECT ${COLUMNS} FROM human_decision_reservations WHERE ${where} LIMIT 1`,
    params,
  );
  const rows = singleRow(result);
  return rows.length === 0 ? null : rows[0];
};
async function readActive(
  client: PoolClient,
  senderId: string,
): Promise<ActiveReservation | 'absent'> {
  const row = await readOne(client, "sender_id = $1 AND status = 'ACTIVE'", [
    senderId,
  ]);
  return row === null ? 'absent' : toActive(row);
}
async function readLegacyPending(
  client: PoolClient,
  senderId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM human_handoff_requests
     WHERE customer_id = $1 AND status = 'pending' LIMIT 1`,
    [senderId],
  );
  return singleRow(result).length > 0;
}

function reclassify(
  existing: ActiveReservation,
  proposal: ReservationProposal,
  pending: boolean,
): ReservationDecision {
  const decision = classifyReservation({
    proposal,
    existing,
    legacyMarkerPresent: pending,
  });
  return decision.action === 'claim' ? blocked('unknown_existing') : decision;
}
const isClaim = (proposal: ReservationProposal): boolean =>
  classifyReservation({
    proposal,
    existing: 'absent',
    legacyMarkerPresent: false,
  }).action === 'claim';

async function arbitrate(
  client: PoolClient,
  proposal: ReservationProposal,
  pending: boolean,
): Promise<ReservationDecision> {
  const keyRow = await readOne(client, 'route = $1 AND request_key = $2', [
    proposal.route,
    proposal.requestKey,
  ]);
  if (keyRow !== null) {
    if (keyRow.status !== 'ACTIVE') return blocked('unknown_existing');
    if (keyRow.sender_id !== proposal.senderId) {
      return blocked('sender_mismatch');
    }
    return reclassify(toActive(keyRow), proposal, pending);
  }
  const active = await readActive(client, proposal.senderId);
  return active === 'absent'
    ? blocked('unknown_existing')
    : reclassify(active, proposal, pending);
}

@Injectable()
export class PostgresSharedReservationStore implements SharedReservationPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async reserve(proposal: ReservationProposal): Promise<ReservationDecision> {
    if (!isClaim(proposal)) return blocked('malformed_proposal');
    const canonical = materialize(proposal);
    if (canonical === null || !isClaim(canonical)) {
      return blocked('malformed_proposal');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const active = await readActive(client, canonical.senderId);
      const pending = await readLegacyPending(client, canonical.senderId);
      const decision = classifyReservation({
        proposal: canonical,
        existing: active,
        legacyMarkerPresent: pending,
      });
      if (decision.action !== 'claim') {
        await client.query('ROLLBACK');
        return decision;
      }
      const inserted = await client.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake)
         VALUES ($1, $2, $3, 'ACTIVE', $4::jsonb)
         ON CONFLICT DO NOTHING RETURNING status`,
        [
          canonical.senderId,
          canonical.route,
          canonical.requestKey,
          canonical.intake === null ? null : JSON.stringify(canonical.intake),
        ],
      );
      if (inserted.rowCount === 1) {
        await client.query('COMMIT');
        return { action: 'claim', reason: 'single_sender_vacant' };
      }
      const arbitration = await arbitrate(client, canonical, pending);
      await client.query('ROLLBACK');
      return arbitration;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
