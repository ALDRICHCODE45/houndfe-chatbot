import type { Pool } from 'pg';
import { normalizeExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import type {
  ExpirationApplicationInsert,
  ExpirationApplicationPendingRow,
  ExpirationApplicationRead,
} from '../domain/expiration-application-ledger.port';

const COLUMNS =
  'decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data';
const READ = `SELECT ${COLUMNS} FROM expiration_application_ledger WHERE decision_id = $1`;
/** Conflict-safe local insert only: an existing row is never updated or
 * overwritten, and an empty RETURNING triggers at most one conflict read. */
const INSERT = `INSERT INTO expiration_application_ledger (${COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`;
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

/** Unwired local read/insert only. One parameterized SELECT plus one
 * conflict-safe INSERT and, at most, one conflict read; a corrupt stored row
 * holds while inconsistent driver results throw. No branch/sender authorization,
 * reservation, provenance or send/ACK/closure authority is claimed, and no
 * error implies a rollback or retry (the write may already have committed). */
export class PostgresExpirationApplicationLedgerStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

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
