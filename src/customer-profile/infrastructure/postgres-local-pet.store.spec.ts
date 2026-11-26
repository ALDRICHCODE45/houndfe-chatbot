import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runLocalPetStoreContract } from './local-pet-store.contract';
import { PostgresCustomerProfileStore } from './postgres-customer-profile.store';
import {
  LOCAL_PET_STORE_TIMEOUT_MS,
  PostgresLocalPetStore,
} from './postgres-local-pet.store';

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

type Call = { sql: string; params: unknown[] };

class FakeClient {
  readonly calls: Call[] = [];
  readonly released: Array<Error | undefined> = [];
  /** Answers per statement (shifted for every query, BEGIN included). */
  constructor(private readonly answers: Array<() => Promise<unknown[]>>) {}
  query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    const answer = this.answers.shift();
    return (answer?.() ?? Promise.resolve([])).then((rows) => ({
      rows,
      rowCount: rows.length,
    }));
  }
  release(error?: Error) {
    this.released.push(error);
  }
}

class FakePool {
  connects = 0;
  constructor(
    readonly client: FakeClient,
    private readonly acquire: () => Promise<FakeClient> = () =>
      Promise.resolve(client),
  ) {}
  connect() {
    this.connects += 1;
    return this.acquire();
  }
}

const rows =
  (value: unknown[] = []) =>
  () =>
    Promise.resolve(value);
const never = () => new Promise<unknown[]>(() => undefined);

const fake = (
  answers: Array<() => Promise<unknown[]>> = [],
  acquire?: (client: FakeClient) => Promise<FakeClient>,
) => {
  const client = new FakeClient(answers);
  const pool = new FakePool(
    client,
    acquire === undefined ? undefined : () => acquire(client),
  );
  // SAFETY: FakePool implements the only `connect` surface the store calls.
  return {
    pool,
    client,
    store: new PostgresLocalPetStore(pool as unknown as Pool),
  };
};

const sqls = (client: FakeClient) => client.calls.map((call) => call.sql);
const GUARD =
  /^SELECT set_config\('statement_timeout', \$1, true\), set_config\('idle_in_transaction_session_timeout', \$1, true\)$/;

