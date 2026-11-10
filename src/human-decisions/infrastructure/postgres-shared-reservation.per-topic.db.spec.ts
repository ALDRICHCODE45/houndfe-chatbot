import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  SENDER_OPEN_RESERVATION_LIMIT,
  type ReservationProposal,
} from '../domain/shared-reservation';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';
import { PostgresSharedReservationStore } from './postgres-shared-reservation.store';
import { PostgresSharedRouteMarkersStore } from './postgres-shared-route-markers.store';

/**
 * S5 real-PostgreSQL suite for migration 400: one ACTIVE reservation per
 * (sender, route, topic) instead of one per sender, plus the application cap
 * of 20 ACTIVE reservations per sender. Gated by RUN_DOCKER_TESTS=1.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATE = join(
  REPO_ROOT,
  'node_modules/node-pg-migrate/bin/node-pg-migrate.js',
);

const SENDER = 'whatsapp:+5215500000001';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const OTHER_VARIANT = '55555555-5555-4555-8555-555555555555';

/** Deterministic v4-shaped UUID from a small integer. */
const uuid = (n: number, prefix = 'a') =>
  `${prefix.repeat(8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const restockIntake = (
  sourceRequestId: string,
  o: Partial<RestockIntakeInput> = {},
): RestockIntakeInput => ({
  sourceRequestId,
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Alimento premium',
  variantId: VARIANT,
  sku: null,
  requestedQuantity: null,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
  ...o,
});
const restock = (
  requestKey: string,
  o: Partial<RestockIntakeInput> = {},
): ReservationProposal => ({
  senderId: SENDER,
  route: 'RESTOCK',
  requestKey,
  intake: restockIntake(requestKey, o),
});
const expiration = (
  requestKey: string,
  variantId: string | null = VARIANT,
): ReservationProposal => ({
  senderId: SENDER,
  route: 'EXPIRATION',
  requestKey,
  intake: {
    sourceRequestId: requestKey,
    type: 'EXPIRATION',
    productId: PRODUCT,
    variantId,
  },
});
const legacy = (requestKey: string): ReservationProposal => ({
  senderId: SENDER,
  route: 'LEGACY_OPS',
  requestKey,
  intake: null,
});

const migrate = (url: string, direction: 'up' | 'down', target: string) =>
  execFileSync(
    process.execPath,
    [
      MIGRATE,
      '-f',
      'package.json',
      '--config-value',
      'pg-migrate',
      direction,
      ...(direction === 'up' ? [target, '--timestamp'] : [target]),
    ],
    {
      cwd: REPO_ROOT,
      env: { DATABASE_URL: url },
      stdio: 'pipe',
      timeout: 60_000,
    },
  );

ddescribe('PostgresSharedReservationStore per topic (real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresSharedReservationStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    migrate(container.getConnectionUri(), 'up', '4000000000000');
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

  const active = async () =>
    (
      await pool.query<{ route: string; topic_key: string }>(
        `SELECT route, topic_key FROM human_decision_reservations
         WHERE sender_id = $1 AND status = 'ACTIVE' ORDER BY route, topic_key`,
        [SENDER],
      )
    ).rows;

  it('lets two RESTOCK requests on different variants coexist', async () => {
    await expect(store.reserve(restock(uuid(1)))).resolves.toEqual({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    await expect(
      store.reserve(restock(uuid(2), { variantId: OTHER_VARIANT })),
    ).resolves.toMatchObject({ action: 'claim' });
    expect(await active()).toEqual([
      { route: 'RESTOCK', topic_key: `variant:${VARIANT}` },
      { route: 'RESTOCK', topic_key: `variant:${OTHER_VARIANT}` },
    ]);
  });

  it('lets RESTOCK, EXPIRATION and LEGACY_OPS coexist for one sender', async () => {
    await expect(store.reserve(restock(uuid(1)))).resolves.toMatchObject({
      action: 'claim',
    });
    await expect(store.reserve(expiration(uuid(2)))).resolves.toMatchObject({
      action: 'claim',
    });
    await expect(store.reserve(legacy('a1b2c3d4e5f6'))).resolves.toMatchObject({
      action: 'claim',
    });
    expect(await active()).toEqual([
      { route: 'EXPIRATION', topic_key: `variant:${VARIANT}` },
      { route: 'LEGACY_OPS', topic_key: 'legacy' },
      { route: 'RESTOCK', topic_key: `variant:${VARIANT}` },
    ]);
  });

  it('keys a variant-less request by product', async () => {
    await store.reserve(restock(uuid(1), { variantId: null }));
    await store.reserve(expiration(uuid(2), null));
    expect(await active()).toEqual([
      { route: 'EXPIRATION', topic_key: `product:${PRODUCT}` },
      { route: 'RESTOCK', topic_key: `product:${PRODUCT}` },
    ]);
  });

  it('still rejects a second request key on the SAME topic', async () => {
    await store.reserve(restock(uuid(1)));
    await expect(store.reserve(restock(uuid(2)))).resolves.toEqual({
      action: 'occupied',
      reason: 'different_active_key',
      activeRoute: 'RESTOCK',
    });
    await store.reserve(expiration(uuid(3)));
    await expect(store.reserve(expiration(uuid(4)))).resolves.toMatchObject({
      action: 'occupied',
    });
    await store.reserve(legacy('a1b2c3d4e5f6'));
    await expect(store.reserve(legacy('bbbbbbbbbbbb'))).resolves.toMatchObject({
      action: 'occupied',
    });
    expect(await active()).toHaveLength(3);
  });

  it('replays the exact same request idempotently', async () => {
    await store.reserve(restock(uuid(1)));
    await store.reserve(restock(uuid(2), { variantId: OTHER_VARIANT }));
    await expect(store.reserve(restock(uuid(1)))).resolves.toEqual({
      action: 'replay',
      reason: 'exact_active_replay',
    });
    await expect(
      store.reserve(restock(uuid(1), { productName: 'Otro nombre' })),
    ).resolves.toMatchObject({ action: 'conflict' });
    expect(await active()).toHaveLength(2);
  });

  it('rejects the same topic racing with two keys: one winner', async () => {
    const results = await Promise.all([
      store.reserve(restock(uuid(1))),
      store.reserve(restock(uuid(2))),
    ]);
    expect(results.map((r) => r.action).sort()).toEqual(['claim', 'occupied']);
    expect(await active()).toHaveLength(1);
  });

  it(`refuses the ${SENDER_OPEN_RESERVATION_LIMIT + 1}st open request with a typed result`, async () => {
    for (let n = 1; n <= SENDER_OPEN_RESERVATION_LIMIT; n++) {
      await expect(
        store.reserve(restock(uuid(n), { variantId: uuid(n, 'b') })),
      ).resolves.toMatchObject({ action: 'claim' });
    }
    const extra = SENDER_OPEN_RESERVATION_LIMIT + 1;
    await expect(
      store.reserve(restock(uuid(extra), { variantId: uuid(extra, 'b') })),
    ).resolves.toEqual({
      action: 'limit_reached',
      reason: 'sender_open_limit',
      limit: SENDER_OPEN_RESERVATION_LIMIT,
    });
    // A replay of an already-open request is still served at the cap.
    await expect(
      store.reserve(restock(uuid(1), { variantId: uuid(1, 'b') })),
    ).resolves.toMatchObject({ action: 'replay' });
    expect(await active()).toHaveLength(SENDER_OPEN_RESERVATION_LIMIT);
  });

  it('enforces the cap under concurrent claims', async () => {
    for (let n = 1; n < SENDER_OPEN_RESERVATION_LIMIT; n++) {
      await store.reserve(restock(uuid(n), { variantId: uuid(n, 'b') }));
    }
    const racing = [30, 31, 32].map((n) =>
      store.reserve(restock(uuid(n), { variantId: uuid(n, 'b') })),
    );
    const actions = (await Promise.all(racing)).map((r) => r.action).sort();
    expect(actions).toEqual(['claim', 'limit_reached', 'limit_reached']);
    expect(await active()).toHaveLength(SENDER_OPEN_RESERVATION_LIMIT);
  });

  it('does not count CLOSED reservations toward the cap', async () => {
    for (let n = 1; n <= SENDER_OPEN_RESERVATION_LIMIT; n++) {
      await store.reserve(restock(uuid(n), { variantId: uuid(n, 'b') }));
    }
    await pool.query(
      `UPDATE human_decision_reservations SET status = 'CLOSED'
       WHERE request_key = $1`,
      [uuid(1)],
    );
    await expect(
      store.reserve(restock(uuid(40), { variantId: uuid(40, 'b') })),
    ).resolves.toMatchObject({ action: 'claim' });
  });

  it('enforces one ACTIVE per (sender, route, topic) in the schema itself', async () => {
    await store.reserve(restock(uuid(1)));
    await expect(
      pool.query(
        `INSERT INTO human_decision_reservations
           (sender_id, route, request_key, status, intake, post_state)
         VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb, 'RESERVED')`,
        [SENDER, uuid(2), JSON.stringify(restockIntake(uuid(2)))],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  const recordReceipt = (requestKey: string, decisionId: string) =>
    pool.query(
      `UPDATE human_decision_reservations
       SET post_state = 'RECEIPT_RECORDED', backend_decision_id = $2,
           post_attempted_at = now(), receipt_recorded_at = now()
       WHERE request_key = $1`,
      [requestKey, decisionId],
    );

  it('reads the RESTOCK marker per topic while other topics are open', async () => {
    const markers = new PostgresSharedRouteMarkersStore(pool);
    await store.reserve(restock(uuid(1)));
    await store.reserve(expiration(uuid(2), OTHER_VARIANT));
    await expect(
      markers.readForSender(SENDER, `variant:${VARIANT}`),
    ).resolves.toEqual({
      legacyRequestPending: false,
      restockIntentPresent: true,
    });
    // An EXPIRATION request on another subject never marks RESTOCK.
    await expect(
      markers.readForSender(SENDER, `variant:${OTHER_VARIANT}`),
    ).resolves.toEqual({
      legacyRequestPending: false,
      restockIntentPresent: false,
    });
    await store.reserve(legacy('a1b2c3d4e5f6'));
    await expect(
      markers.readForSender(SENDER, `variant:${OTHER_VARIANT}`),
    ).resolves.toEqual({
      legacyRequestPending: true,
      restockIntentPresent: false,
    });
    // The legacy sender-wide reading stays fail-closed with several rows.
    await expect(markers.readForSender(SENDER)).resolves.toEqual({
      legacyRequestPending: 'unknown',
      restockIntentPresent: 'unknown',
    });
  });

  it('reads one recorded RESTOCK context per request or topic', async () => {
    const context = new PostgresRestockApplicationContextStore(pool);
    await store.reserve(restock(uuid(1)));
    await store.reserve(restock(uuid(2), { variantId: OTHER_VARIANT }));
    await recordReceipt(uuid(1), uuid(101, 'c'));
    await recordReceipt(uuid(2), uuid(102, 'c'));

    const byKey = await context.readRecordedForSender(SENDER, {
      requestKey: uuid(2),
    });
    expect(byKey).toMatchObject({
      action: 'recorded',
      context: {
        backendDecisionId: uuid(102, 'c'),
        reservation: { requestKey: uuid(2) },
      },
    });
    await expect(
      context.readRecordedForSender(SENDER, {
        topicKey: `variant:${VARIANT}`,
      }),
    ).resolves.toMatchObject({
      action: 'recorded',
      context: { reservation: { requestKey: uuid(1) } },
    });
    await expect(
      context.readRecordedForSender(SENDER, { requestKey: uuid(9) }),
    ).resolves.toEqual({ action: 'missing' });
    await expect(context.readRecordedForSender(SENDER)).rejects.toThrow(
      'inconsistent restock context read',
    );
    await expect(context.listRecordedRequestKeys(SENDER)).resolves.toEqual([
      uuid(1),
      uuid(2),
    ]);
  });

  it('down refuses while a sender holds two ACTIVE reservations, then succeeds', async () => {
    const url = container.getConnectionUri();
    await store.reserve(restock(uuid(1)));
    await store.reserve(expiration(uuid(2)));
    expect(() => migrate(url, 'down', '1')).toThrow();
    expect(await active()).toHaveLength(2);
    await pool.query(
      `UPDATE human_decision_reservations SET status = 'CLOSED'
       WHERE request_key = $1`,
      [uuid(2)],
    );
    migrate(url, 'down', '1');
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'human_decision_reservations' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toContain(
      'human_decision_reservations_active_sender_idx',
    );
    expect(rows.map((r) => r.indexname)).not.toContain(
      'human_decision_reservations_active_topic_idx',
    );
    migrate(url, 'up', '4000000000000');
  });
});
