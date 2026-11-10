import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runTranscriptStoreContract } from './transcript-store.contract';
import { PostgresTranscriptStore } from './postgres-transcript.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';

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
  return { pool, store: new PostgresTranscriptStore(pool as unknown as Pool) };
};

describe('PostgresTranscriptStore SQL (no database)', () => {
  it('appends with ON CONFLICT (wa_message_id) DO NOTHING', async () => {
    const { pool, store } = fake([{ rows: [], rowCount: 1 }]);
    await expect(
      store.append({
        senderId: SENDER,
        waMessageId: 'wamid.1',
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'text',
        text: 'hola',
        observedAt: new Date('2026-11-09T16:00:00.000Z'),
      }),
    ).resolves.toBe(true);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/INSERT INTO conversation_messages/);
    expect(sql).toMatch(/ON CONFLICT \(wa_message_id\) DO NOTHING/);
    expect(params).toEqual(
      expect.arrayContaining([
        SENDER,
        'wamid.1',
        'IN',
        'CUSTOMER',
        'text',
        'hola',
        '2026-11-09T16:00:00.000Z',
        '2027-11-09T16:00:00.000Z',
      ]),
    );
  });

  it('reports a replay as not inserted', async () => {
    const { store } = fake([{ rows: [], rowCount: 0 }]);
    await expect(
      store.append({
        senderId: SENDER,
        waMessageId: 'wamid.1',
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'text',
        observedAt: new Date('2026-11-09T16:00:00.000Z'),
      }),
    ).resolves.toBe(false);
  });

  it('purges one bounded batch with SKIP LOCKED', async () => {
    const { pool, store } = fake([{ rows: [], rowCount: 7 }]);
    await expect(
      store.purgeExpired(new Date('2027-11-09T16:00:00.000Z'), 1000),
    ).resolves.toBe(7);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/DELETE FROM conversation_messages/);
    expect(sql).toMatch(/purge_after <= \$1/);
    expect(sql).toMatch(/LIMIT \$2/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(params).toEqual(['2027-11-09T16:00:00.000Z', 1000]);
  });

  it('never queries for an invalid sender', async () => {
    const { pool, store } = fake();
    await expect(store.listRecent('abc', 10)).resolves.toEqual([]);
    expect(pool.calls).toHaveLength(0);
  });
});

ddescribe(
  'conversation_messages migration 3800 + store (real PostgreSQL)',
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
    const insert = (patch: Record<string, string>) => {
      const row = {
        sender_id: SENDER,
        wa_message_id: `wamid.${Math.random()}`,
        direction: 'IN',
        author: 'CUSTOMER',
        type: 'text',
        ...patch,
      };
      return pool.query(
        `INSERT INTO conversation_messages
         (sender_id, wa_message_id, direction, author, type, observed_at, purge_after)
       VALUES ($1, $2, $3, $4, $5, now(), now() + interval '12 months')`,
        [row.sender_id, row.wa_message_id, row.direction, row.author, row.type],
      );
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      uri = container.getConnectionUri();
      // Every migration on an empty database (later ones may follow 3800).
      migrate('up');
      pool = new Pool({ connectionString: uri });
    });

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    it('creates conversation_messages with its checks and indexes', async () => {
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'conversation_messages' ORDER BY column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'author',
        'created_at',
        'details',
        'direction',
        'id',
        'media',
        'observed_at',
        'provider_timestamp',
        'purge_after',
        'sender_id',
        'text',
        'type',
        'wa_message_id',
      ]);
      await expect(insert({ direction: 'SIDEWAYS' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert({ author: 'ROBOT' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert({ type: 'x'.repeat(33) })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert({ sender_id: 'abc' })).rejects.toMatchObject({
        code: '23514',
      });
      await insert({ wa_message_id: 'wamid.dup' });
      await expect(
        insert({ wa_message_id: 'wamid.dup' }),
      ).rejects.toMatchObject({ code: '23505' });
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'conversation_messages'`,
      );
      const defs = indexes.rows.map((row) => row.indexdef).join('\n');
      expect(defs).toMatch(/\(sender_id, observed_at\)/);
      expect(defs).toMatch(/\(purge_after\)/);
      await pool.query('TRUNCATE TABLE conversation_messages');
    });

    it('rolls back and re-applies', async () => {
      // Roll back 3800 and everything applied after it, then re-apply all.
      const applied = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pgmigrations
          WHERE name >= '3800000000000_conversation_transcript'`,
      );
      migrate('down', applied.rows[0].n);
      const gone = await pool.query(
        "SELECT to_regclass('conversation_messages') AS t",
      );
      expect(gone.rows[0]).toEqual({ t: null });
      migrate('up');
    });

    runTranscriptStoreContract('postgres', () =>
      Promise.resolve({
        store: new PostgresTranscriptStore(pool),
        cleanup: async () => {
          await pool.query('TRUNCATE TABLE conversation_messages');
        },
      }),
    );

    it('a message survives a new adapter instance (restart)', async () => {
      await new PostgresTranscriptStore(pool).append({
        senderId: SENDER,
        waMessageId: 'wamid.restart',
        direction: 'OUT',
        author: 'BOT',
        type: 'text',
        text: 'hola',
        observedAt: new Date('2026-11-09T16:00:00.000Z'),
      });
      await expect(
        new PostgresTranscriptStore(pool).listRecent(SENDER, 5),
      ).resolves.toMatchObject([
        { waMessageId: 'wamid.restart', text: 'hola' },
      ]);
      await pool.query('TRUNCATE TABLE conversation_messages');
    });
  },
);