describe('PostgresLocalPetStore SQL (no database)', () => {
  it('replaces the pets column in one upsert inside a time-bounded transaction, leaving the other columns alone', async () => {
    const { client, store } = fake();
    await store.write(SENDER, [pet] as never, new Date('2026-11-23T12:00:00Z'));
    expect(sqls(client)).toHaveLength(4);
    expect(client.calls[0].sql).toBe('BEGIN');
    expect(client.calls[1].sql).toMatch(GUARD);
    expect(Number(client.calls[1].params[0])).toBeGreaterThan(0);
    expect(Number(client.calls[1].params[0])).toBeLessThanOrEqual(
      LOCAL_PET_STORE_TIMEOUT_MS,
    );
    const { sql, params } = client.calls[2];
    expect(sql).toMatch(/INSERT INTO customer_profiles \(sender_id, pets,/);
    expect(sql).toMatch(/ON CONFLICT \(sender_id\) DO UPDATE SET pets = /);
    expect(sql).not.toMatch(/\bpet =/);
    expect(params).toEqual([
      SENDER,
      JSON.stringify([pet]),
      '2026-11-23T12:00:00.000Z',
    ]);
    expect(client.calls[3].sql).toBe('COMMIT');
    expect(client.released).toEqual([undefined]);
  });

  it('an empty list only clears an existing row (never inserts)', async () => {
    const { client, store } = fake();
    await store.write(SENDER, [], new Date('2026-11-23T12:00:00Z'));
    expect(client.calls[2].sql).toMatch(
      /^UPDATE customer_profiles SET pets = NULL/,
    );
    expect(client.calls[3].sql).toBe('COMMIT');
  });

  it('reads and normalizes the list under the same bound; invalid entries are dropped', async () => {
    const { client, store } = fake([
      rows(),
      rows(),
      rows([{ pets: [pet, { id: '' }] }]),
    ]);
    await expect(store.read(SENDER)).resolves.toEqual([pet]);
    expect(sqls(client)[0]).toBe('BEGIN');
    expect(sqls(client)[1]).toMatch(GUARD);
    expect(sqls(client)[2]).toMatch(/^SELECT pets FROM customer_profiles/);
    expect(client.released).toEqual([undefined]);
  });

  it('never connects for an invalid sender', async () => {
    const { pool, store } = fake();
    await expect(store.read('sender-1')).resolves.toEqual([]);
    await store.write('sender-1', [pet] as never, new Date());
    expect(pool.connects).toBe(0);
  });

  it('a failed statement destroys the connection (the open transaction is aborted) and never commits', async () => {
    const failure = new Error('boom');
    const { client, store } = fake([
      rows(),
      rows(),
      () => Promise.reject(failure),
    ]);
    await expect(store.write(SENDER, [pet] as never, new Date())).rejects.toBe(
      failure,
    );
    expect(sqls(client)).not.toContain('COMMIT');
    expect(client.released).toEqual([failure]);
  });

  describe('F1: bounded by LOCAL_PET_STORE_TIMEOUT_MS, connection acquire included', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('the store bound leaves the service bound a margin (≤ 10 s overall)', () => {
      expect(LOCAL_PET_STORE_TIMEOUT_MS).toBeLessThan(10_000);
    });

    it('a connection acquire that does not finish in time rejects; a late client is released untouched', async () => {
      let hand: (client: FakeClient) => void = () => undefined;
      const { client, store } = fake([], () => new Promise((r) => (hand = r)));
      const write = store.write(SENDER, [pet] as never, new Date());
      const settled = expect(write).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(LOCAL_PET_STORE_TIMEOUT_MS);
      await settled;
      hand(client);
      await jest.advanceTimersByTimeAsync(0);
      expect(client.calls).toEqual([]);
      expect(client.released).toEqual([undefined]);
    });

    it('a statement still running at the deadline: connection destroyed, COMMIT never sent, rejects', async () => {
      const { client, store } = fake([rows(), rows(), never]);
      const write = store.write(SENDER, [pet] as never, new Date());
      const settled = expect(write).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(LOCAL_PET_STORE_TIMEOUT_MS);
      await settled;
      expect(sqls(client)).not.toContain('COMMIT');
      expect(client.released).toHaveLength(1);
      expect(client.released[0]).toBeInstanceOf(Error);
    });

    it('the server-side statement_timeout is the time left after the acquire', async () => {
      const { client, store } = fake(
        [],
        (c) => new Promise((resolve) => setTimeout(() => resolve(c), 3_000)),
      );
      const write = store.write(SENDER, [pet] as never, new Date());
      await jest.advanceTimersByTimeAsync(3_000);
      await write;
      expect(client.calls[1].params[0]).toBe(
        String(LOCAL_PET_STORE_TIMEOUT_MS - 3_000),
      );
    });
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

    it('adds a nullable jsonb array column with its checks (T6d: the legacy pet column is gone)', async () => {
      const columns = await pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'customer_profiles' AND column_name IN ('pet', 'pets')
        ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([
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
      // The profile row survives the rollback (raw read: the rollback also
      // undid 5950, whose column the current profile store selects).
      const row = await pool.query(
        'SELECT sender_id FROM customer_profiles WHERE sender_id = $1',
        [SENDER],
      );
      expect(row.rows).toEqual([{ sender_id: SENDER }]);
      migrate('up');
      await pool.query('TRUNCATE TABLE customer_profiles');
    });

    it('F1: a write blocked past the deadline is cancelled server-side and never lands later', async () => {
      const store = new PostgresLocalPetStore(pool);
      await store.write(SENDER, [pet] as never, new Date());
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          'SELECT 1 FROM customer_profiles WHERE sender_id = $1 FOR UPDATE',
          [SENDER],
        );
        const started = Date.now();
        await expect(
          store.write(SENDER, [], new Date()),
        ).rejects.toBeInstanceOf(Error);
        expect(Date.now() - started).toBeLessThan(
          LOCAL_PET_STORE_TIMEOUT_MS + 1_000,
        );
        await locker.query('COMMIT');
      } finally {
        locker.release();
      }
      // The lock is gone: a write still pending would land now.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(store.read(SENDER)).resolves.toEqual([pet]);
      const idle = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
        WHERE state LIKE 'idle in transaction%' AND datname = current_database()`,
      );
      expect(idle.rows[0].n).toBe('0');
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
