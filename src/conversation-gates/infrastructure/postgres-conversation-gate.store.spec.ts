import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runConversationGateStoreContract } from './conversation-gate-store.contract';
import { PostgresConversationGateStore } from './postgres-conversation-gate.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';
const NOW = new Date('2026-11-09T16:00:00.000Z');

class FakePool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(
    private readonly results: Array<{ rows: unknown[]; rowCount: number }> = [],
  ) {}
  query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    return Promise.resolve(this.results.shift() ?? { rows: [], rowCount: 0 });
  }
}

const fake = (results: Array<{ rows: unknown[]; rowCount: number }> = []) => {
  const pool = new FakePool(results);
  // SAFETY: FakePool implements the only `query` surface the store calls.
  const store = new PostgresConversationGateStore(
    pool as unknown as Pool,
    () => NOW,
  );
  return { pool, store };
};

describe('PostgresConversationGateStore SQL (no database)', () => {
  it('upserts on (sender_id, gate_kind) with a serialized payload', async () => {
    const { pool, store } = fake();
    await store.put({
      senderId: SENDER,
      kind: 'order_confirmation',
      payload: { reference: 'r' },
      expiresAt: new Date('2026-11-09T16:05:00.000Z'),
    });
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(sender_id, gate_kind\) DO UPDATE/);
    expect(params).toEqual([
      SENDER,
      'order_confirmation',
      '{"reference":"r"}',
      '2026-11-09T16:05:00.000Z',
    ]);
  });

  it('consumes with DELETE … RETURNING, unexpired and matching only', async () => {
    const { pool, store } = fake();
    await expect(
      store.consume(SENDER, 'restock_pending', { originMessageId: 'w' }),
    ).resolves.toBeNull();
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/DELETE FROM conversation_gates/);
    expect(sql).toMatch(/expires_at > \$3/);
    expect(sql).toMatch(/payload @> \$4::jsonb/);
    expect(sql).toMatch(/RETURNING/);
    expect(params).toEqual([
      SENDER,
      'restock_pending',
      NOW.toISOString(),
      '{"originMessageId":"w"}',
    ]);
  });

  it('treats a malformed row as absent', async () => {
    const { store } = fake([
      {
        rows: [
          {
            sender_id: SENDER,
            gate_kind: 'order_confirmation',
            payload: 'not-an-object',
            expires_at: new Date('2026-11-09T16:05:00.000Z'),
          },
        ],
        rowCount: 1,
      },
    ]);
    await expect(store.get(SENDER, 'order_confirmation')).resolves.toBeNull();
  });

  it('purges one bounded batch with SKIP LOCKED', async () => {
    const { pool, store } = fake([{ rows: [], rowCount: 3 }]);
    await expect(store.purgeExpired(100_000)).resolves.toBe(3);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/expires_at <= \$1/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(params).toEqual([NOW.toISOString(), 5000]);
  });
});

ddescribe('conversation_gates migration 4200 + store (real PostgreSQL)', () => {
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
  const insert = (patch: Record<string, string | number>) => {
    const row = {
      sender_id: SENDER,
      gate_kind: 'order_confirmation',
      payload: '{}',
      minutes: 5,
      ...patch,
    };
    return pool.query(
      `INSERT INTO conversation_gates (sender_id, gate_kind, payload, expires_at)
       VALUES ($1, $2, $3::jsonb, now() + make_interval(mins => $4))`,
      [row.sender_id, row.gate_kind, row.payload, row.minutes],
    );
  };
  const rollbackFrom4200 = async () => {
    // Roll back 4200 and everything applied after it.
    const applied = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pgmigrations
        WHERE name >= '4200000000000_conversation_gates'`,
    );
    migrate('down', applied.rows[0].n);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    migrate('up');
    pool = new Pool({ connectionString: uri, max: 10 });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('creates conversation_gates with its checks and expiry index', async () => {
    await expect(insert({ gate_kind: 'nope' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert({ payload: '[]' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert({ sender_id: '' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insert({ payload: JSON.stringify({ big: 'x'.repeat(70_000) }) }),
    ).rejects.toMatchObject({ code: '23514' });
    await insert({});
    await expect(insert({})).rejects.toMatchObject({ code: '23505' });
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'conversation_gates'`,
    );
    expect(indexes.rows.map((r) => r.indexdef).join('\n')).toMatch(
      /\(expires_at\)/,
    );
    await pool.query('TRUNCATE TABLE conversation_gates');
  });

  it('refuses to roll back while an unexpired gate exists', async () => {
    await insert({});
    await expect(rollbackFrom4200()).rejects.toThrow(/unexpired gates exist/);
    await pool.query('TRUNCATE TABLE conversation_gates');
    await insert({ minutes: -1 });
    await rollbackFrom4200();
    const gone = await pool.query(
      "SELECT to_regclass('conversation_gates') AS t",
    );
    expect(gone.rows[0]).toEqual({ t: null });
    migrate('up');
  });

  runConversationGateStoreContract('postgres', (now) =>
    Promise.resolve({
      store: new PostgresConversationGateStore(pool, now),
      cleanup: async () => {
        await pool.query('TRUNCATE TABLE conversation_gates');
      },
    }),
  );

  it('concurrent consumes from separate adapters yield exactly one winner', async () => {
    const clock = () => new Date();
    await new PostgresConversationGateStore(pool, clock).put({
      senderId: SENDER,
      kind: 'checkout_confirmation',
      payload: { reference: 'ref-race' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        new PostgresConversationGateStore(pool, clock).consume(
          SENDER,
          'checkout_confirmation',
          { reference: 'ref-race' },
        ),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    await pool.query('TRUNCATE TABLE conversation_gates');
  });
});
