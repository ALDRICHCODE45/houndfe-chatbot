import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { classifyExpirationApplicationStart } from '../domain/expiration-application-ledger-start';
import { classifyExpirationApplicationAcceptance } from '../domain/expiration-application-ledger-acceptance';
import { normalizeExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import { bindExpirationApplicationOutcomeAck } from '../domain/expiration-application-ledger-ack-binding';
import type {
  ExpirationApplicationAckWrite,
  ExpirationApplicationAcceptance,
  ExpirationApplicationInsert,
  ExpirationApplicationOutcomeRead,
  ExpirationApplicationPendingRow,
  ExpirationApplicationRead,
  ExpirationApplicationTransition,
} from '../domain/expiration-application-ledger.port';

const COLUMNS =
  'decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data';
const READ = `SELECT ${COLUMNS} FROM expiration_application_ledger WHERE decision_id = $1`;
// The boolean separates SQL NULL (absent) from JSON null (corrupt evidence).
const READ_OUTCOME = `SELECT ${COLUMNS}, ack_receipt, ack_receipt IS NULL AS ack_absent FROM expiration_application_ledger WHERE decision_id = $1`;
/** Conflict-safe local insert only: an existing row is never updated or
 * overwritten, and an empty RETURNING triggers at most one conflict read. */
const INSERT = `INSERT INTO expiration_application_ledger (${COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`;
/** Full JSONB equality includes the expected state; no replay can win twice. */
const TRANSITION = `UPDATE expiration_application_ledger SET row_data = $7::jsonb
WHERE decision_id = $1 AND source_request_id = $2 AND attempt_id = $3
AND sender_id = $4 AND branch_id = $5 AND row_data = $6::jsonb
RETURNING ${COLUMNS}`;
/** ACK-only CAS: never overwrite evidence or change the terminal snapshot. */
const RECORD_ACK = `UPDATE expiration_application_ledger SET ack_receipt = $7::jsonb
WHERE decision_id = $1 AND source_request_id = $2 AND attempt_id = $3
AND sender_id = $4 AND branch_id = $5 AND row_data = $6::jsonb
AND ack_receipt IS NULL
RETURNING ${COLUMNS}, ack_receipt`;
/** Canonical lowercase RFC 4122 v1-v8 UUID; no case-folding, trimming or coercion. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOLD = Object.freeze({ action: 'hold' as const });

type Projection = Record<string, unknown>;
function single(result: unknown): Projection | null {
  if (typeof result !== 'object' || result === null)
    throw new Error('invalid ledger result');
  const { rows, rowCount } = result as { rows?: unknown; rowCount?: unknown };
  if (
    !Array.isArray(rows) ||
    !Number.isInteger(rowCount) ||
    rowCount !== rows.length ||
    rows.length > 1
  )
    throw new Error('inconsistent ledger result');
  if (!rows.length) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null || Array.isArray(row))
    throw new Error('invalid ledger projection');
  return row as Projection;
}
/** Column/JSON equality is exact and lowercase-canonical, unlike RESTOCK. The
 * normalizer has already detached and frozen a canonical pending row. */
function decode(
  raw: Projection,
  decisionId: string,
): ExpirationApplicationRead {
  const row = normalizeExpirationApplicationLedgerRow(raw.row_data);
  if (
    !row ||
    row.state !== 'PENDING_DELIVERY' ||
    row.decisionId !== decisionId ||
    raw.decision_id !== row.decisionId ||
    raw.source_request_id !== row.sourceRequestId ||
    raw.attempt_id !== row.attemptId ||
    raw.sender_id !== row.senderId ||
    raw.branch_id !== row.branchId
  )
    return HOLD;
  return Object.freeze({ action: 'foundPending', row });
}
/** Exact canonical row equality by key, never JSON.stringify: PG JSONB does not
 * preserve key order, so serialized bytes are not row identity. */
function same(
  left: ExpirationApplicationPendingRow,
  right: ExpirationApplicationPendingRow,
): boolean {
  const keys = Object.keys(left) as Array<
    keyof ExpirationApplicationPendingRow
  >;
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** Unwired pending/outcome reads, insert, begin-send, acceptance and ACK CAS. One SELECT,
 * conflict-safe INSERT with at most one conflict read, or one exact-row UPDATE.
 * Corrupt stored rows hold while inconsistent driver results throw.
 * CAS does not own an outer transaction or revalidate reservation/current time.
 * No branch/sender authorization,
 * reservation, provenance or send/ACK/closure authority is claimed, and no
 * error implies a rollback or retry (the write may already have committed). */
export class PostgresExpirationApplicationLedgerStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async readOutcomeByDecision(
    decisionId: string,
  ): Promise<ExpirationApplicationOutcomeRead> {
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) return HOLD;
    const raw = single(await this.pool.query(READ_OUTCOME, [decisionId]));
    if (raw === null) return Object.freeze({ action: 'missing' });
    const row = normalizeExpirationApplicationLedgerRow(raw.row_data);
    if (
      !row ||
      (row.state !== 'PROVIDER_ACCEPTED' &&
        row.state !== 'PROVIDER_ACCEPTED_LATE' &&
        row.state !== 'STALE') ||
      row.decisionId !== decisionId ||
      raw.decision_id !== row.decisionId ||
      raw.source_request_id !== row.sourceRequestId ||
      raw.attempt_id !== row.attemptId ||
      raw.sender_id !== row.senderId ||
      raw.branch_id !== row.branchId
    )
      return HOLD;
    if (raw.ack_absent === true && raw.ack_receipt === null)
      return Object.freeze({ action: 'foundOutcome', row, receipt: null });
    if (raw.ack_absent !== false) return HOLD;
    const binding = bindExpirationApplicationOutcomeAck(row, raw.ack_receipt);
    if (binding.action !== 'bound') return HOLD;
    return Object.freeze({
      action: 'foundOutcome',
      row: binding.expected,
      receipt: binding.receipt,
    });
  }

  async recordOutcomeAck(
    row: unknown,
    receipt: unknown,
  ): Promise<ExpirationApplicationAckWrite> {
    const binding = bindExpirationApplicationOutcomeAck(row, receipt);
    if (binding.action !== 'bound') return HOLD;
    const expected = binding.expected;
    const raw = single(
      await this.pool.query(RECORD_ACK, [
        expected.decisionId,
        expected.sourceRequestId,
        expected.attemptId,
        expected.senderId,
        expected.branchId,
        JSON.stringify(expected),
        JSON.stringify(binding.receipt),
      ]),
    );
    if (raw === null) return HOLD;
    const recorded = bindExpirationApplicationOutcomeAck(
      raw.row_data,
      raw.ack_receipt,
    );
    if (
      recorded.action !== 'bound' ||
      raw.decision_id !== expected.decisionId ||
      raw.source_request_id !== expected.sourceRequestId ||
      raw.attempt_id !== expected.attemptId ||
      raw.sender_id !== expected.senderId ||
      raw.branch_id !== expected.branchId ||
      !isDeepStrictEqual(recorded.expected, expected) ||
      !isDeepStrictEqual(recorded.receipt, binding.receipt)
    )
      return HOLD;
    // A matching RETURNING proves this CAS only, not the caller's COMMIT.
    return Object.freeze({
      action: 'updated',
      row: recorded.expected,
      receipt: recorded.receipt,
    });
  }

  async recordAcceptance(
    input: unknown,
  ): Promise<ExpirationApplicationAcceptance> {
    const proposal = classifyExpirationApplicationAcceptance(input);
    if (proposal.action !== 'propose_cas') return HOLD;
    const { expected, next } = proposal;
    const raw = single(
      await this.pool.query(TRANSITION, [
        expected.decisionId,
        expected.sourceRequestId,
        expected.attemptId,
        expected.senderId,
        expected.branchId,
        JSON.stringify(expected),
        JSON.stringify(next),
      ]),
    );
    if (raw === null) return HOLD;
    // Acceptance is returned only by this successful exact CAS. The existing
    // pending-only read/insert decoder must never turn it into replay authority.
    const row = normalizeExpirationApplicationLedgerRow(raw.row_data);
    if (
      !row ||
      (row.state !== 'PROVIDER_ACCEPTED' &&
        row.state !== 'PROVIDER_ACCEPTED_LATE') ||
      raw.decision_id !== row.decisionId ||
      raw.source_request_id !== row.sourceRequestId ||
      raw.attempt_id !== row.attemptId ||
      raw.sender_id !== row.senderId ||
      raw.branch_id !== row.branchId ||
      !isDeepStrictEqual(row, next)
    )
      return HOLD;
    return Object.freeze({ action: 'updated', row });
  }

  async transitionPending(
    input: unknown,
  ): Promise<ExpirationApplicationTransition> {
    const proposal = classifyExpirationApplicationStart(input);
    if (proposal.action !== 'propose_cas') return HOLD;
    const { expected, next } = proposal;
    const raw = single(
      await this.pool.query(TRANSITION, [
        expected.decisionId,
        expected.sourceRequestId,
        expected.attemptId,
        expected.senderId,
        expected.branchId,
        JSON.stringify(expected),
        JSON.stringify(next),
      ]),
    );
    if (raw === null) return HOLD;
    // Keep pending-only decode unchanged: a started observation is returned
    // exclusively by this successful CAS, never by read/insert replay.
    const row = normalizeExpirationApplicationLedgerRow(raw.row_data);
    if (
      !row ||
      row.state !== 'SEND_STARTED' ||
      raw.decision_id !== row.decisionId ||
      raw.source_request_id !== row.sourceRequestId ||
      raw.attempt_id !== row.attemptId ||
      raw.sender_id !== row.senderId ||
      raw.branch_id !== row.branchId ||
      !isDeepStrictEqual(row, next)
    )
      return HOLD;
    return Object.freeze({ action: 'updated', row });
  }

  async readByDecision(decisionId: string): Promise<ExpirationApplicationRead> {
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) return HOLD;
    const raw = single(await this.pool.query(READ, [decisionId]));
    return raw === null
      ? Object.freeze({ action: 'missing' })
      : decode(raw, decisionId);
  }

  async insertPending(
    input: ExpirationApplicationPendingRow,
  ): Promise<ExpirationApplicationInsert> {
    const row = normalizeExpirationApplicationLedgerRow(input);
    if (!row || row.state !== 'PENDING_DELIVERY') return HOLD;
    const raw = single(
      await this.pool.query(INSERT, [
        row.decisionId,
        row.sourceRequestId,
        row.attemptId,
        row.senderId,
        row.branchId,
        JSON.stringify(row),
      ]),
    );
    if (raw !== null) {
      const found = decode(raw, row.decisionId);
      return found.action === 'foundPending' && same(found.row, row)
        ? Object.freeze({ action: 'inserted', row: found.row })
        : HOLD;
    }
    const found = await this.readByDecision(row.decisionId);
    return found.action === 'foundPending' && same(found.row, row)
      ? Object.freeze({ action: 'replay', row: found.row })
      : HOLD;
  }
}
