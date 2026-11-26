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
  dropColumn: (...args: unknown[]) => void;
  addColumn: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
  dropConstraint: (...args: unknown[]) => void;
};
const MIGRATION = '5900000000000_customer_profile_drop_legacy_pet';
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
    dropColumn: (...args) => calls.push(['dropColumn', ...args]),
    addColumn: (...args) => calls.push(['addColumn', ...args]),
    addConstraint: (...args) => calls.push(['addConstraint', ...args]),
    dropConstraint: (...args) => calls.push(['dropConstraint', ...args]),
  });
  return calls;
}

/** The pet CHECKs of migration 3700, restored as they were. */
const PET_CHECKS = [
  [
    'addConstraint',
    'customer_profiles',
    'customer_profiles_pet_check',
    "CHECK (pet IS NULL OR jsonb_typeof(pet) = 'object')",
  ],
  [
    'addConstraint',
    'customer_profiles',
    'customer_profiles_pet_size_check',
    'CHECK (pet IS NULL OR octet_length(pet::text) <= 4096)',
  ],
];

describe('customer_profiles.pet drop migration (5900, T6d)', () => {
  it('up locks the table (failing fast on a held lock), refuses while any legacy pet exists, then drops the column', () => {
    const calls = run('up');
    expect(calls).toHaveLength(4);
    const [timeout, lock, guard, drop] = calls;
    // Review R4: a held lock fails the deploy fast instead of queueing every
    // profile read and write of the live bot behind it.
    expect(timeout).toEqual(['sql', "SET LOCAL lock_timeout = '5s';"]);
    expect(lock).toEqual([
      'sql',
      'LOCK TABLE customer_profiles IN ACCESS EXCLUSIVE MODE;',
    ]);
    expect(guard[0]).toBe('sql');
    expect(String(guard[1])).toMatch(
      /DO \$guard\$[\s\S]*IF EXISTS \(SELECT 1 FROM customer_profiles\s+WHERE pet IS NOT NULL\)[\s\S]*RAISE EXCEPTION 'refusing to drop customer_profiles\.pet: legacy pets exist'/,
    );
    expect(drop).toEqual(['dropColumn', 'customer_profiles', 'pet']);
  });

  it('down re-adds the nullable jsonb column (empty) with the 3700 CHECKs', () => {
    expect(run('down')).toEqual([
      ['addColumn', 'customer_profiles', { pet: { type: 'jsonb' } }],
      ...PET_CHECKS,
    ]);
  });
});

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';

ddescribe('customer_profiles.pet drop migration 5900 (real PostgreSQL)', () => {
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
      { cwd: ROOT, env: { DATABASE_URL: uri }, stdio: 'pipe', timeout: 60_000 },
    );
  /** Roll back 5900 and anything applied after it. */
  const rollbackFrom5900 = async () => {
    const applied = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM pgmigrations WHERE name >= $1',
      [MIGRATION],
    );
    migrate('down', applied.rows[0].n);
  };
  const petColumn = async () =>
    (
      await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'customer_profiles' AND column_name = 'pet'`,
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

  it('up drops the column; the profile rows and the store keep working', async () => {
    await expect(petColumn()).resolves.toEqual([]);
    const store = new PostgresCustomerProfileStore(pool);
    await store.upsert(SENDER, { displayName: 'Ana' }, new Date());
    await expect(store.read(SENDER)).resolves.toMatchObject({
      senderId: SENDER,
      displayName: 'Ana',
    });
    await pool.query('TRUNCATE TABLE customer_profiles');
  });

  it('down re-adds the nullable column (empty, 3700 CHECKs); the store ignores an old pet value', async () => {
    await new PostgresCustomerProfileStore(pool).upsert(
      SENDER,
      { displayName: 'Ana' },
      new Date('2026-11-25T12:00:00.000Z'),
    );
    await rollbackFrom5900();
    await expect(petColumn()).resolves.toEqual([
      { column_name: 'pet', data_type: 'jsonb', is_nullable: 'YES' },
    ]);
    const empty = await pool.query(
      'SELECT count(*)::int AS n FROM customer_profiles WHERE pet IS NOT NULL',
    );
    expect(empty.rows[0]).toEqual({ n: 0 });
    await expect(
      pool.query(`UPDATE customer_profiles SET pet = '[]'::jsonb`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`UPDATE customer_profiles SET pet = $1::jsonb`, [
        JSON.stringify({ notes: 'x'.repeat(5000) }),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    // A row an older build wrote: read without a pet, upserts leave it.
    await pool.query(
      `UPDATE customer_profiles SET pet = '{"name":"Luna","species":"perro"}'::jsonb`,
    );
    const store = new PostgresCustomerProfileStore(pool);
    const read = await store.read(SENDER);
    expect(read).toMatchObject({ senderId: SENDER, displayName: 'Ana' });
    expect(read).not.toHaveProperty('pet');
    const saved = await store.upsert(SENDER, { register: 'tu' }, new Date());
    expect(saved).not.toHaveProperty('pet');
    const stored = await pool.query<{ pet: unknown }>(
      'SELECT pet FROM customer_profiles WHERE sender_id = $1',
      [SENDER],
    );
    expect(stored.rows[0].pet).toEqual({ name: 'Luna', species: 'perro' });
  });

  it('up refuses while any legacy pet exists (nothing dropped), then succeeds once none is left', async () => {
    // The row of the previous test still holds a legacy pet.
    expect(() => migrate('up')).toThrow(
      /refusing to drop customer_profiles\.pet: legacy pets exist/,
    );
    await expect(petColumn()).resolves.toHaveLength(1);
    const kept = await pool.query<{ pet: unknown; display_name: string }>(
      'SELECT pet, display_name FROM customer_profiles WHERE sender_id = $1',
      [SENDER],
    );
    expect(kept.rows[0]).toEqual({
      pet: { name: 'Luna', species: 'perro' },
      display_name: 'Ana',
    });
    const applied = await pool.query(
      'SELECT 1 FROM pgmigrations WHERE name = $1',
      [MIGRATION],
    );
    expect(applied.rowCount).toBe(0);
    await pool.query('UPDATE customer_profiles SET pet = NULL');
    migrate('up');
    await expect(petColumn()).resolves.toEqual([]);
    await expect(
      new PostgresCustomerProfileStore(pool).read(SENDER),
    ).resolves.toMatchObject({ displayName: 'Ana', register: 'tu' });
    await pool.query('TRUNCATE TABLE customer_profiles');
  });
});
