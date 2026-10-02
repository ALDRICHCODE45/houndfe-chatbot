import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

// Opt-in, disposable database only. Never inherit a DATABASE_URL or child env.
const suite = process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const SOURCE = '11111111-1111-4111-8111-111111111111';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-01T00:00:00.000Z';
const TABLE = 'human_decision_reservations';
const fields = [
  'post_state',
  'backend_decision_id',
  'post_attempted_at',
  'receipt_recorded_at',
  'unknown_observed_at',
] as const;
type Metadata = Partial<Record<(typeof fields)[number], string | null>>;
const recorded = {
  post_state: 'RECEIPT_RECORDED',
  backend_decision_id: ID,
  post_attempted_at: AT,
  receipt_recorded_at: AT,
};

suite('EXPIRATION POST schema 280 (no initialization or runtime)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const migrate = (direction: string, target: string) =>
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
        '-f',
        'package.json',
        '--config-value',
        'pg-migrate',
        direction,
        target,
        '--timestamp',
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
  const insert = (
    metadata: Metadata = {},
    route = 'EXPIRATION',
    sender = 'sender',
  ) =>
    pool.query(
      `INSERT INTO human_decision_reservations (sender_id,route,request_key,intake,post_state,backend_decision_id,post_attempted_at,receipt_recorded_at,unknown_observed_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
      [
        sender,
        route,
        route === 'LEGACY_OPS' ? 'aabbccddeeff' : SOURCE,
        route === 'LEGACY_OPS'
          ? null
          : JSON.stringify({
              sourceRequestId: SOURCE,
              type: route,
              productId: SOURCE,
              variantId: null,
            }),
        ...fields.map((key) => metadata[key] ?? null),
      ],
    );
  const snapshot = async () => ({
    rows: (
      await pool.query(
        `SELECT * FROM human_decision_reservations ORDER BY sender_id`,
      )
    ).rows,
    constraints: (
      await pool.query(
        `SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`,
        [TABLE],
      )
    ).rows,
    migrations: (await pool.query('SELECT * FROM pgmigrations ORDER BY id'))
      .rows,
  });
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    migrate('up', '2700000000000');
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE human_decision_reservations`);
    migrate('down', '2800000000000');
    migrate('up', '2800000000000');
  });

  it('preserves NULL reservations and legacy/RESTOCK data without initialization', async () => {
    migrate('down', '2800000000000');
    await insert();
    await insert({}, 'LEGACY_OPS', 'legacy');
    await insert({ post_state: 'RESERVED' }, 'RESTOCK', 'restock');
    const before = await snapshot();
    migrate('up', '2800000000000');
    expect((await snapshot()).rows).toEqual(before.rows);
    // Explicit NULL on a new EXPIRATION row remains uninitialized too.
    await pool.query(
      `DELETE FROM human_decision_reservations WHERE route='EXPIRATION'`,
    );
    await insert();
    const { rows } = await pool.query(
      `SELECT post_state,backend_decision_id,post_attempted_at,receipt_recorded_at,unknown_observed_at FROM human_decision_reservations WHERE route='EXPIRATION'`,
    );
    expect(rows).toEqual([
      Object.fromEntries(fields.map((key) => [key, null])),
    ]);
  });

  it.each([
    {},
    { post_state: 'RESERVED' },
    { post_state: 'POST_IN_FLIGHT', post_attempted_at: AT },
    recorded,
    { post_state: 'UNKNOWN', unknown_observed_at: AT },
    { post_state: 'UNKNOWN', unknown_observed_at: AT, post_attempted_at: AT },
  ])('accepts coherent EXPIRATION metadata %j', async (metadata) => {
    await insert(metadata);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM human_decision_reservations`,
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it.each([
    { post_state: 'INVALID' },
    { post_state: 'POST_IN_FLIGHT' },
    { post_state: 'UNKNOWN' },
    { post_state: 'RESERVED', post_attempted_at: AT },
    { backend_decision_id: ID },
    { receipt_recorded_at: AT },
    { unknown_observed_at: AT },
    { post_attempted_at: AT },
    { ...recorded, backend_decision_id: null },
    { ...recorded, post_attempted_at: null },
    { ...recorded, receipt_recorded_at: null },
    { ...recorded, backend_decision_id: ID.toUpperCase() },
    {
      ...recorded,
      backend_decision_id: '00000000-0000-0000-0000-000000000000',
    },
    {
      ...recorded,
      backend_decision_id: 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa',
    },
    {
      ...recorded,
      backend_decision_id: 'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
    },
  ])('rejects incoherent EXPIRATION metadata %j', async (metadata) => {
    await expect(insert(metadata)).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['ACTIVE', 'CLOSED'])(
    'refuses DOWN with %s attempt data without changing anything',
    async (status) => {
      await insert(recorded);
      await pool.query(`UPDATE human_decision_reservations SET status=$1`, [
        status,
      ]);
      const before = await snapshot();
      expect(() => migrate('down', '2800000000000')).toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it('restores exact 270 checks with NULL EXPIRATION and leaves RESTOCK semantics intact', async () => {
    migrate('down', '2800000000000');
    await insert();
    await insert(
      { ...recorded, backend_decision_id: ID.toUpperCase() },
      'RESTOCK',
      'restock',
    );
    const before = await snapshot();
    migrate('up', '2800000000000');
    const widened = await snapshot();
    migrate('down', '2800000000000');
    const after = await snapshot();
    expect(after.rows).toEqual(before.rows);
    expect(after.constraints).toEqual(before.constraints);
    migrate('up', '2800000000000');
    expect((await snapshot()).constraints).toEqual(widened.constraints);
    await expect(
      insert({ post_state: 'RESERVED' }, 'LEGACY_OPS', 'legacy'),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
