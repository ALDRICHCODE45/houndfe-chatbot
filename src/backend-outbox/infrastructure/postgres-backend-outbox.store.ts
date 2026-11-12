import type { Pool, PoolClient } from 'pg';
import {
  assertEnqueueInput,
  laneForKind,
  truncateError,
  type BackendOutboxCompletion,
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
 * commit order equals seq order within a (conversation, lane). */
const NEXT_SEQ_SQL = `INSERT INTO backend_outbox_sequences (conversation_ref, lane, next_seq)
VALUES ($1, $2, 2)
ON CONFLICT (conversation_ref, lane) DO UPDATE
  SET next_seq = backend_outbox_sequences.next_seq + 1
RETURNING next_seq - 1 AS seq`;

const INSERT_SQL = `INSERT INTO backend_outbox
  (conversation_ref, lane, seq, kind, idempotency_key, payload, next_attempt_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb,
  now() + make_interval(secs => $7::double precision / 1000.0))
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING *`;

/** Strict head-of-line claim: per (conversation, lane) only the lowest
 * open seq is a candidate. A head another worker holds is skipped (SKIP LOCKED) and the
 * row-level predicates are re-checked after locking, so a committed claim
 * or completion by another worker is never double-claimed and seq N+1 is
 * never picked while seq N is open. The lease is truncated to ms so the
 * JS Date fencing token compares exactly. */
const CLAIM_SQL = `WITH heads AS (
  SELECT DISTINCT ON (conversation_ref, lane) id
  FROM backend_outbox
  WHERE status IN ('PENDING', 'IN_FLIGHT')
  ORDER BY conversation_ref, lane, seq
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

/** Batched claim: the run behind an already claimed head.
 *
 * EXPLAIN reasoning (no migration): the lateral scan filters
 * (conversation_ref = h.conversation_ref, lane, open status, seq >= h.seq)
 * ORDER BY seq LIMIT n, which `backend_outbox_open_heads_idx`
 * (conversation_ref, lane, seq) WHERE status IN ('PENDING','IN_FLIGHT')
 * (migrations/4400000000000_backend_outbox_lanes.js) serves as an ordered
 * index range scan of at most n rows of that (conversation, lane). The
 * window `bool_and(...) OVER (ORDER BY seq)` is true up to the first row that
 * is of another kind or not due, i.e. the contiguous run; the id lookups that
 * lock and update it use the primary key. Followers cannot be claimed by any
 * other worker meanwhile: they are never lane heads while the head is leased.
 * All rows receive the same ms-truncated lease, the head included.
 * The spec asserts through EXPLAIN that the lateral scan uses that index.
 *
 * Races with a stale holder (its lease expired, its `completeMany` still
 * running): `cand`/`run` read one snapshot, so a follower may be completed
 * or rescheduled while we wait for its row lock. The `locked` step therefore
 * repeats the row predicates (same kind, open, due or expired lease; the
 * head is exempt, it is fenced above): after a lock wait Postgres re-checks
 * them against the newest row version and drops a row that no longer
 * qualifies. `claimable` then cuts the run at the first dropped row, so a
 * follower is never claimed past a row that is not claimable any more
 * (head-of-line). Rows are locked in ascending seq, the order
 * `COMPLETE_MANY_SQL` uses, so the two statements cannot deadlock. */
export const CLAIM_RUN_SQL = `WITH head AS (
  SELECT id, conversation_ref, lane, seq, kind FROM backend_outbox
  WHERE id = $1 AND status = 'IN_FLIGHT' AND lease_owner = $2
    AND lease_expires_at = $3::timestamptz
  FOR UPDATE
), cand AS (
  SELECT o.id, o.seq,
    bool_and(o.kind = h.kind AND (o.id = h.id
      OR (o.status = 'PENDING' AND o.next_attempt_at <= now())
      OR (o.status = 'IN_FLIGHT' AND o.lease_expires_at <= now())))
      OVER (ORDER BY o.seq ROWS UNBOUNDED PRECEDING) AS in_run
  FROM head h
  CROSS JOIN LATERAL (
    SELECT x.id, x.seq, x.kind, x.status, x.next_attempt_at, x.lease_expires_at
    FROM backend_outbox x
    WHERE x.conversation_ref = h.conversation_ref AND x.lane = h.lane
      AND x.status IN ('PENDING', 'IN_FLIGHT') AND x.seq >= h.seq
    ORDER BY x.seq
    LIMIT $4::int
  ) o
), run AS (
  SELECT id, seq FROM cand WHERE in_run ORDER BY seq LIMIT $4::int
), locked AS (
  SELECT o.id, o.seq FROM backend_outbox o
  CROSS JOIN head h
  WHERE o.id IN (SELECT id FROM run)
    AND o.kind = h.kind
    AND (o.id = h.id
      OR (o.status = 'PENDING' AND o.next_attempt_at <= now())
      OR (o.status = 'IN_FLIGHT' AND o.lease_expires_at <= now()))
  ORDER BY o.seq FOR UPDATE OF o
), claimable AS (
  SELECT l.id FROM locked l
  WHERE NOT EXISTS (
    SELECT 1 FROM run r
    WHERE r.seq < l.seq AND r.id NOT IN (SELECT id FROM locked))
)
UPDATE backend_outbox o
SET status = 'IN_FLIGHT', lease_owner = $5,
  lease_expires_at = date_trunc('milliseconds', now())
    + make_interval(secs => $6::double precision / 1000.0)
FROM claimable WHERE o.id = claimable.id
RETURNING o.*`;

/** DONE / RETRY / DEAD for many claimed rows in one statement, each row
 * fenced by its own (owner, lease). Same column effects as the single-row
 * statements below.
 *
 * Deadlock avoidance: rows are locked first, in (conversation, lane, seq)
 * order whatever the input order, which is the order `CLAIM_RUN_SQL` locks
 * its run in. The fence is part of the locking scan, so after a lock wait
 * Postgres re-evaluates it against the row's newest version: a row another
 * worker re-leased or completed meanwhile is skipped (reported `false`). */
export const COMPLETE_MANY_SQL = `WITH v AS (
  SELECT * FROM unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::text[],
    $5::text[], $6::double precision[])
    WITH ORDINALITY AS t(id, owner, lease, outcome, error, delay_ms, ord)
), locked AS (
  SELECT o.id, v.outcome, v.error, v.delay_ms, v.ord
  FROM backend_outbox o JOIN v ON o.id = v.id
  WHERE o.status = 'IN_FLIGHT' AND o.lease_owner = v.owner
    AND o.lease_expires_at = v.lease
  ORDER BY o.conversation_ref, o.lane, o.seq
  FOR UPDATE OF o
)
UPDATE backend_outbox o
SET status = CASE l.outcome
    WHEN 'DONE' THEN 'DONE' WHEN 'DEAD' THEN 'DEAD' ELSE 'PENDING' END,
  attempts = o.attempts + 1,
  done_at = CASE WHEN l.outcome = 'DONE' THEN now() ELSE o.done_at END,
  last_error = CASE WHEN l.outcome = 'DONE' THEN o.last_error ELSE l.error END,
  next_attempt_at = CASE WHEN l.outcome = 'RETRY'
    THEN now() + make_interval(secs => l.delay_ms / 1000.0)
    ELSE o.next_attempt_at END,
  lease_owner = NULL, lease_expires_at = NULL
