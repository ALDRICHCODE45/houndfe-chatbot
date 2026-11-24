import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runLocalPetStoreContract } from './local-pet-store.contract';
import { PostgresCustomerProfileStore } from './postgres-customer-profile.store';
import { PostgresLocalPetStore } from './postgres-local-pet.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';
const MIGRATION = '5700000000000_customer_profile_pets';
const pet = {
  id: 'b1f0c7a2-0000-4000-8000-000000000001',
  name: 'Luna',
  species: 'perro',
  createdAt: '2026-11-23T12:00:00.000Z',
};

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
  return { pool, store: new PostgresLocalPetStore(pool as unknown as Pool) };
};

describe('PostgresLocalPetStore SQL (no database)', () => {
  it('replaces the pets column in one upsert, leaving the other columns alone', async () => {
    const { pool, store } = fake();
    await store.write(SENDER, [pet] as never, new Date('2026-11-23T12:00:00Z'));
    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/INSERT INTO customer_profiles \(sender_id, pets,/);
    expect(sql).toMatch(/ON CONFLICT \(sender_id\) DO UPDATE SET pets = /);
    expect(sql).not.toMatch(/\bpet =/);
    expect(params).toEqual([
      SENDER,
      JSON.stringify([pet]),
      '2026-11-23T12:00:00.000Z',
    ]);
  });

  it('an empty list only clears an existing row (never inserts)', async () => {
    const { pool, store } = fake();
    await store.write(SENDER, [], new Date('2026-11-23T12:00:00Z'));
    expect(pool.calls[0].sql).toMatch(
      /^UPDATE customer_profiles SET pets = NULL/,
    );
  });

  it('reads and normalizes the list; invalid entries are dropped', async () => {
    const { store } = fake([[{ pets: [pet, { id: '' }] }]]);
    await expect(store.read(SENDER)).resolves.toEqual([pet]);
  });

  it('never queries for an invalid sender', async () => {
    const { pool, store } = fake();
    await expect(store.read('sender-1')).resolves.toEqual([]);
    await store.write('sender-1', [pet] as never, new Date());
    expect(pool.calls).toHaveLength(0);
  });
});

ddescribe(
  `customer_profiles.pets migration 5700 + store (real PostgreSQL)`,
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
    const applied = async () =>
      (
        await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pgmigrations WHERE name >= $1`,
          [MIGRATION],
        )
      ).rows[0].n;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      uri = container.getConnectionUri();
      migrate('up');
      pool = new Pool({ connectionString: uri });
    });

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    it('adds a nullable jsonb array column with its checks; the legacy pet column stays', async () => {
      const columns = await pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'customer_profiles' AND column_name IN ('pet', 'pets')
        ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'pet', data_type: 'jsonb' },
        { column_name: 'pets', data_type: 'jsonb' },
      ]);
      const insert = (sender: string, pets: string) =>
        pool.query(
          `INSERT INTO customer_profiles (sender_id, pets, created_at, updated_at)
         VALUES ($1, $2::jsonb, now(), now())`,
          [sender, pets],
        );
      await expect(insert('5215550009999', '{}')).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        insert('5215550009998', JSON.stringify(['x'.repeat(40_000)])),
      ).rejects.toMatchObject({ code: '23514' });
      await insert('5215550009997', '[]');
      await pool.query('TRUNCATE TABLE customer_profiles');
    });

    it('down refuses while a row has local pets, then rolls back an empty list and re-applies', async () => {
      await new PostgresLocalPetStore(pool).write(
        SENDER,
        [pet] as never,
        new Date('2026-11-23T12:00:00Z'),
      );
      // Every migration from 5700 on, so a later file never hides the guard.
      const n = await applied();
      expect(() => migrate('down', n)).toThrow(
        /refusing to roll back customer_profiles\.pets/,
      );
      migrate('up');
      // Still applied, data intact.
      await expect(
        new PostgresLocalPetStore(pool).read(SENDER),
      ).resolves.toEqual([pet]);
      await pool.query(`UPDATE customer_profiles SET pets = '[]'::jsonb`);
      migrate('down', await applied());
      const gone = await pool.query(
        `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'customer_profiles' AND column_name = 'pets'`,
      );
      expect(gone.rows).toEqual([]);
      // The profile row and the legacy pet column survive the rollback.
      await expect(
        new PostgresCustomerProfileStore(pool).read(SENDER),
      ).resolves.toMatchObject({ senderId: SENDER });
      migrate('up');
      await pool.query('TRUNCATE TABLE customer_profiles');
    });

    runLocalPetStoreContract('postgres', () =>
      Promise.resolve({
        store: new PostgresLocalPetStore(pool),
        profiles: new PostgresCustomerProfileStore(pool),
        cleanup: async () => {
          await pool.query('TRUNCATE TABLE customer_profiles');
        },
      }),
    );
  },
);
