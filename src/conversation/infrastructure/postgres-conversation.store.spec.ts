import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
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

interface StoreCtor {
  new (pool: Pool): import('./postgres-conversation.store').PostgresConversationStore;
}

ddescribe('PostgresConversationStore (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let Store: StoreCtor;

  beforeAll(async () => {
    const require = createRequire(__filename);
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