FROM locked l
WHERE o.id = l.id
RETURNING l.ord`;

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

  async claimRun(
    head: ClaimedBackendOutboxEntry,
    owner: string,
    leaseMs: number,
    maxRows: number,
  ): Promise<ClaimedBackendOutboxEntry[]> {
    if (
      !Number.isSafeInteger(maxRows) ||
      maxRows < 1 ||
      owner.length === 0 ||
      owner.length > 100 ||
      !(head.leaseExpiresAt instanceof Date) ||
      Number.isNaN(head.leaseExpiresAt.getTime())
    )
      return [];
    const { rows } = await this.pool.query<Row>(CLAIM_RUN_SQL, [
      head.id,
      head.leaseOwner,
      head.leaseExpiresAt,
      maxRows,
      owner,
      boundedMs(leaseMs),
    ]);
    return rows
      .map((row) => toEntry(row) as ClaimedBackendOutboxEntry)
      .sort((a, b) => a.seq - b.seq);
  }

  async completeMany(
    items: readonly BackendOutboxCompletion[],
  ): Promise<boolean[]> {
    if (items.length === 0) return [];
    const valid = items.map(
      ({ entry }) =>
        entry.leaseExpiresAt instanceof Date &&
        !Number.isNaN(entry.leaseExpiresAt.getTime()),
    );
    const usable = items.filter((_, index) => valid[index]);
    // 1-based position (in `usable`) of every item that was applied.
    const applied = new Set<number>();
    if (usable.length > 0) {
      const { rows } = await this.pool.query<{ ord: string }>(
        COMPLETE_MANY_SQL,
        [
          usable.map((item) => item.entry.id),
          usable.map((item) => item.entry.leaseOwner),
          usable.map((item) => item.entry.leaseExpiresAt.toISOString()),
          usable.map((item) => item.outcome),
          usable.map((item) =>
            item.outcome === 'DONE' ? '' : truncateError(item.error),
          ),
          usable.map((item) =>
            item.outcome === 'RETRY' ? boundedMs(item.delayMs) : 0,
          ),
        ],
      );
      for (const row of rows) applied.add(Number(row.ord));
    }
    let position = 0;
    return valid.map((ok) => (ok ? applied.has(++position) : false));
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
    const lane = laneForKind(input.kind);
    const seq = await c.query<{ seq: string }>(NEXT_SEQ_SQL, [
      input.conversationRef,
      lane,
    ]);
    const inserted = await c.query<Row>(INSERT_SQL, [
      input.conversationRef,
      lane,
      seq.rows[0].seq,
      input.kind,
      input.idempotencyKey,
      JSON.stringify(input.payload),
      boundedMs(input.delayMs ?? 0),
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
