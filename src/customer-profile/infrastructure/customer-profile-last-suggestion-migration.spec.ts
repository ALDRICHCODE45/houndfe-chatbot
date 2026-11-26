import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresCustomerProfileStore } from './postgres-customer-profile.store';

type Pgm = {
  sql: (sql: string) => void;
  addColumn: (...args: unknown[]) => void;
  dropColumn: (...args: unknown[]) => void;
};
const MIGRATION = '5950000000000_customer_profile_last_suggestion';
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require(`../../../migrations/${MIGRATION}`) as {
    up: (pgm: Pgm) => void;
    down: (pgm: Pgm) => void;
  };

function run(direction: 'up' | 'down') {
  const calls: Array<[string, ...unknown[]]> = [];
  migration[direction]({
    sql: (sql) => calls.push(['sql', sql]),
    addColumn: (...args) => calls.push(['addColumn', ...args]),
    dropColumn: (...args) => calls.push(['dropColumn', ...args]),
  });
  return calls;
}

const TIMEOUT = ['sql', "SET LOCAL lock_timeout = '5s';"];

describe('customer_profiles.last_suggestion_at migration (5950, T3)', () => {
  it('up adds a nullable timestamptz column', () => {
    expect(run('up')).toEqual([
      TIMEOUT,
      [
        'addColumn',
        'customer_profiles',
        { last_suggestion_at: { type: 'timestamptz' } },
      ],
    ]);
  });

  it('down drops it', () => {
    expect(run('down')).toEqual([
      TIMEOUT,
      ['dropColumn', 'customer_profiles', 'last_suggestion_at'],
    ]);
  });
});

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';
const AT = '2026-11-26T12:00:00.000Z';

ddescribe(
  'customer_profiles.last_suggestion_at migration 5950 (real PostgreSQL)',
  () => {
    jest.setTimeout(180_000);
    let container: StartedPostgreSqlContainer | undefined;
    let pool: Pool;
    let uri: string;
    const migrate = (direction: 'up' | 'down', ...args: string[]) =>
      execFileSync(
        process.execPath,
        [
          BIN,
          '-f',
          'package.json',
          '--config-value',
          'pg-migrate',
          direction,
          ...args,
        ],
        {
          cwd: ROOT,
          env: { DATABASE_URL: uri },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
    const column = async () =>
      (
        await pool.query<{ data_type: string; is_nullable: string }>(
          `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'customer_profiles' AND column_name = 'last_suggestion_at'`,
        )
      ).rows;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      uri = container.getConnectionUri();
      migrate('up');
      pool = new Pool({ connectionString: uri, max: 4 });
    });

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    it('up: the store round-trips the marker merge-only', async () => {
      await expect(column()).resolves.toEqual([
        { data_type: 'timestamp with time zone', is_nullable: 'YES' },
      ]);
      const store = new PostgresCustomerProfileStore(pool);
      await store.upsert(SENDER, { lastSuggestionAt: AT }, new Date(AT));
      await store.upsert(SENDER, { register: 'tu' }, new Date());
      await expect(store.read(SENDER)).resolves.toMatchObject({
        register: 'tu',
        lastSuggestionAt: AT,
      });
    });

    it('down drops the column and keeps the rows; up again restores it empty', async () => {
      const applied = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM pgmigrations WHERE name >= $1',
        [MIGRATION],
      );
      migrate('down', applied.rows[0].n);
      await expect(column()).resolves.toEqual([]);
      const rows = await pool.query(
        'SELECT register FROM customer_profiles WHERE sender_id = $1',
        [SENDER],
      );
      expect(rows.rows).toEqual([{ register: 'tu' }]);
      migrate('up');
      const read = await new PostgresCustomerProfileStore(pool).read(SENDER);
      expect(read).not.toHaveProperty('lastSuggestionAt');
    });
  },
);
