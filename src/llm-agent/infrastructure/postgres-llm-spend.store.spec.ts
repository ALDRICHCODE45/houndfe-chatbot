import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runLlmSpendStoreContract } from './llm-spend-store.contract';
import { PostgresLlmSpendStore } from './postgres-llm-spend.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';
const AT = new Date('2026-11-18T18:00:00.000Z');
const PERIODS = { day: '2026-11-18', month: '2026-11' };

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
  return { pool, store: new PostgresLlmSpendStore(pool as unknown as Pool) };
};

describe('PostgresLlmSpendStore SQL (no database)', () => {
  it('releases one notice by its (sender, key) primary key', async () => {
    const { pool, store } = fake();
    await store.releaseNotice(SENDER, 'sender_limit');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(
      /DELETE FROM llm_guard_notices WHERE sender_id = \$1::text AND notice_key = \$2::text/,
    );
    expect(pool.calls[0].params).toEqual([SENDER, 'sender_limit']);
  });

  it('admits a turn in ONE statement keyed by the sender and period keys', async () => {
    const { pool, store } = fake([
      {
        rows: [{ budget_period: null, limit_window: null, noticed: 0 }],
        rowCount: 1,
      },
    ]);
    await expect(
      store.admitTurn({
        senderId: SENDER,
        at: AT,
        periods: PERIODS,
        caps: { dayUsd: 10, monthUsd: 200 },
        limits: { perHour: 40, perDay: 120 },
      }),
    ).resolves.toEqual({ kind: 'allowed' });
    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/FROM llm_spend_periods/);
    expect(sql).toMatch(/FROM llm_sender_turns/);
    expect(sql).toMatch(/INSERT INTO llm_sender_turns/);
    expect(sql).toMatch(/INSERT INTO llm_guard_notices/);
    expect(params).toEqual([
      SENDER,
      AT.toISOString(),
      'day:2026-11-18',
      'month:2026-11',
      10,
      200,
      40,
      120,
      'budget:day:2026-11-18',
      'budget:month:2026-11',
    ]);
  });

  it('maps refusals and first notices', async () => {
    const { store } = fake([
      {
        rows: [{ budget_period: 'month', limit_window: 'hour', noticed: 1 }],
        rowCount: 1,
      },
      {
        rows: [{ budget_period: null, limit_window: 'day', noticed: 0 }],
        rowCount: 1,
      },
    ]);
    const request = {
      senderId: SENDER,
      at: AT,
      periods: PERIODS,
      caps: { dayUsd: 10, monthUsd: 200 },
      limits: { perHour: 40, perDay: 120 },
    };
    await expect(store.admitTurn(request)).resolves.toEqual({
      kind: 'budget_exhausted',
      period: 'month',
      firstNotice: true,
    });
    await expect(store.admitTurn(request)).resolves.toEqual({
      kind: 'sender_limited',
      window: 'day',
      firstNotice: false,
    });
  });

  it('records the call and both period totals in one statement', async () => {
    const { pool, store } = fake([
      {
        rows: [
          {
            period_key: 'day:2026-11-18',
            usd: '8.50000000',
            warned_now: true,
            exhausted_now: false,
          },
          {
            period_key: 'month:2026-11',
            usd: '42.00000000',
            warned_now: false,
            exhausted_now: false,
          },
        ],
        rowCount: 2,
      },
    ]);
    await expect(
      store.record({
        source: 'agent_turn',
        inputTokens: 10,
        outputTokens: 5,
        usd: 0.25,
        at: AT,
        periods: PERIODS,
        caps: { dayUsd: 10, monthUsd: 200 },
      }),
    ).resolves.toEqual({
      dayUsd: 8.5,
      monthUsd: 42,
      warned80: ['day'],
      reached100: [],
    });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/INSERT INTO llm_usage_ledger/);
    expect(pool.calls[0].sql).toMatch(/ON CONFLICT \(period_key\) DO UPDATE/);
  });

  it('reads totals by primary key', async () => {
    const { pool, store } = fake([
      { rows: [{ period_key: 'month:2026-11', usd: '3.5' }], rowCount: 1 },
    ]);
    await expect(store.totals(PERIODS)).resolves.toEqual({
      dayUsd: 0,
      monthUsd: 3.5,
    });
    expect(pool.calls[0].params).toEqual(['day:2026-11-18', 'month:2026-11']);
  });
});

ddescribe('llm cost guard migration 5100 + store (real PostgreSQL)', () => {
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

  runLlmSpendStoreContract(
    'PostgresLlmSpendStore',
    () => new PostgresLlmSpendStore(pool),
  );

  it('creates the tables, checks and the per-sender turn index', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('llm_usage_ledger','llm_spend_periods','llm_sender_turns','llm_guard_notices')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'llm_guard_notices',
      'llm_sender_turns',
      'llm_spend_periods',
      'llm_usage_ledger',
    ]);
    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'llm_sender_turns_sender_admitted_idx'`,
    );
    expect(index.rows[0].indexdef).toMatch(/\(sender_id, admitted_at\)/);
    await expect(
      pool.query(
        `INSERT INTO llm_spend_periods (period_key, cap_usd) VALUES ('week:1', 1)`,
      ),
    ).rejects.toThrow(/check/);
    await expect(
      pool.query(
        `INSERT INTO llm_usage_ledger (source, input_tokens, output_tokens, usd, day_key)
         VALUES ('other', 1, 1, 0, '2026-11-18')`,
      ),
    ).rejects.toThrow(/check/);
  });

  it('down refuses while recent spend exists, then rolls back once it is gone', async () => {
    const store = new PostgresLlmSpendStore(pool);
    await store.record({
      source: 'agent_turn',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.01,
      at: new Date(),
      periods: { day: '2026-11-18', month: '2026-11' },
      caps: { dayUsd: 10, monthUsd: 200 },
    });
    expect(() => migrate('down', '1')).toThrow(/refusing to roll back/);
    await pool.query(`DELETE FROM llm_usage_ledger`);
    migrate('down', '1');
    const left = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'llm_usage_ledger'`,
    );
    expect(left.rowCount).toBe(0);
    migrate('up');
  });
});
