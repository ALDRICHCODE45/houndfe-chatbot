/** WU14A PostgreSQL drain adapter for the WU9 worker's local
 * `NotificationStoreSeam` (no shared port, no send/alert/log surface).
 * Claims due PENDING or expired-lease SENDING rows (attempts < 3) as
 * SENDING under a 60-second DB-time lease inside a short transaction:
 * FOR UPDATE SKIP LOCKED keeps concurrent claims disjoint and expired
 * leases replayable. markSent/reschedule are parameter-bound fenced CAS
 * updates; the third failed attempt becomes FAILED. Nothing is
 * interpolated into SQL, no intent is created, no schema is touched. */
import type { Pool, PoolClient } from 'pg';
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';

type Row = Record<string, unknown>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;

const CLAIM_SQL = `WITH due AS (
  SELECT id FROM receipt_media_outbox
  WHERE (status = 'PENDING' AND next_attempt_at <= now())
    OR (status = 'SENDING' AND lease_expires_at <= now() AND attempts < 3)
  ORDER BY next_attempt_at, created_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED)
UPDATE receipt_media_outbox o
SET status = 'SENDING', lease_owner = $2,
  lease_expires_at = date_trunc('milliseconds', now()) + interval '60 seconds',
  updated_at = now()
FROM due WHERE o.id = due.id
RETURNING o.*`;

const MARK_SENT_SQL = `UPDATE receipt_media_outbox
SET status = 'SENT', provider_message_id = $3, sent_at = now(),
  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2
  AND lease_expires_at = $4::timestamptz AND lease_expires_at > now()`;

const RESCHEDULE_SQL = `UPDATE receipt_media_outbox
SET attempts = attempts + 1,
  status = CASE WHEN attempts < 2 THEN 'PENDING' ELSE 'FAILED' END,
  next_attempt_at = CASE WHEN attempts < 2
    THEN now() + make_interval(secs => $3::double precision / 1000.0)
    ELSE next_attempt_at END,
  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND status = 'SENDING' AND lease_owner = $2
  AND lease_expires_at = $4::timestamptz AND lease_expires_at > now()
RETURNING attempts`;

const camelize = <T extends object>(row: Row): T =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  ) as T;

/** Mirrors the worker's option validation: owner is a nonempty bounded
 * string; a malformed id is fenced without a DB roundtrip (it can never
 * match a uuid primary key). */
const ownerOk = (owner: string): boolean =>
  owner.length > 0 && owner.length <= 100;
const casInputOk = (id: string, owner: string): boolean =>
  UUID.test(id) && ownerOk(owner);

/** ABA fence: the expected lease expiration must be a real Date. */
const leaseTokenOk = (leaseExpiresAt: Date): boolean =>
  leaseExpiresAt instanceof Date && !Number.isNaN(leaseExpiresAt.getTime());

const MAX_DELAY_MS = 3_600_000;

export class PostgresReceiptOutboxStore {
  constructor(private readonly pool: Pool) {}

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

  async claimBatch(
    limit: number,
    owner: string,
  ): Promise<ReceiptMediaOutboxRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !ownerOk(owner)) return [];
    return this.withTx(async (c) =>
      (await c.query<Row>(CLAIM_SQL, [limit, owner])).rows.map((r) =>
        camelize<ReceiptMediaOutboxRow>(r),
      ),
    );
  }

  async markSent(
    id: string,
    owner: string,
    providerMessageId: string,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    if (
      casInputOk(id, owner) &&
      leaseTokenOk(leaseExpiresAt) &&
      providerMessageId.length > 0
    ) {
      return this.withTx(
        async (c) =>
          (
            await c.query(MARK_SENT_SQL, [
              id,
              owner,
              providerMessageId,
              leaseExpiresAt,
            ])
          ).rowCount === 1,
      );
    }
    return false;
  }

  async reschedule(
    id: string,
    owner: string,
    delayMs: number,
    leaseExpiresAt: Date,
  ): Promise<'rescheduled' | 'exhausted' | 'lost'> {
    if (
      !casInputOk(id, owner) ||
      !leaseTokenOk(leaseExpiresAt) ||
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_DELAY_MS
    )
      return 'lost';
    return this.withTx(async (c) => {
      const { rows, rowCount } = await c.query<{ attempts: number }>(
        RESCHEDULE_SQL,
        [id, owner, delayMs, leaseExpiresAt],
      );
      if (rowCount !== 1) return 'lost';
      return rows[0].attempts >= 3 ? 'exhausted' : 'rescheduled';
    });
  }
}
