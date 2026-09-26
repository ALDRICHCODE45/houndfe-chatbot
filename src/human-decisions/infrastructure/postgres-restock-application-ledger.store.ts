import type { Pool } from 'pg';
import { classifyRestockApplicationAcceptance } from '../domain/restock-application-ledger-acceptance';
import { classifyRestockApplicationStart } from '../domain/restock-application-ledger-start';
import type { RestockApplicationOutcomeAck } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  classifyRestockApplicationAckRecord,
  normalizeRestockApplicationAckRecord,
  type RestockApplicationAckRecord,
} from '../domain/restock-application-ledger-ack-record';
import {
  normalizeRestockApplicationLedgerRow,
  type RestockApplicationLedgerRow,
} from '../domain/restock-application-ledger-row';
import type {
  RestockApplicationAckResult,
  RestockApplicationAcceptanceInput,
  RestockApplicationAcceptanceResult,
  RestockApplicationInsert,
  RestockApplicationLedgerPort,
  RestockApplicationRead,
  RestockApplicationPendingTransition,
  RestockApplicationTransition,
} from '../domain/restock-application-ledger.port';

type Pending = Extract<
  RestockApplicationLedgerRow,
  { state: 'PENDING_DELIVERY' }
>;
const COLUMNS =
  'decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data, ack_receipt';
const READ = `SELECT ${COLUMNS} FROM restock_application_ledger WHERE decision_id = $1`;
const INSERT = `INSERT INTO restock_application_ledger (${COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL)
ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`;
const TRANSITION = `UPDATE restock_application_ledger SET row_data = $7::jsonb
WHERE decision_id = $1::uuid AND source_request_id = $2::uuid
AND attempt_id = $3::uuid AND sender_id = $4 AND branch_id = $5
AND row_data = $6::jsonb AND ack_receipt IS NULL RETURNING ${COLUMNS}`;
const RECORD_ACK = `UPDATE restock_application_ledger SET ack_receipt = $7::jsonb
WHERE decision_id = $1::uuid AND source_request_id = $2::uuid
AND attempt_id = $3::uuid AND sender_id = $4 AND branch_id = $5
AND row_data = $6::jsonb AND ack_receipt IS NULL RETURNING ${COLUMNS}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
function decode(raw: Projection, decisionId: string): RestockApplicationRead {
  const row = normalizeRestockApplicationLedgerRow(raw.row_data);
  if (
    !row ||
    !Object.hasOwn(raw, 'ack_receipt') ||
    !UUID.test(decisionId) ||
    !(
      [
        ['decision_id', row.decisionId],
        ['source_request_id', row.sourceRequestId],
        ['attempt_id', row.attemptId],
      ] as const
    ).every(
      ([column, value]) =>
        typeof raw[column] === 'string' &&
        UUID.test(raw[column]) &&
        raw[column].toLowerCase() === value.toLowerCase(),
    ) ||
    row.decisionId.toLowerCase() !== decisionId.toLowerCase() ||
    raw.sender_id !== row.senderId ||
    raw.branch_id !== row.branchId
  )
    return HOLD;
  if (raw.ack_receipt === null)
    return Object.freeze({ action: 'found', row, ack: null });
  const record = normalizeRestockApplicationAckRecord({
    row,
    receipt: raw.ack_receipt,
  });
  return record
    ? Object.freeze({ action: 'found', row: record.row, ack: record.receipt })
    : HOLD;
}
function same(
  left: RestockApplicationLedgerRow,
  right: RestockApplicationLedgerRow,
): boolean {
  const keys = Object.keys(left) as Array<keyof RestockApplicationLedgerRow>;
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** Unwired local persistence only; no reservation transaction/authority claim. */
export class PostgresRestockApplicationLedgerStore implements RestockApplicationLedgerPort {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async readByDecision(decisionId: string): Promise<RestockApplicationRead> {
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) return HOLD;
    const raw = single(await this.pool.query(READ, [decisionId]));
    return raw === null
      ? Object.freeze({ action: 'missing' })
      : decode(raw, decisionId);
  }

  async recordOutcomeAck(
    row: RestockApplicationAckRecord['row'],
    receipt: RestockApplicationOutcomeAck,
  ): Promise<RestockApplicationAckResult> {
    const proposal = classifyRestockApplicationAckRecord(row, receipt, null);
    if (proposal.action !== 'record') return HOLD;
    const { row: expected, receipt: expectedReceipt } = proposal.next;
    const raw = single(
      await this.pool.query(RECORD_ACK, [
        expected.decisionId,
        expected.sourceRequestId,
        expected.attemptId,
        expected.senderId,
        expected.branchId,
        JSON.stringify(expected),
        JSON.stringify(expectedReceipt),
      ]),
    );
    const found =
      raw === null
        ? await this.readByDecision(expected.decisionId)
        : decode(raw, expected.decisionId);
    if (found.action !== 'found' || found.ack === null) return HOLD;
    const verified = classifyRestockApplicationAckRecord(
      expected,
      expectedReceipt,
      { row: found.row, receipt: found.ack },
    );
    return verified.action === 'replay'
      ? Object.freeze({
          action: raw === null ? 'replay' : 'recorded',
          record: verified.record,
        })
      : HOLD;
  }

  async recordAcceptance(
    input: RestockApplicationAcceptanceInput,
  ): Promise<RestockApplicationAcceptanceResult> {
    const proposal = classifyRestockApplicationAcceptance(input);
    if (proposal.action === 'hold') return HOLD;
    const replay = proposal.action === 'replay';
    const next = proposal.action === 'replay' ? proposal.row : proposal.next;
    let found: RestockApplicationRead;
    if (proposal.action === 'replay') {
      found = await this.readByDecision(next.decisionId);
    } else {
      const { expected } = proposal;
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
      found = decode(raw, expected.decisionId);
    }
    return found.action === 'found' &&
      (replay || found.ack === null) &&
      (found.row.state === 'PROVIDER_ACCEPTED' ||
        found.row.state === 'PROVIDER_ACCEPTED_LATE') &&
      same(found.row, next)
      ? Object.freeze({ action: replay ? 'replay' : 'updated', row: found.row })
      : HOLD;
  }

  async transitionPending(
    input: RestockApplicationPendingTransition,
  ): Promise<RestockApplicationTransition> {
    const proposal = classifyRestockApplicationStart(input);
    if (proposal.action === 'hold') return HOLD;
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
    const found = decode(raw, expected.decisionId);
    return found.action === 'found' &&
      found.ack === null &&
      (found.row.state === 'SEND_STARTED' || found.row.state === 'STALE') &&
      same(found.row, next)
      ? Object.freeze({ action: 'updated', row: found.row })
      : HOLD;
  }

  async insertPending(input: Pending): Promise<RestockApplicationInsert> {
    const row = normalizeRestockApplicationLedgerRow(input);
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
      return found.action === 'found' &&
        found.ack === null &&
        found.row.state === 'PENDING_DELIVERY' &&
        same(found.row, row)
        ? Object.freeze({ action: 'inserted', row: found.row })
        : HOLD;
    }
    const found = await this.readByDecision(row.decisionId);
    return found.action === 'found' &&
      found.ack === null &&
      found.row.state === 'PENDING_DELIVERY' &&
      same(found.row, row)
      ? Object.freeze({ action: 'replay', row: found.row })
      : HOLD;
  }
}
