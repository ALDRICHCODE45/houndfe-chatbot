import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { ReservationProposal } from '../domain/shared-reservation';
import { PostgresSharedReservationStore } from './postgres-shared-reservation.store';

/**
 * HD-R3b2b3a real-PostgreSQL contract suite for the shared reservation adapter.
 *
 * It starts a disposable `postgres:16-alpine` container, applies ALL migrations
 * to that container's URI only (never an ambient `DATABASE_URL`), connects a
 * pool exclusively to it, and drives the real adapter against real unique
 * indexes and CHECK constraints. It covers same-sender cross-route concurrency,
 * exact replay / differing-intake conflict, other-sender mismatch, a legacy
 * pending row with no reservation, and the DB CHECK / partial unique sender
 * guarantees. It does NOT test pre-migration legacy backfill (R3b2b3b) and does
 * NOT claim route exclusivity against a pre-R3b3 legacy writer.
 *
 * Gated by RUN_DOCKER_TESTS=1 (matches the existing Testcontainers convention):
 * without the gate the suite is skipped and `pnpm test` stays green.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const OTHER = 'whatsapp:+5215500009999';
const LEGACY_KEY = 'a1b2c3d4e5f6';
const NEW_KEY = 'abcdefabcdef';
const DECISION = '33333333-3333-4333-8333-333333333333';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const intake = (o: Partial<RestockIntakeInput> = {}): RestockIntakeInput => ({
  sourceRequestId: A,
  type: 'RESTOCK',
  productId: B,
  productName: 'Alimento premium',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
  ...o,
});
const restock = (senderId = SENDER, o: Record<string, unknown> = {}) =>
  ({
    route: 'RESTOCK',
    senderId,
    requestKey: A,
    intake: intake(),
    ...o,
  }) as ReservationProposal;
const legacy = (senderId = SENDER): ReservationProposal => ({
  route: 'LEGACY_OPS',
  senderId,
  requestKey: LEGACY_KEY,
  intake: null,
});

ddescribe('PostgresSharedReservationStore (real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresSharedReservationStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync('pnpm', ['migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    store = new PostgresSharedReservationStore(pool);
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

  const activeRows = async (senderId = SENDER) =>
    (
      await pool.query<{ route: string; request_key: string }>(
        `SELECT route, request_key FROM human_decision_reservations
         WHERE sender_id = $1 AND status = 'ACTIVE'`,
        [senderId],
      )
    ).rows;

  const addHandoff = (id: string, customerId: string, status: string) =>
    pool.query(
      `INSERT INTO human_handoff_requests
         (id, customer_id, agent_id, kind, digest, status)
       VALUES ($1, $2, 'OPS', 'out_of_stock', '{}'::jsonb, $3)`,
      [id, customerId, status],
    );
  const statusOf = async (senderId: string, requestKey: string) => {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM human_decision_reservations
       WHERE route = 'LEGACY_OPS' AND sender_id = $1 AND request_key = $2`,
      [senderId, requestKey],
    );
    return rows[0]?.status;
  };

  it('lets exactly one of two concurrent same-sender routes claim', async () => {
    const decisions = await Promise.all([
      store.reserve(legacy()),
      store.reserve(restock()),
    ]);
    expect(decisions.filter((d) => d.action === 'claim')).toHaveLength(1);
    expect(decisions.filter((d) => d.action === 'occupied')).toHaveLength(1);
    expect(decisions.filter((d) => d.action === 'replay')).toHaveLength(0);
    expect(await activeRows()).toHaveLength(1);
  });

  it('replays an exact RESTOCK retry and conflicts on differing intake', async () => {
    await expect(store.reserve(restock())).resolves.toEqual({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    await expect(store.reserve(restock())).resolves.toEqual({
      action: 'replay',
      reason: 'exact_active_replay',
    });
    await expect(
      store.reserve(
        restock(SENDER, { intake: intake({ requestedQuantity: 9 }) }),
      ),
    ).resolves.toEqual({
      action: 'conflict',
      reason: 'same_key_different_payload',
    });
    expect(await activeRows()).toHaveLength(1);
  });

  it('blocks another sender on the same route+key without leaking it', async () => {
    await store.reserve(restock());
    const decision = await store.reserve(restock(OTHER));
    expect(decision).toEqual({
      action: 'blocked',
      reason: 'sender_mismatch',
    });
    expect(JSON.stringify(decision)).not.toContain('Alimento premium');
    expect(await activeRows(OTHER)).toHaveLength(0);
  });

  it('reports occupied_legacy for a legacy pending row with no reservation', async () => {
    await pool.query(
      `INSERT INTO human_handoff_requests
         (id, customer_id, agent_id, kind, digest, status)
       VALUES ($1, $2, 'OPS', 'out_of_stock', '{}'::jsonb, 'pending')`,
      [LEGACY_KEY, SENDER],
    );
    await expect(store.reserve(restock())).resolves.toEqual({
      action: 'occupied_legacy',
      reason: 'legacy_marker_present',
    });
    expect(await activeRows()).toHaveLength(0);
  });

  it('rejects a RESTOCK intake without a real sourceRequestId (DB CHECK)', async () => {
    const insert = (value: string) =>
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake, post_state)
         VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb, 'RESERVED')`,
        [SENDER, A, value],
      );
    await expect(insert('{}')).rejects.toThrow(/intake_check/);
    await expect(insert('{"sourceRequestId": null}')).rejects.toThrow(
      /intake_check/,
    );
  });

  it('enforces one ACTIVE sender across routes (partial unique index)', async () => {
    await pool.query(
      `INSERT INTO human_decision_reservations
         (sender_id, route, request_key, status, intake)
       VALUES ($1, 'LEGACY_OPS', $2, 'ACTIVE', NULL)`,
      [SENDER, LEGACY_KEY],
    );
    await expect(
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake, post_state)
         VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb, 'RESERVED')`,
        [SENDER, A, JSON.stringify(intake())],
      ),
    ).rejects.toThrow(/active_sender_idx/);
  });

  it('rejects a RESTOCK row without a post_state (DB CHECK)', async () => {
    await expect(
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake)
         VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb)`,
        [SENDER, A, JSON.stringify(intake())],
      ),
    ).rejects.toThrow(/post_state_route_check/);
  });

  it('rejects a leaked backend id while RESERVED (DB CHECK)', async () => {
    await expect(
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake, post_state,
            backend_decision_id)
         VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb, 'RESERVED', $4)`,
        [SENDER, A, JSON.stringify(intake()), DECISION],
      ),
    ).rejects.toThrow(/backend_decision_id_check/);
  });

  it('rejects a malformed recorded backend id (DB CHECK)', async () => {
    await expect(
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake, post_state,
            backend_decision_id, post_attempted_at, receipt_recorded_at)
         VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb, 'RECEIPT_RECORDED',
                 'nope', now(), now())`,
        [SENDER, A, JSON.stringify(intake())],
      ),
    ).rejects.toThrow(/backend_decision_id_check/);
  });

  it('rejects a LEGACY_OPS row with a post_state (DB CHECK)', async () => {
    await expect(
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake, post_state)
         VALUES ($1, 'LEGACY_OPS', $2, 'ACTIVE', NULL, 'RESERVED')`,
        [SENDER, LEGACY_KEY],
      ),
    ).rejects.toThrow(/post_state_route_check/);
  });

  it('does not close while the matching handoff is still pending', async () => {
    await store.reserve(legacy());
    await addHandoff(LEGACY_KEY, SENDER, 'pending');
    await expect(store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      false,
    );
    expect(await statusOf(SENDER, LEGACY_KEY)).toBe('ACTIVE');
  });

  it('does not close for a wrong sender or a wrong key', async () => {
    await store.reserve(legacy());
    await addHandoff(LEGACY_KEY, SENDER, 'resolved');
    await expect(store.closeLegacyResolved(OTHER, LEGACY_KEY)).resolves.toBe(
      false,
    );
    await expect(
      store.closeLegacyResolved(SENDER, 'ffffffffffff'),
    ).resolves.toBe(false);
    expect(await statusOf(SENDER, LEGACY_KEY)).toBe('ACTIVE');
  });

  it('closes the exact resolved handoff and is idempotent', async () => {
    await store.reserve(legacy());
    await addHandoff(LEGACY_KEY, SENDER, 'resolved');
    await expect(store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      true,
    );
    expect(await statusOf(SENDER, LEGACY_KEY)).toBe('CLOSED');
    await expect(store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      true,
    );
    expect(await statusOf(SENDER, LEGACY_KEY)).toBe('CLOSED');
  });

  it('lets a new legacy key claim after close and never touches it', async () => {
    await store.reserve(legacy());
    await addHandoff(LEGACY_KEY, SENDER, 'resolved');
    await expect(store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      true,
    );
    await expect(
      store.reserve({
        route: 'LEGACY_OPS',
        senderId: SENDER,
        requestKey: NEW_KEY,
        intake: null,
      }),
    ).resolves.toEqual({ action: 'claim', reason: 'single_sender_vacant' });
    expect(await statusOf(SENDER, NEW_KEY)).toBe('ACTIVE');
    await expect(store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      true,
    );
    expect(await statusOf(SENDER, NEW_KEY)).toBe('ACTIVE');
    expect(await statusOf(SENDER, LEGACY_KEY)).toBe('CLOSED');
  });
});
