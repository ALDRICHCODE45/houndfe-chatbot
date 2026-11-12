import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  laneForKind,
  type BackendOutboxCompletion,
  type ClaimedBackendOutboxEntry,
} from '../domain/backend-outbox';
import { runBackendOutboxStoreContract } from './backend-outbox-store.contract';
import {
  CLAIM_RUN_SQL,
  PostgresBackendOutboxStore,
} from './postgres-backend-outbox.store';

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
  it('enqueues in one transaction: key check, per-lane seq counter upsert, insert', async () => {
    const { pool, store } = fake([[], [], [{ seq: '3' }], [dbRow()], []]);
    const result = await store.enqueue({
      conversationRef: A,
      kind: 'REQUEST_CREATE',
      idempotencyKey: 'k',
      payload: { a: 1 },
    });
    expect(result).toMatchObject({ created: true, entry: { id: '7', seq: 3 } });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/WHERE idempotency_key = \$1/);
    expect(sqls[2]).toMatch(
      /ON CONFLICT \(conversation_ref, lane\) DO UPDATE[\s\S]*RETURNING next_seq - 1 AS seq/,
    );
    expect(pool.calls[2].params).toEqual([A, 'CONTROL']);
    expect(sqls[3]).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(pool.calls[3].params).toEqual([
      A,
      'CONTROL',
      '3',
      'REQUEST_CREATE',
      'k',
      '{"a":1}',
      0,
    ]);
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
    expect(sql).toMatch(/DISTINCT ON \(conversation_ref, lane\)/);
    expect(sql).toMatch(/ORDER BY conversation_ref, lane, seq/);
    expect(sql).toMatch(/FOR UPDATE OF o SKIP LOCKED/);
    expect(sql).toMatch(/date_trunc\('milliseconds', now\(\)\)/);
    expect(params).toEqual([20, 'o', 60_000]);
  });

  const claimed = (id: string, lease: Date) =>
    ({
      id,
      leaseOwner: 'o',
      leaseExpiresAt: lease,
    }) as ClaimedBackendOutboxEntry;

  it('claims a run behind a head with one statement (window run, same lease, head fence)', async () => {
    const lease = new Date('2026-11-09T00:01:00.000Z');
    const { pool, store } = fake([
      [
        dbRow({ id: '9', seq: '5', status: 'IN_FLIGHT' }),
        dbRow({ id: '8', seq: '4', status: 'IN_FLIGHT' }),
      ],
    ]);
    const run = await store.claimRun(claimed('8', lease), 'o2', 60_000, 50);
    expect(run.map((e) => e.seq)).toEqual([4, 5]);
    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND status = 'IN_FLIGHT'/);
    expect(sql).toMatch(/lease_expires_at = \$3::timestamptz\s+FOR UPDATE/);
    expect(sql).toMatch(/bool_and\(/);
    expect(sql).toMatch(/OVER \(ORDER BY o\.seq ROWS UNBOUNDED PRECEDING\)/);
    expect(sql).toMatch(/x\.lane = h\.lane/);
    expect(sql).toMatch(/LIMIT \$4::int/);
    expect(sql).toMatch(/date_trunc\('milliseconds', now\(\)\)/);
    expect(params).toEqual(['8', 'o', lease, 50, 'o2', 60_000]);
  });

  it('claimRun refuses invalid limits and tokens without a query', async () => {
    const { pool, store } = fake();
    const lease = new Date();
    await expect(
      store.claimRun(claimed('1', lease), 'o', 1, 0),
    ).resolves.toEqual([]);
    await expect(
      store.claimRun(claimed('1', new Date(Number.NaN)), 'o', 1, 5),
    ).resolves.toEqual([]);
    await expect(
      store.claimRun(claimed('1', lease), '', 1, 5),
    ).resolves.toEqual([]);
    expect(pool.calls).toHaveLength(0);
  });

  it('completes a mixed batch in ONE statement and reports per-row fencing', async () => {
    const lease = new Date('2026-11-09T00:01:00.000Z');
    const { pool, store } = fake([[{ ord: '1' }, { ord: '3' }]]);
    const result = await store.completeMany([
      { entry: claimed('1', lease), outcome: 'DONE' },
      { entry: claimed('2', lease), outcome: 'DEAD', error: 'bad' },
      {
        entry: claimed('3', lease),
        outcome: 'RETRY',
        delayMs: 1500.4,
        error: 'x',
      },
    ]);
    expect(result).toEqual([true, false, true]);
    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/FROM unnest\(\$1::bigint\[\]/);
    expect(sql).toMatch(
      /o\.lease_owner = v\.owner\s+AND o\.lease_expires_at = v\.lease/,
    );
    expect(params).toEqual([
      ['1', '2', '3'],
      ['o', 'o', 'o'],
      [lease.toISOString(), lease.toISOString(), lease.toISOString()],
      ['DONE', 'DEAD', 'RETRY'],
      ['', 'bad', 'x'],
      [0, 0, 1500],
    ]);
    await expect(store.completeMany([])).resolves.toEqual([]);
    expect(pool.calls).toHaveLength(1);
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

ddescribe(
  'backend_outbox migrations 3900/4400 + store (real PostgreSQL)',
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
          lane: "'MIRROR'",
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
      await expect(insert({ status: "'DONE'" })).rejects.toMatchObject(
        violation,
      );
      await insert({});
      await expect(insert({ seq: '2' })).rejects.toMatchObject({
        code: '23505',
      });
      await expect(insert({ idempotency_key: "'k2'" })).rejects.toMatchObject({
        code: '23505',
      });
      await truncate();
    });

    it('4400 adds a lane that must match the kind, with seq unique per lane', async () => {
      const insert = (kind: string, lane: string, seq: number, key: string) =>
        pool.query(
          `INSERT INTO backend_outbox
           (conversation_ref, seq, kind, lane, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
          [A, seq, kind, lane, key],
        );
      const violation = { code: '23514' };
      await expect(
        insert('MESSAGE_MIRROR', 'CONTROL', 1, 'x1'),
      ).rejects.toMatchObject(violation);
      await expect(
        insert('REQUEST_CREATE', 'MIRROR', 1, 'x2'),
      ).rejects.toMatchObject(violation);
      await expect(
        insert('SESSION_ACK', 'NOPE', 1, 'x3'),
      ).rejects.toMatchObject(violation);
      // The lane is mandatory.
      await expect(
        pool.query(
          `INSERT INTO backend_outbox (conversation_ref, seq, kind, idempotency_key, payload)
         VALUES ($1, 1, 'MESSAGE_MIRROR', 'x4', '{}'::jsonb)`,
          [A],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      // Same seq in different lanes is fine; within one lane it collides.
      await insert('MESSAGE_MIRROR', 'MIRROR', 1, 'm1');
      await insert('REQUEST_CREATE', 'CONTROL', 1, 'c1');
      await expect(
        insert('MESSAGE_STATUS', 'MIRROR', 1, 'm2'),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        pool.query(
          `INSERT INTO backend_outbox_sequences (conversation_ref, lane, next_seq)
         VALUES ($1, 'NOPE', 2)`,
          [A],
        ),
      ).rejects.toMatchObject(violation);
      await truncate();
    });

    it('4400 refuses to roll back while rows exist, rolls back empty and re-applies', async () => {
      const store = new PostgresBackendOutboxStore(pool);
      await store.enqueue({
        conversationRef: A,
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'keep',
        payload: {},
      });
      await store.enqueue({
        conversationRef: A,
        kind: 'REQUEST_CREATE',
        idempotencyKey: 'keep-control',
        payload: {},
      });
      // Roll back 4400 and everything applied after it.
      const appliedFrom4400 = async () => {
        const applied = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pgmigrations
          WHERE name >= '4400000000000_backend_outbox_lanes'`,
        );
        return applied.rows[0].n;
      };
      // Later migrations roll back cleanly; 4400 itself must refuse.
      const withRows = await appliedFrom4400();
      expect(() => migrate('down', withRows)).toThrow();
      await pool.query('DELETE FROM backend_outbox');
      migrate('down', await appliedFrom4400());
      const lane = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name IN ('backend_outbox', 'backend_outbox_sequences')
          AND column_name = 'lane'`,
      );
      expect(lane.rows[0]).toEqual({ n: 0 });
      // Counters collapsed to the highest lane counter: seq is never reused.
      const counters = await pool.query(
        'SELECT conversation_ref, next_seq::int AS next_seq FROM backend_outbox_sequences',
      );
      expect(counters.rows).toEqual([{ conversation_ref: A, next_seq: 2 }]);
      migrate('up');
      const after = await store.enqueue({
        conversationRef: A,
        kind: 'REQUEST_CANCEL',
        idempotencyKey: 'after',
        payload: {},
      });
      expect(after.entry.seq).toBe(2);
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
      const gone = await pool.query(
        "SELECT to_regclass('backend_outbox') AS t",
      );
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
      // Even n go to the MIRROR lane, odd n to the CONTROL lane.
      const perConversation = 16;
      const perLane = perConversation / 2;
      const kindOf = (n: number) =>
        n % 2 === 0 ? 'MESSAGE_MIRROR' : 'REQUEST_CREATE';
      for (let n = 0; n < perConversation; n++)
        for (const ref of conversations)
          await store.enqueue({
            conversationRef: ref,
            kind: kindOf(n),
            idempotencyKey: `${ref}:${n}`,
            payload: { n },
          });
      const total = conversations.length * perConversation;
      const held = new Set<string>();
      const delivered: Array<{ ref: string; lane: string; seq: number }> = [];
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
              WHERE conversation_ref = $1 AND lane = $2 AND seq < $3
                AND status NOT IN ('DONE', 'DEAD')`,
              [entry.conversationRef, laneForKind(entry.kind), entry.seq],
            );
            if (open.rows[0].n !== 0)
              violations.push(
                `${entry.conversationRef}#${entry.seq} ahead of open seq`,
              );
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 3),
          );
          for (const entry of claimed) {
            // Every 5th row fails permanently: the next seq must still wait for it.
            const ok =
              entry.seq % 5 === 0
                ? await store.markDead(entry, '422')
                : await store.markDone(entry);
            if (!ok) violations.push(`lost lease ${entry.id}`);
            held.delete(entry.id);
            delivered.push({
              ref: entry.conversationRef,
              lane: laneForKind(entry.kind),
              seq: entry.seq,
            });
          }
        }
      };

      await Promise.all([claimer('claimer-a'), claimer('claimer-b')]);
      expect(violations).toEqual([]);
      expect(delivered).toHaveLength(total);
      for (const ref of conversations)
        for (const lane of ['MIRROR', 'CONTROL'])
          expect(
            delivered
              .filter((d) => d.ref === ref && d.lane === lane)
              .map((d) => d.seq),
          ).toEqual(Array.from({ length: perLane }, (_, i) => i + 1));
      await truncate();
    });

    describe('claimRun / completeMany races (separate connections)', () => {
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      const CLAIM_RUN_PATTERN = '%WITH head AS%';
      const COMPLETE_MANY_PATTERN = '%unnest(%';

      afterEach(async () => {
        await truncate();
      });

      /** Waits until `count` backends run a statement matching `pattern` and
       * are blocked on a lock: forces the interleaving without sleeping. */
      const waitForLockWaiters = async (count: number, pattern: string) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const { rows } = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE $1`,
            [pattern],
          );
          if (rows[0].n >= count) return;
          await sleep(25);
        }
        throw new Error(`no ${count} lock waiter(s) for ${pattern}`);
      };

      /** A transaction on its own connection that holds row locks (the "gate"). */
      const openGate = async (ids: string[]) => {
        const client = await pool.connect();
        await client.query('BEGIN');
        for (const id of ids)
          await client.query(
            'SELECT id FROM backend_outbox WHERE id = $1 FOR UPDATE',
            [id],
          );
        return {
          lock: (id: string) =>
            client.query(
              'SELECT id FROM backend_outbox WHERE id = $1 FOR UPDATE',
              [id],
            ),
          release: async () => {
            try {
              await client.query('COMMIT');
            } finally {
              client.release();
            }
          },
        };
      };

      const mirrors = async (
        store: PostgresBackendOutboxStore,
        ref: string,
        count: number,
      ) => {
        for (let n = 1; n <= count; n++)
          await store.enqueue({
            conversationRef: ref,
            kind: 'MESSAGE_MIRROR',
            idempotencyKey: `${ref}:${n}`,
            payload: { n },
          });
      };

      /** W1 leased the whole run and stalled past its lease; W2 reclaimed the
       * head. W1 still holds fencing tokens that match every follower. */
      const staleRun = async (
        store: PostgresBackendOutboxStore,
        ref: string,
        followers = 3,
      ) => {
        await mirrors(store, ref, followers + 1);
        const first = (await store.claimHeads(50, 'w1', 60_000)).find(
          (e) => e.conversationRef === ref,
        )!;
        const run1 = await store.claimRun(first, 'w1', 1, 50);
        expect(run1).toHaveLength(followers + 1);
        await sleep(15);
        const head2 = (await store.claimHeads(50, 'w2', 60_000)).find(
          (e) => e.conversationRef === ref,
        )!;
        expect(head2.id).toBe(run1[0].id);
        return { stale: run1.slice(1), head2 };
      };

      const states = async (ids: string[]) => {
        const { rows } = await pool.query<{
          id: string;
          status: string;
          lease_owner: string | null;
          delayed: boolean;
        }>(
          `SELECT id::text, status, lease_owner, next_attempt_at > now() AS delayed
          FROM backend_outbox WHERE id = ANY($1::bigint[])`,
          [ids],
        );
        return new Map(rows.map((row) => [row.id, row]));
      };

      const FINAL = { DONE: 'DONE', DEAD: 'DEAD', RETRY: 'PENDING' } as const;
      const complete = (
        entry: ClaimedBackendOutboxEntry,
        outcome: keyof typeof FINAL,
      ): BackendOutboxCompletion =>
        outcome === 'DONE'
          ? { entry, outcome }
          : outcome === 'DEAD'
            ? { entry, outcome, error: 'boom' }
            : { entry, outcome, error: 'later', delayMs: 60_000 };

      /** Exactly one owner per row: either the stale holder's completion was
       * applied (row final, never re-leased) or it was fenced and the new
       * holder owns the row under its own lease. */
      const expectExclusive = async (
        stale: ClaimedBackendOutboxEntry[],
        results: boolean[],
        outcome: keyof typeof FINAL,
        run2: ClaimedBackendOutboxEntry[],
      ) => {
        const inRun2 = new Set(run2.map((e) => e.id));
        const rows = await states(stale.map((e) => e.id));
        stale.forEach((entry, index) => {
          const row = rows.get(entry.id)!;
          if (results[index]) {
            expect(inRun2.has(entry.id)).toBe(false);
            expect(row.status).toBe(FINAL[outcome]);
            expect(row.lease_owner).toBeNull();
            if (outcome === 'RETRY') expect(row.delayed).toBe(true);
          } else {
            expect(inRun2.has(entry.id)).toBe(true);
            expect(row.status).toBe('IN_FLIGHT');
            expect(row.lease_owner).toBe('w2');
          }
        });
      };

      it('two claimRun calls on the same head claim disjoint rows (the loser gets none)', async () => {
        const store = new PostgresBackendOutboxStore(pool);
        await mirrors(store, A, 6);
        const [head] = await store.claimHeads(50, 'w0', 60_000);
        const gate = await openGate([head.id]);
        const runs = [
          store.claimRun(head, 'wa', 60_000, 50),
          store.claimRun(head, 'wb', 60_000, 50),
        ];
        await waitForLockWaiters(2, CLAIM_RUN_PATTERN);
        await gate.release();
        const [first, second] = await Promise.all(runs);
        const ids = [...first, ...second].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([first.length, second.length].sort()).toEqual([0, 6]);
        const owned = await pool.query<{ lease_owner: string }>(
          'SELECT DISTINCT lease_owner FROM backend_outbox',
        );
        expect(owned.rows).toHaveLength(1);
      });

      it('two workers draining the same lanes in runs never overlap nor skip an open seq', async () => {
        const store = new PostgresBackendOutboxStore(pool);
        const refs = Array.from({ length: 4 }, (_, i) => `wa:52155500001${i}0`);
        const perRef = 24;
        for (const ref of refs) await mirrors(store, ref, perRef);
        const total = refs.length * perRef;
        const held = new Set<string>();
        const delivered: Array<{ ref: string; seq: number }> = [];
        const violations: string[] = [];
        const worker = async (owner: string) => {
          let idle = 0;
          while (delivered.length < total && idle < 50) {
            const heads = await store.claimHeads(3, owner, 60_000);
            if (heads.length === 0) {
              idle++;
              await sleep(2);
              continue;
            }
            idle = 0;
            for (const head of heads) {
              const run = await store.claimRun(head, owner, 60_000, 5);
              if (run.length === 0) violations.push(`empty run ${head.id}`);
              for (const entry of run) {
                if (held.has(entry.id))
                  violations.push(`double claim ${entry.id}`);
                held.add(entry.id);
              }
              const open = await pool.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM backend_outbox
                WHERE conversation_ref = $1 AND seq < $2
                  AND status NOT IN ('DONE', 'DEAD')`,
                [head.conversationRef, run[0]?.seq ?? head.seq],
              );
              if (open.rows[0].n !== 0)
                violations.push(`${head.conversationRef} skipped an open seq`);
              await sleep(Math.random() * 3);
              const results = await store.completeMany(
                run.map((entry) => ({ entry, outcome: 'DONE' as const })),
              );
              run.forEach((entry, index) => {
                if (!results[index]) violations.push(`lost lease ${entry.id}`);
                held.delete(entry.id);
                delivered.push({ ref: entry.conversationRef, seq: entry.seq });
              });
            }
          }
        };
        await Promise.all([worker('wa'), worker('wb')]);
        expect(violations).toEqual([]);
        expect(delivered).toHaveLength(total);
        for (const ref of refs)
          expect(
            delivered.filter((d) => d.ref === ref).map((d) => d.seq),
          ).toEqual(Array.from({ length: perRef }, (_, i) => i + 1));
      });

      it.each(['DONE', 'DEAD', 'RETRY'] as const)(
        'a follower the stale holder completed (%s) is never re-leased by the new holder',
        async (outcome) => {
          const store = new PostgresBackendOutboxStore(pool);
          const { stale, head2 } = await staleRun(store, A);
          const gate = await openGate([stale[0].id]);
          const w1 = store.completeMany(
            stale.map((entry) => complete(entry, outcome)),
          );
          await waitForLockWaiters(1, COMPLETE_MANY_PATTERN);
          const w2 = store.claimRun(head2, 'w2', 60_000, 50);
          await waitForLockWaiters(1, CLAIM_RUN_PATTERN);
          await gate.release();
          const [results, run2] = await Promise.all([w1, w2]);
          expect(results).toEqual([true, true, true]);
          await expectExclusive(stale, results, outcome, run2);
          // Nothing past a row that is no longer claimable may be taken.
          expect(run2.map((e) => e.id)).toEqual([head2.id]);
        },
      );

      it.each(['DONE', 'DEAD', 'RETRY'] as const)(
        'once the new holder claimed the run first, the stale holder is fenced (%s)',
        async (outcome) => {
          const store = new PostgresBackendOutboxStore(pool);
          const { stale, head2 } = await staleRun(store, A);
          const gate = await openGate([stale[0].id]);
          const w2 = store.claimRun(head2, 'w2', 60_000, 50);
          await waitForLockWaiters(1, CLAIM_RUN_PATTERN);
          const w1 = store.completeMany(
            stale.map((entry) => complete(entry, outcome)),
          );
          await waitForLockWaiters(1, COMPLETE_MANY_PATTERN);
          await gate.release();
          const [results, run2] = await Promise.all([w1, w2]);
          expect(results).toEqual([false, false, false]);
          expect(run2.map((e) => e.id)).toEqual([
            head2.id,
            ...stale.map((e) => e.id),
          ]);
          await expectExclusive(stale, results, outcome, run2);
        },
      );

      it('does not claim rows behind a follower the stale holder rescheduled (head-of-line)', async () => {
        const store = new PostgresBackendOutboxStore(pool);
        const { stale, head2 } = await staleRun(store, A);
        const gate = await openGate([stale[0].id]);
        const w1 = store.completeMany([complete(stale[0], 'RETRY')]);
        await waitForLockWaiters(1, COMPLETE_MANY_PATTERN);
        const w2 = store.claimRun(head2, 'w2', 60_000, 50);
        await waitForLockWaiters(1, CLAIM_RUN_PATTERN);
        await gate.release();
        const [results, run2] = await Promise.all([w1, w2]);
        expect(results).toEqual([true]);
        expect(run2.map((e) => e.id)).toEqual([head2.id]);
        const rows = await states(stale.map((e) => e.id));
        expect(rows.get(stale[0].id)).toMatchObject({
          status: 'PENDING',
          delayed: true,
        });
        for (const entry of stale.slice(1))
          expect(rows.get(entry.id)).toMatchObject({
            status: 'IN_FLIGHT',
            lease_owner: 'w1',
          });
      });

      it('the run query reads the lane through backend_outbox_open_heads_idx', async () => {
        const store = new PostgresBackendOutboxStore(pool);
        for (const ref of [A, 'wa:5215550002222', 'wa:5215550003333'])
          await mirrors(store, ref, 20);
        await pool.query('ANALYZE backend_outbox');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Tiny tables prefer a seq scan; this asks which index would serve.
          await client.query('SET LOCAL enable_seqscan = off');
          await client.query(
            `PREPARE run_plan(bigint, text, timestamptz, int, text, double precision)
            AS ${CLAIM_RUN_SQL}`,
          );
          const plan = await client.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN EXECUTE run_plan(1, 'w', now(), 50, 'w', 60000)`,
          );
          const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
          expect(text).toMatch(/backend_outbox_open_heads_idx/);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });

      it('completeMany locks rows in ascending seq whatever the input order (no deadlock with a claimRun-style locker)', async () => {
        const store = new PostgresBackendOutboxStore(pool);
        await mirrors(store, A, 3);
        const [head] = await store.claimHeads(50, 'w1', 60_000);
        const run = await store.claimRun(head, 'w1', 60_000, 50);
        expect(run).toHaveLength(3);
        // The other locker takes seq 2 then seq 3, like claimRun does.
        const gate = await openGate([run[1].id]);
        const completion = store.completeMany(
          [...run]
            .reverse()
            .map((entry) => ({ entry, outcome: 'DONE' as const })),
        );
        await waitForLockWaiters(1, COMPLETE_MANY_PATTERN);
        // Descending-order locking would already hold seq 3 here: deadlock.
        await gate.lock(run[2].id);
        await gate.release();
        await expect(completion).resolves.toEqual([true, true, true]);
      });

      it('concurrent stale completeMany (descending) and claimRun never deadlock and stay consistent', async () => {
        const store = new PostgresBackendOutboxStore(pool);
        const refs = Array.from({ length: 16 }, (_, i) => `wa:52155500002${i}`);
        for (const ref of refs) await mirrors(store, ref, 7);
        const first = await store.claimHeads(50, 'w1', 60_000);
        const runs1 = await Promise.all(
          first.map((head) => store.claimRun(head, 'w1', 1, 50)),
        );
        await sleep(15);
        const heads2 = await store.claimHeads(50, 'w2', 60_000);
        expect(heads2).toHaveLength(refs.length);
        const outcomes = ['DONE', 'DEAD', 'RETRY'] as const;
        const jobs = runs1.map((run1, index) => {
          const stale = run1.slice(1);
          const outcome = outcomes[index % outcomes.length];
          const head2 = heads2.find((h) => h.id === run1[0].id)!;
          return {
            stale,
            outcome,
            w1: store.completeMany(
              [...stale].reverse().map((entry) => complete(entry, outcome)),
            ),
            w2: store.claimRun(head2, 'w2', 60_000, 50),
          };
        });
        const settled = await Promise.allSettled(
          jobs.flatMap((job) => [job.w1, job.w2]),
        );
        const rejected = settled.flatMap((s) =>
          s.status === 'rejected' ? [String(s.reason)] : [],
        );
        expect(rejected).toEqual([]);
        for (const job of jobs) {
          const reversed = await job.w1;
          const results = [...reversed].reverse();
          await expectExclusive(job.stale, results, job.outcome, await job.w2);
        }
      });
    });
  },
);
