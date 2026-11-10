import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ClaimedBackendOutboxEntry } from '../domain/backend-outbox';
import { runBackendOutboxStoreContract } from './backend-outbox-store.contract';
import { PostgresBackendOutboxStore } from './postgres-backend-outbox.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const A = 'wa:5215550001111';

class FakePool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly rows: unknown[][] = []) {}
  query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    const rows = this.rows.shift() ?? [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  connect() {
    return Promise.resolve({ query: this.query.bind(this), release() {} });
  }
}

const fake = (rows: unknown[][] = []) => {
  const pool = new FakePool(rows);
  // SAFETY: FakePool implements the only query/connect surface the store calls.
  return {
    pool,
    store: new PostgresBackendOutboxStore(pool as unknown as Pool),
  };
};

const dbRow = (overrides: Record<string, unknown> = {}) => ({
  id: '7',
  conversation_ref: A,
  seq: '3',
  kind: 'MESSAGE_MIRROR',
  idempotency_key: 'k',
  payload: { a: 1 },
  status: 'PENDING',
  attempts: 0,
  next_attempt_at: new Date('2026-11-09T00:00:00.000Z'),
  lease_owner: null,
  lease_expires_at: null,
  last_error: null,
  created_at: new Date('2026-11-09T00:00:00.000Z'),
  done_at: null,
  ...overrides,
});

describe('PostgresBackendOutboxStore SQL (no database)', () => {
  it('enqueues in one transaction: key check, seq counter upsert, insert', async () => {
    const { pool, store } = fake([[], [], [{ seq: '3' }], [dbRow()], []]);
    const result = await store.enqueue({
      conversationRef: A,
      kind: 'MESSAGE_MIRROR',
      idempotencyKey: 'k',
      payload: { a: 1 },
    });
    expect(result).toMatchObject({ created: true, entry: { id: '7', seq: 3 } });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/WHERE idempotency_key = \$1/);
    expect(sqls[2]).toMatch(
      /ON CONFLICT \(conversation_ref\) DO UPDATE[\s\S]*RETURNING next_seq - 1 AS seq/,
    );
    expect(sqls[3]).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(sqls[4]).toBe('COMMIT');
  });

  it('joins a caller-provided client without BEGIN/COMMIT', async () => {
    const { pool, store } = fake();
    const client = new FakePool([[dbRow()]]);
    // SAFETY: only `query` is used on a joined client.
    const result = await store.enqueue(
      {
        conversationRef: A,
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'k',
        payload: { a: 1 },
      },
      client as never,
    );
    expect(result.created).toBe(false);
    expect(client.calls).toHaveLength(1);
    expect(pool.calls).toHaveLength(0);
  });

  it('claims heads with SKIP LOCKED and a ms-truncated lease', async () => {
    const { pool, store } = fake([
      [
        dbRow({
          status: 'IN_FLIGHT',
          lease_owner: 'o',
          lease_expires_at: new Date(),
        }),
      ],
    ]);
    const claimed = await store.claimHeads(20, 'o', 60_000);
    expect(claimed).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/DISTINCT ON \(conversation_ref\)/);
    expect(sql).toMatch(/FOR UPDATE OF o SKIP LOCKED/);
    expect(sql).toMatch(/date_trunc\('milliseconds', now\(\)\)/);
    expect(params).toEqual([20, 'o', 60_000]);
  });

  it('fences completion by owner and lease token', async () => {
    const { pool, store } = fake([[]]);
    const lease = new Date('2026-11-09T00:01:00.000Z');
    const entry = {
      id: '7',
      leaseOwner: 'o',
      leaseExpiresAt: lease,
    } as ClaimedBackendOutboxEntry;
    await expect(store.markDone(entry)).resolves.toBe(false);
    expect(pool.calls[0].sql).toMatch(
      /lease_owner = \$2\s+AND lease_expires_at = \$3::timestamptz/,
    );
    expect(pool.calls[0].params).toEqual(['7', 'o', lease]);
  });
});

