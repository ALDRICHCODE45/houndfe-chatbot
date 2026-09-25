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
 * R3b3-c3a real-PostgreSQL proof for the `beginPost` CAS against the committed
 * c2 schema. Gated by RUN_DOCKER_TESTS=1: it starts a disposable
 * `postgres:16-alpine`, applies ALL migrations to that container URI only via a
 * child `pnpm migrate` with an explicit `DATABASE_URL`, and drives the REAL
 * PostgresSharedReservationStore + PostgresRestockPostLedgerStore on one pool.
 * No backend HTTP/send. Test-only: it proves the committed schema (81c92f7/
 * 1aa019e); no pre-implementation RED is claimed. The inconsistent-driver and
 * ambiguous DB-error paths are covered by the mock spec, not here.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const OTHER = 'whatsapp:+5215500009999';
const LEGACY_KEY = 'a1b2c3d4e5f6';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const DECISION = '33333333-3333-4333-8333-333333333333';

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

ddescribe('beginPost CAS (real PostgreSQL)', () => {
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
  const reserveLegacy = () =>
    reservations.reserve({
      senderId: SENDER,
      route: 'LEGACY_OPS',
      requestKey: LEGACY_KEY,
      intake: null,
    });
  const beginPost = (o: Record<string, string> = {}) =>
    ledger.beginPost({ senderId: SENDER, sourceRequestId: SOURCE, ...o });
  const ledgerRow = async (senderId = SENDER, requestKey = SOURCE) => {
    const { rows } = await pool.query<{
      status: string;
      post_state: string | null;
      post_attempted_at: Date | null;
    }>(
      `SELECT status, post_state, post_attempted_at
       FROM human_decision_reservations
       WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2`,
      [senderId, requestKey],
    );
    return rows[0];
  };
  const recordReceipt = (status: string) =>
    pool.query(
      `UPDATE human_decision_reservations
       SET status = $4, post_state = 'RECEIPT_RECORDED',
           backend_decision_id = $3,
           post_attempted_at = now(), receipt_recorded_at = now()
       WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2`,
      [SENDER, SOURCE, DECISION, status],
    );

  it('lets exactly one concurrent beginPost authorize', async () => {
    await expect(reserveRestock()).resolves.toEqual({
      action: 'claim',
      reason: 'single_sender_vacant',
    });

    const [a, b] = await Promise.all([beginPost(), beginPost()]);
    const authorized = [a, b].filter((d) => d.action === 'authorize_post');
    const held = [a, b].filter(
      (d) => d.action === 'hold' && d.reason === 'post_in_flight',
    );
    expect(authorized).toHaveLength(1);
    expect(held).toHaveLength(1);

    const row = await ledgerRow();
    expect(row?.post_state).toBe('POST_IN_FLIGHT');
    expect(row?.post_attempted_at).not.toBeNull();

    await expect(beginPost()).resolves.toEqual({
      action: 'hold',
      reason: 'post_in_flight',
    });
  });

  it('returns the historical id only for an ACTIVE recorded row', async () => {
    await reserveRestock();
    await recordReceipt('ACTIVE');
    await expect(beginPost()).resolves.toEqual({
      action: 'historical_receipt',
      backendDecisionId: DECISION,
    });
  });

  it('blocks a CLOSED recorded row without exposing the id', async () => {
    await reserveRestock();
    await recordReceipt('CLOSED');
    const decision = await beginPost();
    expect(decision).toEqual({ action: 'blocked', reason: 'unknown_row' });
    expect(JSON.stringify(decision)).not.toContain(DECISION);
  });

  it('blocks a wrong sender or a wrong key without exposing a stored id', async () => {
    await reserveRestock();
    await recordReceipt('ACTIVE');
    const wrongSender = await beginPost({ senderId: OTHER });
    const wrongKey = await beginPost({ sourceRequestId: OTHER_SOURCE });
    expect(wrongSender.action).toBe('blocked');
    expect(wrongKey.action).toBe('blocked');
    expect(JSON.stringify(wrongSender)).not.toContain(DECISION);
    expect(JSON.stringify(wrongKey)).not.toContain(DECISION);
  });

  it('never authorizes a non-RESTOCK row', async () => {
    await expect(reserveLegacy()).resolves.toEqual({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    const decision = await beginPost();
    expect(decision.action).toBe('blocked');

    const { rows } = await pool.query<{ status: string; post_state: null }>(
      `SELECT status, post_state FROM human_decision_reservations
       WHERE sender_id = $1 AND route = 'LEGACY_OPS' AND request_key = $2`,
      [SENDER, LEGACY_KEY],
    );
    expect(rows[0]).toEqual({ status: 'ACTIVE', post_state: null });
  });
});
