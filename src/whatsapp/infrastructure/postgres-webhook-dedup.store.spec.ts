import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runWebhookDedupContract } from './webhook-dedup.contract';

/**
 * Testcontainers-backed contract suite for PostgresWebhookDedupStore.
 *
 * Applies the SAME migration the production binary runs (zero schema
 * drift) and verifies the store survives a restart via fresh instances.
 *
 * Gated by RUN_DOCKER_TESTS=1 — without the gate the file is skipped and
 * `pnpm test` stays green without Docker (mirrors the conversation store
 * spec).
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

interface StoreCtor {
  new (pool: Pool): import('./postgres-webhook-dedup.store').PostgresWebhookDedupStore;
}

ddescribe('PostgresWebhookDedupStore (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let Store: StoreCtor;

  beforeAll(async () => {
    const require = createRequire(__filename);
    Store = require('./postgres-webhook-dedup.store').PostgresWebhookDedupStore;

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    delete process.env.DB_POOL_MAX;

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

  runWebhookDedupContract('PostgresWebhookDedupStore', async () => ({
    store: new Store(pool),
    cleanup: async () => {
      await pool.query('TRUNCATE TABLE processed_webhook_messages');
    },
  }));

  // Postgres-only: dedup survives adapter instance restart (in-memory
  // creates a fresh Set per instance and would fail this assertion).
  describe('restart survival (Postgres-only)', () => {
    it('still reports duplicates through a fresh adapter instance', async () => {
      const writer = new Store(pool);
      await writer.markSeen('wamid.restart');

      const freshReader = new Store(pool);
      await expect(freshReader.isDuplicate('wamid.restart')).resolves.toBe(true);
    });
  });
});
