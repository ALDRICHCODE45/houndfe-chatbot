import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runCustomerProfileStoreContract } from './customer-profile-store.contract';
import { PostgresCustomerProfileStore } from './postgres-customer-profile.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';

class FakePool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly rows: unknown[][] = []) {}
  query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    const rows = this.rows.shift() ?? [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
}

const fake = (rows: unknown[][] = []) => {
  const pool = new FakePool(rows);
  // SAFETY: FakePool implements the only `query` surface the store calls.
  return {
    pool,
    store: new PostgresCustomerProfileStore(pool as unknown as Pool),
  };
};

describe('PostgresCustomerProfileStore SQL (no database)', () => {
  it('upserts merge-only in one statement (COALESCE keeps stored values)', async () => {
    const { pool, store } = fake([[]]);
    await store.upsert(
      SENDER,
      { displayName: 'Ana', pet: { name: 'Luna' } },
      new Date('2026-11-07T00:00:00.000Z'),
    );
    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/INSERT INTO customer_profiles/);
    expect(sql).toMatch(/ON CONFLICT \(sender_id\) DO UPDATE/);
    expect(sql).toMatch(
      /display_name = COALESCE\(EXCLUDED\.display_name, customer_profiles\.display_name\)/,
    );
    expect(sql).toMatch(/customer_profiles\.pet, '\{\}'::jsonb\) \|\|/);
    expect(params[0]).toBe(SENDER);
    expect(params).toContain('Ana');
    expect(params).toContain(JSON.stringify({ name: 'Luna' }));
  });

  it('never queries for an invalid sender or an empty first patch', async () => {
    const { pool, store } = fake();
    await expect(
      store.upsert('sender-1', { displayName: 'Ana' }, new Date()),
    ).resolves.toBeNull();
    await expect(store.read('sender-1')).resolves.toBeNull();
    await expect(store.delete('sender-1')).resolves.toBe(false);
    expect(pool.calls).toHaveLength(0);
  });

  it('maps a row back to the profile shape', async () => {
    const { store } = fake([
      [
        {
          sender_id: SENDER,
          display_name: 'Ana',
          preferred_name: null,
          register: 'tu',
          emojis: true,
          tone: 'casual',
          pet: { name: 'Luna' },
          last_order_folio: 'A-1',
          last_order_confirmed_at: new Date('2026-11-01T10:00:00.000Z'),
          last_order_total_cents: '89900',
          updated_at: new Date('2026-11-07T00:00:00.000Z'),
        },
      ],
    ]);
    await expect(store.read(SENDER)).resolves.toEqual({
      senderId: SENDER,
      displayName: 'Ana',
      register: 'tu',
      emojis: true,
      tone: 'casual',
      pet: { name: 'Luna' },
      lastOrder: {
        folio: 'A-1',
        confirmedAt: '2026-11-01T10:00:00.000Z',
        totalCents: 89900,
      },
      updatedAt: '2026-11-07T00:00:00.000Z',
    });
  });
});

ddescribe('customer_profiles migration 3700 + store (real PostgreSQL)', () => {
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

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    // Every migration on an empty database, ending with 3700.
    migrate('up');
    pool = new Pool({ connectionString: uri });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('creates customer_profiles with its checks', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'customer_profiles' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'created_at',
      'display_name',
      'emojis',
      'last_order_confirmed_at',
      'last_order_folio',
      'last_order_total_cents',
      'pet',
      'preferred_name',
      'register',
      'sender_id',
      'tone',
      'updated_at',
    ]);
    const insert = (sender: string, register = 'usted', pet = '{}') =>
      pool.query(
        `INSERT INTO customer_profiles (sender_id, register, pet, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, now(), now())`,
        [sender, register, pet],
      );
    await expect(insert('abc')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('5215550009999', 'vos')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('5215550009999', 'tu', '[]')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      pool.query(
        `INSERT INTO customer_profiles (sender_id, last_order_folio, created_at, updated_at)
         VALUES ('5215550009998', 'A-1', now(), now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query('TRUNCATE TABLE customer_profiles');
  });

  it('rolls back an empty table and re-applies', async () => {
    migrate('down');
    const gone = await pool.query(
      "SELECT to_regclass('customer_profiles') AS t",
    );
    expect(gone.rows[0]).toEqual({ t: null });
    migrate('up');
  });

  runCustomerProfileStoreContract('postgres', () =>
    Promise.resolve({
      store: new PostgresCustomerProfileStore(pool),
      cleanup: async () => {
        await pool.query('TRUNCATE TABLE customer_profiles');
      },
    }),
  );

  it('a profile survives a new adapter instance (restart)', async () => {
    await new PostgresCustomerProfileStore(pool).upsert(
      SENDER,
      { register: 'tu', pet: { name: 'Luna' } },
      new Date('2026-11-07T00:00:00.000Z'),
    );
    await expect(
      new PostgresCustomerProfileStore(pool).read(SENDER),
    ).resolves.toMatchObject({ register: 'tu', pet: { name: 'Luna' } });
    await pool.query('TRUNCATE TABLE customer_profiles');
  });
});
