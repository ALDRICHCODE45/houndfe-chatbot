import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ReceiptAmountPointer } from '../domain/conversation-store';
import { PostgresConversationStore } from './postgres-conversation.store';
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

  it('preserves the live receipt pointer during a stale update', async () => {
    const row = {
      sender_id: 'sender-a',
      last_message_at: new Date(),
      data: { receiptAmountPointer: pointer },
    };
    const pool = new FakePool([{ rows: [row] }, { rows: [row] }]);
    const store = new PostgresConversationStore(pool as unknown as Pool);
    await store.update('sender-a', {
      lastMessageAt: '2026-01-01T00:00:00.000Z',
    });
    const sql = pool.calls[1].sql;
    expect(sql).toMatch(/ON CONFLICT[\s\S]*EXCLUDED\.data/i);
    expect(sql).toMatch(/-\s*'receiptAmountPointer'/);
    expect(sql).toMatch(/conversation_state\.data/);
    expect(sql).toMatch(/jsonb_set\s*\(/i);
  });
});

interface StoreCtor {
  new (
    pool: Pool,
  ): import('./postgres-conversation.store').PostgresConversationStore;
}

ddescribe('PostgresConversationStore (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let Store: StoreCtor;

  beforeAll(async () => {
    const require = createRequire(__filename);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    Store = require('./postgres-conversation.store').PostgresConversationStore;

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    delete process.env.DB_POOL_MAX;

    // Apply the SAME migration the production binary would run —
    // no hand-rolled DDL, zero schema drift.
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });

    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
    delete process.env.DATABASE_URL;
  });

  // eslint-disable-next-line @typescript-eslint/require-await
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
});
