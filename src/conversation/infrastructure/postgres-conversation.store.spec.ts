import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type {
  PendingHumanRequest,
  ReceiptAmountPointer,
} from '../domain/conversation-store';
import { PostgresConversationStore } from './postgres-conversation.store';
import { InMemoryConversationStore } from './in-memory-conversation.store';
import { runConversationStoreContract } from './conversation-store.contract';

/**
 * Testcontainers-backed contract suite for PostgresConversationStore.
 *
 * Spec scenarios covered:
 *   - All 13 contract scenarios from runConversationStoreContract()
 *   - R2: State survives adapter instance restart (Postgres-only,
 *     per gate-review W1 — separate describe, NOT in the factory)
 *   - W2 lost-update window is documented in the adapter JSDoc.
 *
 * Gated by RUN_DOCKER_TESTS=1. Without the gate, this whole file is
 * skipped — `pnpm test` stays green without Docker. The adapter is
 * loaded lazily via createRequire under the gate so the spec file
 * resolves at compile time even when the implementation is absent.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

class FakePool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(
    private readonly results: number | { rows: unknown[]; rowCount?: number }[],
  ) {}
  query(sql: string, params: unknown[]) {
    this.calls.push({ sql, params });
    return Promise.resolve(
      typeof this.results === 'number'
        ? { rows: [], rowCount: this.results }
        : this.results.shift(),
    );
  }
}

describe('PostgresConversationStore receipt amount pointer SQL', () => {
  const pointer: ReceiptAmountPointer = {
    receiptMediaId: 'receipt-a',
    saleId: 'sale-a',
    receiptVersion: '9007199254740993',
  };
  it.each([
    ['setReceiptAmountPointer', 1, true],
    ['setReceiptAmountPointer', 0, false],
    ['clearReceiptAmountPointer', 1, true],
    ['clearReceiptAmountPointer', 0, false],
  ] as const)(
    '%s maps rowCount %i to %s with one UPDATE',
    async (method, count, expected) => {
      const pool = new FakePool(count);
      const store = new PostgresConversationStore(pool as unknown as Pool);
      expect(await store[method]('sender-a', pointer)).toBe(expected);
      expect(pool.calls).toHaveLength(1);
      const { sql, params } = pool.calls[0];
      expect(sql).toMatch(/^\s*UPDATE\s+conversation_state\b/i);
      expect(sql).toMatch(/\bWHERE\b[\s\S]*\bsender_id\s*=\s*\$\d+/i);
      expect(sql).not.toMatch(/\bSELECT\b|::numeric/i);
      expect(sql).toContain('receiptAmountPointer');
      expect(params).toEqual(
        expect.arrayContaining(['sender-a', ...Object.values(pointer)]),
      );
      if (method === 'setReceiptAmountPointer') {
        expect(sql).toMatch(/jsonb_set\s*\(|\|\|/i);
        expect(sql).toMatch(/\?\s*'receiptAmountPointer'/);
        expect(sql).toMatch(/(?:char_)?length\s*\(/i);
        expect(sql).toMatch(/COLLATE\s+"C"/i);
      } else {
        expect(sql).toMatch(/-\s*'receiptAmountPointer'/);
      }
    },
  );

  it('preserves live receipt + marker carve-outs during a stale update', async () => {
    const row = {
      sender_id: 'sender-a',
      last_message_at: new Date(),
      data: { receiptAmountPointer: pointer, pendingHumanRequest: null },
    };
    const pool = new FakePool([{ rows: [row] }, { rows: [row] }]);
    const store = new PostgresConversationStore(pool as unknown as Pool);
    await store.update('sender-a', {
      lastMessageAt: '2026-01-01T00:00:00.000Z',
    });
    const sql = pool.calls[1].sql;
    expect(sql).toMatch(/ON CONFLICT[\s\S]*EXCLUDED\.data/i);
    expect(sql).toMatch(/-\s*'receiptAmountPointer'/);
    expect(sql).toMatch(
      /\|\|\s*CASE\s+WHEN\s+conversation_state\.data\s*\?\s*'pendingHumanRequest'/i,
    );
    expect(sql).toMatch(/jsonb_build_object\(\s*'pendingHumanRequest'/i);
    expect(sql).toMatch(/ELSE\s+'\{\}'::jsonb/i);
    expect(sql).toMatch(/jsonb_set\s*\(/i);
  });
});

describe('PostgresConversationStore pending human request CAS SQL', () => {
  const marker: PendingHumanRequest = {
    requestId: 'abc123def456',
    ref: 'HF-abc123def456',
    createdAt: '2026-07-01T08:00:00.000Z',
    customerNotifiedAt: '2026-07-01T08:01:00.000Z',
  };
  const T = '2026-07-01T09:00:00.000Z';
  const casStore = (count: number) => {
    const pool = new FakePool(count);
    // SAFETY: FakePool implements the only `query` surface the store calls.
    const store = new PostgresConversationStore(pool as unknown as Pool);
    return { pool, store };
  };
  const REQUEST_ID = 'abc123def456';

  it.each([
    [1, true],
    [0, false],
  ] as const)(
    'setPendingHumanRequest maps rowCount %i to %s with one guarded UPSERT',
    async (count, expected) => {
      const { pool, store } = casStore(count);
      expect(await store.setPendingHumanRequest('sender-a', marker, T)).toBe(
        expected,
      );
      expect(pool.calls).toHaveLength(1);
      const { sql, params } = pool.calls[0];
      expect(sql).toMatch(/^\s*INSERT\s+INTO\s+conversation_state\b/i);
      expect(sql).toMatch(/ON CONFLICT\s*\(\s*sender_id\s*\)\s*DO UPDATE/i);
      expect(sql).toMatch(/\?\s*'pendingHumanRequest'/);
      expect(sql).toMatch(/'null'::jsonb/i);
      expect(sql).toMatch(/->'pendingHumanRequest'\s*=\s*\$3::jsonb/i);
      expect(sql).toMatch(/conversation_state\.data\s*\|\|/);
      expect(sql).not.toMatch(/\bSELECT\b/i);
      expect(params).toEqual(['sender-a', T, JSON.stringify(marker)]);
    },
  );

  it('clearPendingHumanRequest writes explicit JSON null via one conditional UPDATE', async () => {
    const { pool, store } = casStore(1);
    expect(
      await store.clearPendingHumanRequest('sender-a', marker.requestId, T),
    ).toBe(true);
    expect(pool.calls).toHaveLength(1);
    const { sql, params } = pool.calls[0];
    expect(sql).toMatch(/^\s*UPDATE\s+conversation_state\b/i);
    expect(sql).toMatch(/jsonb_set\s*\(\s*data,\s*'\{pendingHumanRequest\}'/i);
    expect(sql).toMatch(/'null'::jsonb/i);
    expect(sql).toMatch(/jsonb_typeof\s*\(/i);
    expect(sql).toMatch(/->>'requestId'\s*=\s*\$2/);
    expect(sql).toMatch(
      /data->'pendingHumanRequest'\s*=\s*jsonb_build_object\(\s*'requestId'/i,
    );
    expect(sql).not.toMatch(/\bINSERT\b|\bON CONFLICT\b/i);
    expect(params).toEqual(['sender-a', marker.requestId, T]);
    expect(sql).toContain('last_message_at = $3::timestamptz');
  });

  it('rejects malformed markers and invalid args without touching the pool', async () => {
    const { pool, store } = casStore(1);
    await expect(
      store.setPendingHumanRequest('sender-a', { ...marker, ref: '' }, T),
    ).resolves.toBe(false);
    await expect(
      store.clearPendingHumanRequest('sender-a', '', T),
    ).resolves.toBe(false);
    await expect(store.setPendingHumanRequest('', marker, T)).resolves.toBe(
      false,
    );
    expect(pool.calls).toHaveLength(0);
  });

  it.each([
    [1, true],
    [0, false],
  ] as const)(
    'clearPendingHumanRequest maps rowCount %i to %s with one UPDATE',
    async (count, expected) => {
      const pool = new FakePool(count);
      const store = new PostgresConversationStore(pool as unknown as Pool);
      expect(await store.clearPendingHumanRequest('sender-a', REQUEST_ID)).toBe(
        expected,
      );
      expect(pool.calls).toHaveLength(1);
      const { sql, params } = pool.calls[0];
      expect(sql).toMatch(/^\s*UPDATE\s+conversation_state\b/i);
      expect(sql).toMatch(/\bWHERE\b[\s\S]*\bsender_id\s*=\s*\$\d+/i);
      expect(sql).not.toMatch(/\bSELECT\b|ON\s+CONFLICT/i);
      expect(sql).toContain('pendingHumanRequest');
      expect(sql).toMatch(/jsonb_set\s*\(/i);
      expect(sql).toMatch(/'null'::jsonb/);
      expect(sql).toMatch(/jsonb_typeof\s*\(/i);
      expect(params).toEqual(['sender-a', REQUEST_ID]);
      expect(sql).not.toContain('last_message_at');
      expect(sql).toContain("->>'ref' = 'HF-' || $2");
    },
  );

  it.each(['', 'ABC123DEF456', 'abc123', 'zzzzzzzzzzzz'])(
    'clearPendingHumanRequest rejects %p without querying',
    async (requestId) => {
      const pool = new FakePool(1);
      const store = new PostgresConversationStore(pool as unknown as Pool);
      expect(await store.clearPendingHumanRequest('sender-a', requestId)).toBe(
        false,
      );
      expect(pool.calls).toHaveLength(0);
    },
  );

  it('clearPendingHumanRequest rejects an empty sender without querying', async () => {
    const pool = new FakePool(1);
    const store = new PostgresConversationStore(pool as unknown as Pool);
    expect(await store.clearPendingHumanRequest('', REQUEST_ID)).toBe(false);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('combined pending-marker clear overloads (offline)', () => {
  const before = '2026-07-01T08:00:00.000Z';
  const after = '2026-07-01T09:00:00.000Z';
  const marker = {
    requestId: 'abc123def456',
    ref: 'HF-abc123def456',
    createdAt: before,
    customerNotifiedAt: before,
  };

  it.each([undefined, null, '', 0, false])(
    'rejects explicitly supplied invalid timestamp %p in both adapters',
    async (timestamp) => {
      const memory = new InMemoryConversationStore();
      await memory.setPendingHumanRequest('sender', marker, before);
      const snapshot = structuredClone(await memory.get('sender'));
      const pool = new FakePool(1);
      const postgres = new PostgresConversationStore(pool as unknown as Pool);
      for (const store of [memory, postgres]) {
        // Reflective call deliberately supplies runtime-invalid input without
        // pretending it satisfies the public timestamp signature.
        const result: unknown = await Reflect.apply(
          store.clearPendingHumanRequest,
          store,
          ['sender', marker.requestId, timestamp],
        );
        expect(result).toBe(false);
      }
      expect(await memory.get('sender')).toEqual(snapshot);
      expect(pool.calls).toHaveLength(0);
    },
  );

  it('preserves structural legacy inputs while canonical clear rejects them', async () => {
    const store = new InMemoryConversationStore();
    const legacy = { ...marker, requestId: 'legacy-id', ref: 'legacy-ref' };
    await expect(
      store.setPendingHumanRequest('sender', legacy, before),
    ).resolves.toBe(true);
    await expect(
      store.clearPendingHumanRequest('sender', legacy.requestId),
    ).resolves.toBe(false);
    await expect(
      store.clearPendingHumanRequest('sender', legacy.requestId, after),
    ).resolves.toBe(true);
    expect(await store.get('sender')).toEqual({
      senderId: 'sender',
      lastMessageAt: after,
      data: { pendingHumanRequest: null },
    });
  });

  it('preserves timestamp and sibling state for canonical two-argument clear', async () => {
    const store = new InMemoryConversationStore();
    const siblings = {
      shippingApproval: { decision: 'SHIPPING_APPROVED' },
      placedSaleId: 'sale',
    };
    await store.create('sender', {
      lastMessageAt: before,
      data: { ...siblings, pendingHumanRequest: marker },
    });
    await expect(
      store.clearPendingHumanRequest('sender', marker.requestId),
    ).resolves.toBe(true);
    expect(await store.get('sender')).toEqual({
      senderId: 'sender',
      lastMessageAt: before,
      data: { ...siblings, pendingHumanRequest: null },
    });
  });
});

type StoreCtor =
  typeof import('./postgres-conversation.store').PostgresConversationStore;

ddescribe('PostgresConversationStore (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let Store: StoreCtor;

  beforeAll(async () => {
    const require = createRequire(__filename) as (
      moduleName: string,
    ) => typeof import('./postgres-conversation.store');
    Store = require('./postgres-conversation.store').PostgresConversationStore;

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.stderr.write(
      `[conversation-db] started owned container ${container.getId()}\n`,
    );
    const root = join(__dirname, '..', '..', '..');
    // Installed CLI only, pinned schema, owned URI, no inherited environment.
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
        '--config-file',
        'package.json',
        '--config-value',
        'pg-migrate',
        'up',
        '2600000000000',
        '--timestamp',
      ],
      {
        cwd: root,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );

    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) {
        await container.stop();
        process.stderr.write(
          `[conversation-db] stopped owned container ${container.getId()}\n`,
        );
      }
    }
  });

  runConversationStoreContract('PostgresConversationStore', async () => ({
    store: new Store(pool),
    cleanup: async () => {
      // Truncate between scenarios so each starts from a clean table.
      await pool.query('TRUNCATE TABLE conversation_state');
    },
  }));

  // R2: Postgres-only restart-survival — separate describe, NOT in the
  // shared factory (in-memory creates a fresh Map per instance and
  // would fail this assertion).
  describe('restart survival (Postgres-only, R2)', () => {
    it('reads back the same state through a fresh adapter instance', async () => {
      const writer = new Store(pool);
      await writer.create('wa-restart', {
        lastMessageAt: '2026-07-01T08:00:00.000Z',
        data: { messages: [{ role: 'user', content: 'persisto' }] },
      });

      const freshReader = new Store(pool);
      const read = await freshReader.get('wa-restart');

      expect(read).toEqual({
        senderId: 'wa-restart',
        lastMessageAt: '2026-07-01T08:00:00.000Z',
        data: { messages: [{ role: 'user', content: 'persisto' }] },
      });
    });
  });

  // T3c: explicit Postgres-only proofs for the CAS marker primitives and the
  // stale-`update()` carve-out. They mirror the shared contract's CAS
  // scenarios but assert against a disposable postgres:16-alpine row, so the
  // JSONB guards are exercised by the real engine instead of only by
  // SQL-shape regexes on a fake pool.
  describe('CAS marker + stale-update DB proof (T3c)', () => {
    const T = '2026-07-02T08:00:00.000Z';
    const T2 = '2026-07-02T09:00:00.000Z';
    const marker = (id: string): PendingHumanRequest => ({
      requestId: id,
      ref: `HF-${id}`,
      createdAt: T,
      customerNotifiedAt: T,
    });
    const pointer: ReceiptAmountPointer = {
      receiptMediaId: 'receipt-db-1',
      saleId: 'sale-db-1',
      receiptVersion: '9007199254740993',
    };

    beforeEach(async () => {
      await pool.query('TRUNCATE TABLE conversation_state');
    });

    it('first-contact set atomically inserts the marker UPSERT row', async () => {
      const store = new Store(pool);
      const m = marker('aaaa00001111');

      await expect(
        store.setPendingHumanRequest('db-first', m, T),
      ).resolves.toBe(true);

      const fetched = await store.get('db-first');
      expect(fetched).toEqual({
        senderId: 'db-first',
        lastMessageAt: T,
        data: { pendingHumanRequest: m },
      });
    });

    it('set allows an absent marker key and an explicit JSON null key', async () => {
      const store = new Store(pool);
      await store.create('db-absent', {
        lastMessageAt: T,
        data: { cart: ['sku-1'] },
      });
      await store.create('db-null', {
        lastMessageAt: T,
        data: { cart: ['sku-2'], pendingHumanRequest: null },
      });

      const mAbsent = marker('bbbb00001111');
      const mNull = marker('cccc00001111');
      await expect(
        store.setPendingHumanRequest('db-absent', mAbsent, T2),
      ).resolves.toBe(true);
      await expect(
        store.setPendingHumanRequest('db-null', mNull, T2),
      ).resolves.toBe(true);

      const absent = await store.get('db-absent');
      expect(absent!.data.pendingHumanRequest).toEqual(mAbsent);
      expect(absent!.data.cart).toEqual(['sku-1']);
      expect(absent!.lastMessageAt).toBe(T2);

      const nulled = await store.get('db-null');
      expect(nulled!.data.pendingHumanRequest).toEqual(mNull);
      expect(nulled!.data.cart).toEqual(['sku-2']);
      expect(nulled!.lastMessageAt).toBe(T2);
    });

    it('set replays the exact marker but refuses different or corrupt-active markers', async () => {
      const store = new Store(pool);
      const m1 = marker('dddd00001111');
      await expect(
        store.setPendingHumanRequest('db-replay', m1, T),
      ).resolves.toBe(true);

      await expect(
        store.setPendingHumanRequest('db-replay', m1, T2),
      ).resolves.toBe(true);
      const replayed = await store.get('db-replay');
      expect(replayed!.data.pendingHumanRequest).toEqual(m1);
      expect(replayed!.lastMessageAt).toBe(T2);

      const m2 = marker('eeee00001111');
      await expect(
        store.setPendingHumanRequest('db-replay', m2, T2),
      ).resolves.toBe(false);
      expect((await store.get('db-replay'))!.data.pendingHumanRequest).toEqual(
        m1,
      );

      await store.create('db-corrupt', {
        lastMessageAt: T,
        data: {
          pendingHumanRequest: {
            ...marker('ffff00001111'),
            x: 1,
          } as unknown as PendingHumanRequest,
        },
      });
      await expect(
        store.setPendingHumanRequest('db-corrupt', marker('1111aaaa2222'), T2),
      ).resolves.toBe(false);
      const corrupt = await store.get('db-corrupt');
      expect(
        (
          corrupt!.data.pendingHumanRequest as unknown as Record<
            string,
            unknown
          >
        ).x,
      ).toBe(1);
    });

    it('clear nulls the live marker only for an exact requestId', async () => {
      const store = new Store(pool);
      const m = marker('2222bbbb3333');
      await store.setPendingHumanRequest('db-clear', m, T);

      await expect(
        store.clearPendingHumanRequest('db-clear', 'wrong-request-id', T2),
      ).resolves.toBe(false);
      expect((await store.get('db-clear'))!.data.pendingHumanRequest).toEqual(
        m,
      );

      await expect(
        store.clearPendingHumanRequest('db-clear', m.requestId, T2),
      ).resolves.toBe(true);
      const cleared = await store.get('db-clear');
      expect(cleared!.data.pendingHumanRequest).toBeNull();
      expect(Object.hasOwn(cleared!.data, 'pendingHumanRequest')).toBe(true);
      expect(cleared!.lastMessageAt).toBe(T2);
    });

    it('structural three-argument clear accepts legacy shape and updates timestamp', async () => {
      const store = new Store(pool);
      const legacy = { ...marker('legacy-id'), ref: 'legacy-ref' };
      await expect(
        store.setPendingHumanRequest('db-legacy', legacy, T),
      ).resolves.toBe(true);
      await expect(
        store.clearPendingHumanRequest('db-legacy', legacy.requestId, T2),
      ).resolves.toBe(true);
      expect(await store.get('db-legacy')).toEqual({
        senderId: 'db-legacy',
        lastMessageAt: T2,
        data: { pendingHumanRequest: null },
      });
    });

    it('canonical two-argument clear preserves timestamp and siblings', async () => {
      const store = new Store(pool);
      const m = marker('abcd00001111');
      const siblings = {
        receiptAmountPointer: pointer,
        shippingApproval: { decision: 'SHIPPING_APPROVED' },
        cart: ['sku-1'],
      };
      await store.create('db-canonical', {
        lastMessageAt: T,
        data: { ...siblings, pendingHumanRequest: m },
      });
      await expect(
        store.clearPendingHumanRequest('db-canonical', m.requestId),
      ).resolves.toBe(true);
      expect(await store.get('db-canonical')).toEqual({
        senderId: 'db-canonical',
        lastMessageAt: T,
        data: { ...siblings, pendingHumanRequest: null },
      });
    });

    it('rejects a noncanonical ref and an explicitly invalid timestamp without clearing', async () => {
      const store = new Store(pool);
      const m = { ...marker('abcd00002222'), ref: 'wrong-ref' };
      await store.create('db-clear-invalid', {
        lastMessageAt: T,
        data: { pendingHumanRequest: m, cart: ['sku-1'] },
      });
      const before = await store.get('db-clear-invalid');
      await expect(
        store.clearPendingHumanRequest('db-clear-invalid', m.requestId),
      ).resolves.toBe(false);
      expect(await store.get('db-clear-invalid')).toEqual(before);
      const canonical = marker('abcd00003333');
      await store.create('db-invalid-time', {
        lastMessageAt: T,
        data: { pendingHumanRequest: canonical },
      });
      const original = await store.get('db-invalid-time');
      // Explicit runtime undefined is not the omitted two-argument overload.
      const cleared: unknown = await Reflect.apply(
        store.clearPendingHumanRequest,
        store,
        ['db-invalid-time', canonical.requestId, undefined],
      );
      expect(cleared).toBe(false);
      expect(await store.get('db-invalid-time')).toEqual(original);
    });

    it('clear fails closed on absent rows, keyless rows, and corrupt markers', async () => {
      const store = new Store(pool);
      const m = marker('3333cccc4444');

      await expect(
        store.clearPendingHumanRequest('db-never', m.requestId, T2),
      ).resolves.toBe(false);

      await store.create('db-keyless', {
        lastMessageAt: T,
        data: { cart: [] },
      });
      await expect(
        store.clearPendingHumanRequest('db-keyless', m.requestId, T2),
      ).resolves.toBe(false);

      await store.create('db-corrupt-clear', {
        lastMessageAt: T,
        data: {
          pendingHumanRequest: {
            ...m,
            x: 1,
          } as unknown as PendingHumanRequest,
        },
      });
      await expect(
        store.clearPendingHumanRequest('db-corrupt-clear', m.requestId, T2),
      ).resolves.toBe(false);
      expect(
        (await store.get('db-corrupt-clear'))!.data.pendingHumanRequest,
      ).not.toBeNull();
    });

    it('stale full-data update preserves the LIVE marker and cannot resurrect a cleared one', async () => {
      const store = new Store(pool);
      const live = marker('4444dddd5555');
      const stale = marker('5555eeee6666');
      await store.setPendingHumanRequest('db-stale', live, T);

      await store.update('db-stale', {
        lastMessageAt: T2,
        data: { cart: ['sku-1'], pendingHumanRequest: stale },
      });
      const afterSet = await store.get('db-stale');
      expect(afterSet!.data.pendingHumanRequest).toEqual(live);
      expect(afterSet!.data.cart).toEqual(['sku-1']);

      await expect(
        store.clearPendingHumanRequest('db-stale', live.requestId, T2),
      ).resolves.toBe(true);
      await store.update('db-stale', {
        lastMessageAt: T,
        data: { cart: ['sku-2'], pendingHumanRequest: stale },
      });
      const afterClear = await store.get('db-stale');
      expect(afterClear!.data.pendingHumanRequest).toBeNull();
      expect(Object.hasOwn(afterClear!.data, 'pendingHumanRequest')).toBe(true);
      expect(afterClear!.data.cart).toEqual(['sku-2']);
    });

    it('preserves the sibling receipt pointer across marker set, stale update, and clear', async () => {
      const store = new Store(pool);
      await store.create('db-siblings', {
        lastMessageAt: T,
        data: { cart: ['sku-1'] },
      });
      await expect(
        store.setReceiptAmountPointer('db-siblings', pointer),
      ).resolves.toBe(true);

      const live = marker('6666ffff7777');
      await store.setPendingHumanRequest('db-siblings', live, T2);

      await store.update('db-siblings', {
        lastMessageAt: T,
        data: { cart: ['sku-2'], pendingHumanRequest: live },
      });
      const afterUpdate = await store.get('db-siblings');
      expect(afterUpdate!.data.receiptAmountPointer).toEqual(pointer);
      expect(afterUpdate!.data.pendingHumanRequest).toEqual(live);

      await expect(
        store.clearPendingHumanRequest('db-siblings', live.requestId, T2),
      ).resolves.toBe(true);
      const afterClear = await store.get('db-siblings');
      expect(afterClear!.data.receiptAmountPointer).toEqual(pointer);
      expect(afterClear!.data.pendingHumanRequest).toBeNull();
    });

    it('serializes concurrent set/clear against a stale update with distinct Pool clients', async () => {
      const store = new Store(pool);
      // A second Pool proves distinct client connections. The CAS writers are
      // single-statement and the stale read-modify-write `update()` re-applies
      // the LIVE marker under the row lock, so the outcome below holds for
      // every interleaving (deterministic, not timing-tolerant).
      const otherPool = new Pool({
        connectionString: container.getConnectionUri(),
      });
      const other = new Store(otherPool);
      const live = marker('7777aaaa8888');
      const stale = marker('8888bbbb9999');

      try {
        await Promise.all([
          store.setPendingHumanRequest('db-race-set', live, T),
          other.update('db-race-set', {
            lastMessageAt: T2,
            data: { cart: ['sku-1'], pendingHumanRequest: stale },
          }),
        ]);
        const afterSet = await store.get('db-race-set');
        expect(afterSet!.data.pendingHumanRequest).toEqual(live);

        await store.setPendingHumanRequest('db-race-clear', live, T);
        await Promise.all([
          store.clearPendingHumanRequest('db-race-clear', live.requestId, T2),
          other.update('db-race-clear', {
            lastMessageAt: T2,
            data: { cart: ['sku-2'], pendingHumanRequest: stale },
          }),
        ]);
        const afterClear = await store.get('db-race-clear');
        expect(afterClear!.data.pendingHumanRequest).toBeNull();
        expect(Object.hasOwn(afterClear!.data, 'pendingHumanRequest')).toBe(
          true,
        );
      } finally {
        await otherPool.end();
      }
    });
  });
});