ddescribe('backend_outbox migration 3900 + store (real PostgreSQL)', () => {
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
  const truncate = () =>
    pool.query('TRUNCATE TABLE backend_outbox, backend_outbox_sequences');

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    migrate('up');
    pool = new Pool({ connectionString: uri, max: 20 });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('creates backend_outbox with its checks', async () => {
    const insert = (values: Record<string, string>) => {
      const row = {
        conversation_ref: `'${A}'`,
        seq: '1',
        kind: "'MESSAGE_MIRROR'",
        idempotency_key: "'k'",
        payload: "'{}'::jsonb",
        ...values,
      };
      return pool.query(
        `INSERT INTO backend_outbox (${Object.keys(row).join(', ')})
         VALUES (${Object.values(row).join(', ')})`,
      );
    };
    const violation = { code: '23514' };
    await expect(
      insert({ conversation_ref: "'5215550001111'" }),
    ).rejects.toMatchObject(violation);
    await expect(insert({ kind: "'NOPE'" })).rejects.toMatchObject(violation);
    await expect(insert({ payload: "'[]'::jsonb" })).rejects.toMatchObject(
      violation,
    );
    await expect(insert({ status: "'IN_FLIGHT'" })).rejects.toMatchObject(
      violation,
    );
    await expect(insert({ status: "'DONE'" })).rejects.toMatchObject(violation);
    await insert({});
    await expect(insert({ seq: '2' })).rejects.toMatchObject({ code: '23505' });
    await expect(insert({ idempotency_key: "'k2'" })).rejects.toMatchObject({
      code: '23505',
    });
    await truncate();
  });

  it('refuses to roll back while rows exist, rolls back empty and re-applies', async () => {
    const store = new PostgresBackendOutboxStore(pool);
    await store.enqueue({
      conversationRef: A,
      kind: 'SESSION_ACK',
      idempotencyKey: 'keep',
      payload: {},
    });
    // Roll back 3900 and everything applied after it, so later migrations
    // never make this test roll back the wrong file.
    const appliedFrom3900 = async () => {
      const applied = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pgmigrations
          WHERE name >= '3900000000000_backend_outbox'`,
      );
      return applied.rows[0].n;
    };
    const count = await appliedFrom3900();
    expect(() => migrate('down', count)).toThrow();
    await truncate();
    migrate('down', await appliedFrom3900());
    const gone = await pool.query("SELECT to_regclass('backend_outbox') AS t");
    expect(gone.rows[0]).toEqual({ t: null });
    migrate('up');
  });

  runBackendOutboxStoreContract('postgres', () =>
    Promise.resolve({
      store: new PostgresBackendOutboxStore(pool),
      cleanup: async () => {
        await truncate();
      },
    }),
  );

  it('an enqueue joined to a rolled-back caller transaction leaves nothing', async () => {
    const store = new PostgresBackendOutboxStore(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await store.enqueue(
        {
          conversationRef: A,
          kind: 'REQUEST_CREATE',
          idempotencyKey: 'r1',
          payload: {},
        },
        client,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM backend_outbox',
    );
    expect(rows[0]).toEqual({ n: 0 });
    await truncate();
  });

  it('concurrent enqueues to one conversation get distinct consecutive seqs', async () => {
    const store = new PostgresBackendOutboxStore(pool);
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        store.enqueue({
          conversationRef: A,
          kind: 'MESSAGE_MIRROR',
          idempotencyKey: `c${i}`,
          payload: {},
        }),
      ),
    );
    expect(results.map((r) => r.entry.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    // Same key raced from many callers: exactly one row is created.
    const dupes = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.enqueue({
          conversationRef: A,
          kind: 'MESSAGE_MIRROR',
          idempotencyKey: 'same',
          payload: {},
        }),
      ),
    );
    expect(dupes.filter((d) => d.created)).toHaveLength(1);
    expect(new Set(dupes.map((d) => d.entry.id)).size).toBe(1);
    await truncate();
  });

  it('two concurrent claimers never share a row nor skip ahead of an open seq', async () => {
    const store = new PostgresBackendOutboxStore(pool);
    const conversations = Array.from(
      { length: 6 },
      (_, i) => `wa:52155500000${i + 10}`,
    );
    const perConversation = 8;
    for (let n = 0; n < perConversation; n++)
      for (const ref of conversations)
        await store.enqueue({
          conversationRef: ref,
          kind: 'MESSAGE_MIRROR',
          idempotencyKey: `${ref}:${n}`,
          payload: { n },
        });
    const total = conversations.length * perConversation;
    const held = new Set<string>();
    const delivered: Array<{ ref: string; seq: number }> = [];
    const violations: string[] = [];

    const claimer = async (owner: string) => {
      let idle = 0;
      while (delivered.length < total && idle < 50) {
        const claimed = await store.claimHeads(3, owner, 60_000);
        if (claimed.length === 0) {
          idle++;
          await new Promise((resolve) => setTimeout(resolve, 2));
          continue;
        }
        idle = 0;
        for (const entry of claimed) {
          if (held.has(entry.id)) violations.push(`double claim ${entry.id}`);
          held.add(entry.id);
          const open = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM backend_outbox
              WHERE conversation_ref = $1 AND seq < $2
                AND status NOT IN ('DONE', 'DEAD')`,
            [entry.conversationRef, entry.seq],
          );
          if (open.rows[0].n !== 0)
            violations.push(
              `${entry.conversationRef}#${entry.seq} ahead of open seq`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
        for (const entry of claimed) {
          // Every 5th row fails permanently: the next seq must still wait for it.
          const ok =
            entry.seq % 5 === 0
              ? await store.markDead(entry, '422')
              : await store.markDone(entry);
          if (!ok) violations.push(`lost lease ${entry.id}`);
          held.delete(entry.id);
          delivered.push({ ref: entry.conversationRef, seq: entry.seq });
        }
      }
    };

    await Promise.all([claimer('claimer-a'), claimer('claimer-b')]);
    expect(violations).toEqual([]);
    expect(delivered).toHaveLength(total);
    for (const ref of conversations)
      expect(delivered.filter((d) => d.ref === ref).map((d) => d.seq)).toEqual(
        Array.from({ length: perConversation }, (_, i) => i + 1),
      );
    await truncate();
  });
});
