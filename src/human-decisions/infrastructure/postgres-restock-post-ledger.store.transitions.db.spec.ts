import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { PostgresRestockPostLedgerStore } from './postgres-restock-post-ledger.store';
import { PostgresSharedReservationStore } from './postgres-shared-reservation.store';

/**
 * R3b3-c3b real-PostgreSQL proof for the `recordReceipt` and `markUnknown` CAS
 * transitions. Gated by RUN_DOCKER_TESTS=1: it starts a disposable
 * `postgres:16-alpine`, applies ALL migrations to that container URI only via a
 * child `pnpm migrate` with an explicit `DATABASE_URL`, and drives the REAL
 * PostgresSharedReservationStore + PostgresRestockPostLedgerStore on one pool.
 * No backend HTTP/WhatsApp. Test-only against already-committed code
 * (42bcd26/5531655): GREEN proof only, no pre-implementation RED is claimed.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const OTHER = 'whatsapp:+5215500009999';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const DECISION = '33333333-3333-4333-8333-333333333333';
const OTHER_DECISION = '55555555-5555-4555-8555-555555555555';

const intake = (): RestockIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Alimento premium',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
});

/** The full persisted ledger projection so any unexpected write is caught. */
type LedgerRow = {
  status: string;
  post_state: string | null;
  backend_decision_id: string | null;
  post_attempted_at: Date | null;
  receipt_recorded_at: Date | null;
  unknown_observed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

ddescribe('recordReceipt / markUnknown CAS (real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let reservations: PostgresSharedReservationStore;
  let ledger: PostgresRestockPostLedgerStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync('pnpm', ['migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    reservations = new PostgresSharedReservationStore(pool);
    ledger = new PostgresRestockPostLedgerStore(pool);
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE human_decision_reservations, human_handoff_requests',
    );
  });

  const reserveRestock = () =>
    reservations.reserve({
      senderId: SENDER,
      route: 'RESTOCK',
      requestKey: SOURCE,
      intake: intake(),
    });
  const beginPost = () =>
    ledger.beginPost({ senderId: SENDER, sourceRequestId: SOURCE });
  const recordReceipt = (backendDecisionId: string, senderId = SENDER) =>
    ledger.recordReceipt({
      senderId,
      sourceRequestId: SOURCE,
      backendDecisionId,
    });
  const markUnknown = (senderId = SENDER) =>
    ledger.markUnknown({ senderId, sourceRequestId: SOURCE });
  const snapshot = async (): Promise<LedgerRow | undefined> => {
    const { rows } = await pool.query<LedgerRow>(
      `SELECT status, post_state, backend_decision_id, post_attempted_at,
              receipt_recorded_at, unknown_observed_at, created_at, updated_at
       FROM human_decision_reservations
       WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2`,
      [SENDER, SOURCE],
    );
    return rows[0];
  };

  /** Deterministic contention: hold the row with FOR UPDATE, launch both
   * transitions, and wait until BOTH are blocked on the lock before releasing
   * the holder. A timeout fails the test; the holder is always rolled back and
   * released, and every launched promise is settled so nothing leaks. */
  const waitForBlockedUpdates = async (expected: number) => {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE 'UPDATE human_decision_reservations%'
           AND pid <> pg_backend_pid()`,
      );
      if ((rows[0]?.n ?? 0) >= expected) return;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for two blocked ledger updates');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const raceReceiptAndUnknown = async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT 1 FROM human_decision_reservations
         WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2
         FOR UPDATE`,
        [SENDER, SOURCE],
      );
      const receiptPromise = recordReceipt(DECISION);
      const unknownPromise = markUnknown();
      try {
        await waitForBlockedUpdates(2);
        await holder.query('COMMIT');
      } catch (error) {
        await holder.query('ROLLBACK').catch(() => undefined);
        await Promise.allSettled([receiptPromise, unknownPromise]);
        throw error;
      }
      return await Promise.all([receiptPromise, unknownPromise]);
    } finally {
      holder.release();
    }
  };

  it('records a receipt durably and keeps the id authoritative', async () => {
    await reserveRestock();
    await expect(beginPost()).resolves.toEqual({ action: 'authorize_post' });
    await expect(recordReceipt(DECISION)).resolves.toEqual({
      action: 'record_receipt',
      backendDecisionId: DECISION,
    });

    const recorded = await snapshot();
    expect(recorded?.post_state).toBe('RECEIPT_RECORDED');
    expect(recorded?.backend_decision_id).toBe(DECISION);
    expect(recorded?.receipt_recorded_at).toBeInstanceOf(Date);
    expect(recorded?.post_attempted_at).toBeInstanceOf(Date);

    // A same-id replay and a different-id conflict must not write the row.
    await expect(recordReceipt(DECISION)).resolves.toEqual({
      action: 'replay_receipt',
      backendDecisionId: DECISION,
    });
    expect(await snapshot()).toEqual(recorded);
    await expect(recordReceipt(OTHER_DECISION)).resolves.toEqual({
      action: 'conflict',
      storedBackendDecisionId: DECISION,
    });
    expect(await snapshot()).toEqual(recorded);

    await expect(beginPost()).resolves.toEqual({
      action: 'historical_receipt',
      backendDecisionId: DECISION,
    });
    expect(await snapshot()).toEqual(recorded);
  });

  it('holds a pre-post UNKNOWN without writing on a blocked begin or record', async () => {
    await reserveRestock();
    await expect(markUnknown()).resolves.toEqual({
      action: 'mark_unknown',
      reason: 'pre_post',
    });
    const held = await snapshot();
    expect(held?.post_state).toBe('UNKNOWN');
    expect(held?.unknown_observed_at).toBeInstanceOf(Date);
    expect(held?.post_attempted_at).toBeNull();

    await expect(beginPost()).resolves.toEqual({
      action: 'hold',
      reason: 'unknown_state',
    });
    expect(await snapshot()).toEqual(held);
    await expect(recordReceipt(DECISION)).resolves.toEqual({
      action: 'blocked',
      reason: 'unknown_state',
    });
    expect(await snapshot()).toEqual(held);
  });

  it('holds an ambiguous post-flight UNKNOWN and preserves the attempt', async () => {
    await reserveRestock();
    await expect(beginPost()).resolves.toEqual({ action: 'authorize_post' });
    const attempted = (await snapshot())?.post_attempted_at;

    await expect(markUnknown()).resolves.toEqual({
      action: 'mark_unknown',
      reason: 'ambiguous_post',
    });
    const held = await snapshot();
    expect(held?.post_state).toBe('UNKNOWN');
    expect(held?.backend_decision_id).toBeNull();
    expect(held?.post_attempted_at?.getTime()).toBe(attempted?.getTime());

    await expect(beginPost()).resolves.toEqual({
      action: 'hold',
      reason: 'unknown_state',
    });
    expect(await snapshot()).toEqual(held);
    await expect(recordReceipt(DECISION)).resolves.toEqual({
      action: 'blocked',
      reason: 'unknown_state',
    });
    expect(await snapshot()).toEqual(held);
  });

  it('cannot act on a wrong sender or key while the row is ACTIVE', async () => {
    await reserveRestock();
    await expect(beginPost()).resolves.toEqual({ action: 'authorize_post' });
    const active = await snapshot();
    expect(active?.post_state).toBe('POST_IN_FLIGHT');

    const wrongSenderReceipt = await recordReceipt(DECISION, OTHER);
    const wrongSenderUnknown = await markUnknown(OTHER);
    expect(wrongSenderReceipt.action).toBe('blocked');
    expect(wrongSenderUnknown.action).toBe('blocked');
    expect(JSON.stringify(wrongSenderReceipt)).not.toContain(DECISION);
    expect(await snapshot()).toEqual(active);

    const wrongKey = await ledger.recordReceipt({
      senderId: SENDER,
      sourceRequestId: OTHER_SOURCE,
      backendDecisionId: DECISION,
    });
    expect(wrongKey.action).toBe('blocked');
    const wrongKeyUnknown = await ledger.markUnknown({
      senderId: SENDER,
      sourceRequestId: OTHER_SOURCE,
    });
    expect(wrongKeyUnknown.action).toBe('blocked');
    expect(await snapshot()).toEqual(active);
  });

  it('cannot act on a CLOSED row and leaves the whole row untouched', async () => {
    await reserveRestock();
    await expect(beginPost()).resolves.toEqual({ action: 'authorize_post' });
    await pool.query(
      `UPDATE human_decision_reservations SET status = 'CLOSED'
       WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2`,
      [SENDER, SOURCE],
    );
    const closed = await snapshot();
    expect(closed?.status).toBe('CLOSED');

    expect(await recordReceipt(DECISION)).toEqual({
      action: 'blocked',
      reason: 'unknown_row',
    });
    expect(await markUnknown()).toEqual({
      action: 'blocked',
      reason: 'unknown_row',
    });
    expect(await snapshot()).toEqual(closed);
    expect(closed?.backend_decision_id).toBeNull();
    expect(closed?.unknown_observed_at).toBeNull();
  });

  it('keeps the ledger consistent under locked contention', async () => {
    await reserveRestock();
    await expect(beginPost()).resolves.toEqual({ action: 'authorize_post' });
    const attempted = (await snapshot())?.post_attempted_at;

    const [receipt, unknown] = await raceReceiptAndUnknown();
    const row = await snapshot();

    if (row?.post_state === 'RECEIPT_RECORDED') {
      expect(receipt.action).toBe('record_receipt');
      expect(unknown.action).not.toBe('mark_unknown');
      expect(row.backend_decision_id).toBe(DECISION);
      expect(row.receipt_recorded_at).toBeInstanceOf(Date);
      expect(row.unknown_observed_at).toBeNull();
    } else {
      expect(row?.post_state).toBe('UNKNOWN');
      expect(unknown.action).toBe('mark_unknown');
      expect(receipt.action).not.toBe('record_receipt');
      expect(row?.backend_decision_id).toBeNull();
      expect(row?.unknown_observed_at).toBeInstanceOf(Date);
      expect(row?.receipt_recorded_at).toBeNull();
    }
    expect(row?.post_attempted_at?.getTime()).toBe(attempted?.getTime());
  });
});
