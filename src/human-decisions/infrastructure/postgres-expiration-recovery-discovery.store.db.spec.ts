import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresExpirationRecoveryDiscoveryStore } from './postgres-expiration-recovery-discovery.store';

// Read-only real-PostgreSQL proof for the EXPIRATION recovery discovery page,
// gated by RUN_DOCKER_TESTS=1: the actual adapter against schema 280 in a
// disposable postgres:16-alpine. Fixtures exist only to be read, so each case
// snapshots the whole table; constraint-impossible rows stay unit-only.
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const DECISION = '99999999-9999-4999-8999-999999999999';
const AT = '2026-06-22T12:00:00.000Z';
const key = (n: number) =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const sender = (n: number) => `whatsapp:+52155${n.toString().padStart(7, '0')}`;
const intake = (requestKey: string) =>
  JSON.stringify({
    sourceRequestId: requestKey,
    type: 'EXPIRATION',
    productId: PRODUCT,
    variantId: null,
  });
const INSERT = `INSERT INTO human_decision_reservations (sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`;
const RECEIPT = {
  post_state: 'RECEIPT_RECORDED',
  backend_decision_id: DECISION,
  post_attempted_at: AT,
  receipt_recorded_at: AT,
};
type Post = Partial<Record<keyof typeof RECEIPT, string | null>>;

ddescribe('EXPIRATION recovery discovery page (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let uri: string;
  let setup: Pool;

  const open = (max: number) => new Pool({ connectionString: uri, max });
  const discover = (pool: Pool, afterRequestKey?: string) =>
    new PostgresExpirationRecoveryDiscoveryStore(pool).discoverRecordedHints({
      limit: 64,
      afterRequestKey,
    });
  const seed = (route: string, n: number, status: string, post: Post | null) =>
    setup.query(INSERT, [
      sender(n),
      route,
      key(n),
      status,
      intake(key(n)),
      post?.post_state ?? null,
      post?.backend_decision_id ?? null,
      post?.post_attempted_at ?? null,
      post?.receipt_recorded_at ?? null,
      null,
    ]);
  const recorded = (n: number, post: Post = RECEIPT, status = 'ACTIVE') =>
    seed('EXPIRATION', n, status, post);
  const snapshot = async () =>
    (
      await setup.query(
        'SELECT * FROM human_decision_reservations ORDER BY sender_id',
      )
    ).rows as Record<string, unknown>[];

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
          '-f',
          'package.json',
          '--config-value',
          'pg-migrate',
          'up',
          '2800000000000',
          '--timestamp',
        ],
        {
          cwd: ROOT,
          env: { DATABASE_URL: container.getConnectionUri() },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
      uri = container.getConnectionUri();
      setup = open(3);
    } catch {
      throw new Error('disposable PostgreSQL discovery fixture setup failed');
    }
  });
  afterAll(async () => {
    try {
      await setup?.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await setup.query('TRUNCATE human_decision_reservations');
  });

  it('lists only ACTIVE EXPIRATION RECEIPT_RECORDED rows and never mutates', async () => {
    await recorded(1);
    await recorded(2, {
      post_state: 'RESERVED',
      backend_decision_id: null,
      post_attempted_at: null,
      receipt_recorded_at: null,
    });
    await recorded(3, RECEIPT, 'CLOSED');
    await seed('RESTOCK', 4, 'ACTIVE', RECEIPT);
    const before = await snapshot();
    expect(before).toHaveLength(4);
    await expect(discover(setup)).resolves.toEqual({
      action: 'page',
      hints: [{ senderId: sender(1), requestKey: key(1) }],
      nextCursor: null,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('walks more than 100 inquiries across pages and a fresh pool', async () => {
    for (let n = 0; n < 105; n++) await recorded(n);
    const first = open(1);
    const page1 = await discover(first).finally(() => first.end());
    expect(page1).toEqual({
      action: 'page',
      hints: Array.from({ length: 64 }, (_, n) => ({
        senderId: sender(n),
        requestKey: key(n),
      })),
      nextCursor: key(63),
    });
    if (page1.action !== 'page') throw new Error('expected a page');
    // A fresh pool + store resumes from the cursor retained in this test.
    const second = open(1);
    const page2 = await discover(second, page1.nextCursor!).finally(() =>
      second.end(),
    );
    expect(page2).toEqual({
      action: 'page',
      hints: Array.from({ length: 41 }, (_, n) => ({
        senderId: sender(n + 64),
        requestKey: key(n + 64),
      })),
      nextCursor: null,
    });
  });
});
