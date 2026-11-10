import type { Pool, PoolClient } from 'pg';
import {
  assertEnqueueInput,
  truncateError,
  type BackendOutboxEnqueueInput,
  type BackendOutboxEnqueueResult,
  type BackendOutboxEntry,
  type BackendOutboxKind,
  type BackendOutboxStatus,
  type BackendOutboxStore,
  type ClaimedBackendOutboxEntry,
} from '../domain/backend-outbox';

interface Row {
  id: string;
  conversation_ref: string;
  seq: string;
  kind: BackendOutboxKind;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: BackendOutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  done_at: Date | null;
}

const SELECT_BY_KEY_SQL = `SELECT * FROM backend_outbox WHERE idempotency_key = $1`;

/** The counter row lock is held until the enqueue transaction commits, so
 * commit order equals seq order within a conversation. */
const NEXT_SEQ_SQL = `INSERT INTO backend_outbox_sequences (conversation_ref, next_seq)
VALUES ($1, 2)
ON CONFLICT (conversation_ref) DO UPDATE
  SET next_seq = backend_outbox_sequences.next_seq + 1
RETURNING next_seq - 1 AS seq`;

const INSERT_SQL = `INSERT INTO backend_outbox
  (conversation_ref, seq, kind, idempotency_key, payload)
VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING *`;

/** Strict head-of-line claim: per conversation only the lowest open seq is
 * a candidate. A head another worker holds is skipped (SKIP LOCKED) and the
 * row-level predicates are re-checked after locking, so a committed claim
 * or completion by another worker is never double-claimed and seq N+1 is
 * never picked while seq N is open. The lease is truncated to ms so the
 * JS Date fencing token compares exactly. */
const CLAIM_SQL = `WITH heads AS (
  SELECT DISTINCT ON (conversation_ref) id
  FROM backend_outbox
  WHERE status IN ('PENDING', 'IN_FLIGHT')
  ORDER BY conversation_ref, seq
), due AS (
  SELECT o.id FROM backend_outbox o
  JOIN heads h ON h.id = o.id
  WHERE (o.status = 'PENDING' AND o.next_attempt_at <= now())
     OR (o.status = 'IN_FLIGHT' AND o.lease_expires_at <= now())
  ORDER BY o.next_attempt_at, o.id
  LIMIT $1
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE backend_outbox o
SET status = 'IN_FLIGHT', lease_owner = $2,
  lease_expires_at = date_trunc('milliseconds', now())
    + make_interval(secs => $3::double precision / 1000.0)
FROM due WHERE o.id = due.id
RETURNING o.*`;

const FENCE = `WHERE id = $1 AND status = 'IN_FLIGHT' AND lease_owner = $2
  AND lease_expires_at = $3::timestamptz`;

const MARK_DONE_SQL = `UPDATE backend_outbox
SET status = 'DONE', done_at = now(), attempts = attempts + 1,
  lease_owner = NULL, lease_expires_at = NULL
${FENCE}`;

const RESCHEDULE_SQL = `UPDATE backend_outbox
SET status = 'PENDING', attempts = attempts + 1, last_error = $5,
  next_attempt_at = now() + make_interval(secs => $4::double precision / 1000.0),
  lease_owner = NULL, lease_expires_at = NULL
${FENCE}`;

const MARK_DEAD_SQL = `UPDATE backend_outbox
SET status = 'DEAD', attempts = attempts + 1, last_error = $4,
  lease_owner = NULL, lease_expires_at = NULL
${FENCE}`;

const PURGE_SQL = `DELETE FROM backend_outbox WHERE id IN (
  SELECT id FROM backend_outbox
  WHERE status = 'DONE'
    AND done_at < now() - make_interval(secs => $1::double precision / 1000.0)
  ORDER BY done_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED)`;

const toEntry = (row: Row): BackendOutboxEntry => ({
  id: String(row.id),
  conversationRef: row.conversation_ref,
  seq: Number(row.seq),
  kind: row.kind,
  idempotencyKey: row.idempotency_key,
  payload: row.payload,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  doneAt: row.done_at,
});

const boundedMs = (ms: number): number =>
  Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;

export class PostgresBackendOutboxStore implements BackendOutboxStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(
    input: BackendOutboxEnqueueInput,
    client?: PoolClient,
  ): Promise<BackendOutboxEnqueueResult> {
    assertEnqueueInput(input);
    if (client) return this.enqueueWith(client, input);
    return this.withTx((c) => this.enqueueWith(c, input));
  }

  async claimHeads(
    limit: number,
    owner: string,
    leaseMs: number,
  ): Promise<ClaimedBackendOutboxEntry[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      owner.length === 0 ||
      owner.length > 100
    )
      return [];
    const { rows } = await this.pool.query<Row>(CLAIM_SQL, [
      limit,
      owner,
      boundedMs(leaseMs),
    ]);
    return rows.map((row) => toEntry(row) as ClaimedBackendOutboxEntry);
  }

  async markDone(entry: ClaimedBackendOutboxEntry): Promise<boolean> {
    return this.fenced(MARK_DONE_SQL, entry, []);
  }

  async reschedule(
    entry: ClaimedBackendOutboxEntry,
    delayMs: number,
    error: string,
  ): Promise<boolean> {
    return this.fenced(RESCHEDULE_SQL, entry, [
      boundedMs(delayMs),
      truncateError(error),
    ]);
  }

  async markDead(
    entry: ClaimedBackendOutboxEntry,
    error: string,
  ): Promise<boolean> {
    return this.fenced(MARK_DEAD_SQL, entry, [truncateError(error)]);
  }

  async purgeDone(olderThanMs: number, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) return 0;
    const { rowCount } = await this.pool.query(PURGE_SQL, [
      boundedMs(olderThanMs),
      limit,
    ]);
    return rowCount ?? 0;
  }

  private async enqueueWith(
    c: PoolClient,
    input: BackendOutboxEnqueueInput,
  ): Promise<BackendOutboxEnqueueResult> {
    // Common duplicate path: no seq is consumed.
    const existing = await c.query<Row>(SELECT_BY_KEY_SQL, [
      input.idempotencyKey,
    ]);
    if (existing.rows[0])
      return { entry: toEntry(existing.rows[0]), created: false };
    const seq = await c.query<{ seq: string }>(NEXT_SEQ_SQL, [
      input.conversationRef,
    ]);
    const inserted = await c.query<Row>(INSERT_SQL, [
      input.conversationRef,
      seq.rows[0].seq,
      input.kind,
      input.idempotencyKey,
      JSON.stringify(input.payload),
    ]);
    if (inserted.rows[0])
      return { entry: toEntry(inserted.rows[0]), created: true };
    // A concurrent enqueue with the same key won; its seq gap is harmless.
    const winner = await c.query<Row>(SELECT_BY_KEY_SQL, [
      input.idempotencyKey,
    ]);
    return { entry: toEntry(winner.rows[0]), created: false };
  }

  private async fenced(
    sql: string,
    entry: ClaimedBackendOutboxEntry,
    extra: unknown[],
  ): Promise<boolean> {
    if (
      !(entry.leaseExpiresAt instanceof Date) ||
      Number.isNaN(entry.leaseExpiresAt.getTime())
    )
      return false;
    const { rowCount } = await this.pool.query(sql, [
      entry.id,
      entry.leaseOwner,
      entry.leaseExpiresAt,
      ...extra,
    ]);
    return rowCount === 1;
  }

  private async withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
