import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { selectOutOfStockRoute } from '../domain/restock-route-policy';
import type { ReservationProposal } from '../domain/shared-reservation';
import { PostgresSharedReservationStore } from './postgres-shared-reservation.store';
import { PostgresSharedRouteMarkersStore } from './postgres-shared-route-markers.store';

/**
 * HD-R3b3-c4c2b real-PostgreSQL contract suite for the read-only
 * PostgresSharedRouteMarkersStore (committed adapter).
 *
 * It starts a disposable `postgres:16-alpine` container, applies ALL migrations
 * to that container's URI only (never an ambient `DATABASE_URL`), connects a
 * pool exclusively to that URI, and drives the real adapter against the real
 * partial unique index and handoff rows. Fixtures are built through the REAL
 * PostgresSharedReservationStore.reserve (no production DB) plus a direct
 * handoff insert matching migration 1900.
 *
 * TEST-DISCIPLINE NOTE (transparent): the adapter under test is already
 * committed and unit-green (f020d20). This suite is genuine integration PROOF
 * of the real SQL result shape; it is NOT TDD, and no RED is claimed — a
 * "missing spec" or a deliberately broken expectation would not be a real
 * behavior RED. `readForSender` claims no old-writer exclusivity and no
 * cross-statement CAS; the reserve CAS is still required. No prod migration.
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
const restock = (senderId = SENDER): ReservationProposal => ({
  route: 'RESTOCK',
  senderId,
  requestKey: A,
  intake: intake(),
});
const legacy = (senderId = SENDER): ReservationProposal => ({
  route: 'LEGACY_OPS',
  senderId,
  requestKey: LEGACY_KEY,
  intake: null,
});
const read = (
  legacyRequestPending: boolean,
  restockIntentPresent: boolean,
) => ({
  legacyRequestPending,
  restockIntentPresent,
});
const CLAIM = { action: 'claim', reason: 'single_sender_vacant' } as const;

ddescribe('PostgresSharedRouteMarkersStore (real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let reservations: PostgresSharedReservationStore;
  let store: PostgresSharedRouteMarkersStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync('pnpm', ['migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    reservations = new PostgresSharedReservationStore(pool);
    store = new PostgresSharedRouteMarkersStore(pool);
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

  const addHandoff = (id: string, customerId: string, status: string) =>
    pool.query(
      `INSERT INTO human_handoff_requests
         (id, customer_id, agent_id, kind, digest, status)
       VALUES ($1, $2, 'OPS', 'out_of_stock', '{}'::jsonb, $3)`,
      [id, customerId, status],
    );
  const closeAll = (senderId: string) =>
    pool.query(
      `UPDATE human_decision_reservations SET status = 'CLOSED'
       WHERE sender_id = $1 AND status = 'ACTIVE'`,
      [senderId],
    );

  it('reads absent markers as both false and returns the exact key set', async () => {
    const markers = await store.readForSender(SENDER);
    expect(markers).toEqual(read(false, false));
    expect(Object.keys(markers).sort()).toEqual([
      'legacyRequestPending',
      'restockIntentPresent',
    ]);
  });

  it('reads an active RESTOCK reservation as restock intent only', async () => {
    await expect(reservations.reserve(restock())).resolves.toEqual(CLAIM);
    await expect(store.readForSender(SENDER)).resolves.toEqual(
      read(false, true),
    );
  });

  it('reads an active LEGACY_OPS reservation as a legacy request only', async () => {
    await expect(reservations.reserve(legacy())).resolves.toEqual(CLAIM);
    await expect(store.readForSender(SENDER)).resolves.toEqual(
      read(true, false),
    );
  });

  it('reads a pending legacy handoff without any reservation as a legacy request', async () => {
    await addHandoff(LEGACY_KEY, SENDER, 'pending');
    await expect(store.readForSender(SENDER)).resolves.toEqual(
      read(true, false),
    );
  });

  it('reads an active RESTOCK plus a pending handoff truthfully, and the pure policy blocks the conflict', async () => {
    await reservations.reserve(restock());
    await addHandoff(LEGACY_KEY, SENDER, 'pending');
    const markers = await store.readForSender(SENDER);
    expect(markers).toEqual(read(true, true));
    expect(
      selectOutOfStockRoute({ restockFeatureEnabled: true, ...markers }),
    ).toEqual({ route: 'blocked_conflict', reason: 'conflicting_markers' });
  });

  it('reads a CLOSED reservation and a resolved handoff as both false', async () => {
    await reservations.reserve(restock());
    await closeAll(SENDER);
    await addHandoff(LEGACY_KEY, SENDER, 'resolved');
    await expect(store.readForSender(SENDER)).resolves.toEqual(
      read(false, false),
    );
  });

  it('isolates markers by sender', async () => {
    await reservations.reserve(restock(OTHER));
    await addHandoff(LEGACY_KEY, OTHER, 'pending');
    await expect(store.readForSender(OTHER)).resolves.toEqual(read(true, true));
    await expect(store.readForSender(SENDER)).resolves.toEqual(
      read(false, false),
    );
  });
});
