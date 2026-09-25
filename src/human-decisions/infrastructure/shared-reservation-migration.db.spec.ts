import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * HD-R3b2b3b real-PostgreSQL migration suite for 2300000000000_human_decision_reservations.
 *
 * Starts a disposable `postgres:16-alpine`, applies migrations only through 220
 * on that container's URI, then exercises the 230 backfill: a duplicate pending
 * sender must abort the migration (partial unique ACTIVE-sender index) and roll
 * the table creation back; after fixing the data the backfill maps pending rows
 * to ACTIVE LEGACY_OPS (id -> request_key, customer_id -> sender_id, intake
 * NULL) and omits resolved rows; finally the nonempty `down` guard must refuse.
 *
 * The three tests are ORDERED and share DB state (each builds on the last).
 * Migrations run through `execFileSync` with `cwd` repo and an env that overrides
 * `DATABASE_URL` to the container URI only — global env is never assigned and the
 * URI is never logged. `up` targets a migration range with the numeric positional
 * plus `--timestamp` (verified against the local node-pg-migrate CLI); `down`
 * uses `pnpm migrate:down`. Gated by RUN_DOCKER_TESTS=1.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATE_BIN = join(
  REPO_ROOT,
  'node_modules',
  'node-pg-migrate',
  'bin',
  'node-pg-migrate.js',
);
const CONFIG = [
  '--config-file',
  'package.json',
  '--config-value',
  'pg-migrate',
];

const SENDER_A = 'whatsapp:+5215500000001';
const SENDER_B = 'whatsapp:+5215500000002';
const SENDER_R = 'whatsapp:+5215500000003';
const ID_A1 = 'aaaa11112222';
const ID_A2 = 'bbbb11112222';
const ID_B = 'cccc11112222';
const ID_R = 'dddd11112222';

type ReservationRow = {
  sender_id: string;
  route: string;
  request_key: string;
  status: string;
  intake: unknown;
};

const failureOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`;
  }
  throw new Error('expected the command to fail');
};

ddescribe('human_decision_reservations migration (real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  const env = () => ({
    ...process.env,
    DATABASE_URL: container.getConnectionUri(),
  });
  const runUp = (...args: string[]) =>
    execFileSync('node', [MIGRATE_BIN, ...CONFIG, 'up', ...args], {
      cwd: REPO_ROOT,
      env: env(),
      stdio: 'pipe',
    });
  const runDown = () =>
    execFileSync('pnpm', ['migrate:down'], {
      cwd: REPO_ROOT,
      env: env(),
      stdio: 'pipe',
    });
  const addHandoff = (id: string, customerId: string, status: string) =>
    pool.query(
      `INSERT INTO human_handoff_requests
         (id, customer_id, agent_id, kind, digest, status)
       VALUES ($1, $2, 'OPS', 'out_of_stock', '{}'::jsonb, $3)`,
      [id, customerId, status],
    );
  const tableExists = async (): Promise<boolean> => {
    const { rows } = await pool.query<{ present: boolean }>(
      `SELECT (to_regclass('public.human_decision_reservations')
               IS NOT NULL) AS present`,
    );
    return rows[0]?.present === true;
  };
  const reservations = async (): Promise<ReservationRow[]> => {
    const { rows } = await pool.query<ReservationRow>(
      `SELECT sender_id, route, request_key, status, intake
       FROM human_decision_reservations ORDER BY sender_id`,
    );
    return rows;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    runUp('2200000000000', '--timestamp');
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });

  it('aborts 230 on a duplicate pending sender and rolls the table back', async () => {
    await addHandoff(ID_A1, SENDER_A, 'pending');
    await addHandoff(ID_A2, SENDER_A, 'pending');
    const output = failureOf(() => runUp('2300000000000', '--timestamp'));
    expect(output).toContain('human_decision_reservations_active_sender_idx');
    expect(await tableExists()).toBe(false);
  });

  it('backfills pending rows as ACTIVE LEGACY_OPS and omits resolved rows', async () => {
    await pool.query('DELETE FROM human_handoff_requests WHERE id = $1', [
      ID_A2,
    ]);
    await addHandoff(ID_B, SENDER_B, 'pending');
    await addHandoff(ID_R, SENDER_R, 'resolved');

    runUp('2300000000000', '--timestamp');

    expect(await reservations()).toEqual([
      {
        sender_id: SENDER_A,
        route: 'LEGACY_OPS',
        request_key: ID_A1,
        status: 'ACTIVE',
        intake: null,
      },
      {
        sender_id: SENDER_B,
        route: 'LEGACY_OPS',
        request_key: ID_B,
        status: 'ACTIVE',
        intake: null,
      },
    ]);
  });

  it('refuses down on a nonempty table and keeps the committed rows', async () => {
    const output = failureOf(() => runDown());
    expect(output).toMatch(/refusing to roll back human_decision_reservations/);
    expect(await tableExists()).toBe(true);
    expect(await reservations()).toHaveLength(2);
  });
});
