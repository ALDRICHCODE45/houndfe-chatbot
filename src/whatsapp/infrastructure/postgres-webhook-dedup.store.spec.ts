import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  WEBHOOK_CLAIM_LEASE_MS,
  WebhookClaimInFlightError,
} from '../domain/webhook-dedup.store';
import { PostgresWebhookDedupStore } from './postgres-webhook-dedup.store';
import { runWebhookDedupContract } from './webhook-dedup.contract';

/**
 * Testcontainers-backed suite for PostgresWebhookDedupStore and migration
 * 4100 (claims with a lease). Applies the SAME migrations the production
 * binary runs (zero schema drift).
 *
 * Gated by RUN_DOCKER_TESTS=1 — without the gate the file is skipped and
 * `pnpm test` stays green without Docker.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const MIGRATION = '4100000000000_processed_webhook_messages_claims';

ddescribe('PostgresWebhookDedupStore + migration 4100 (Testcontainers)', () => {
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
  // Roll back 4100 and everything applied after it.
  const rollBack = async () => {
    const applied = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pgmigrations WHERE name >= $1`,
      [MIGRATION],
    );
    migrate('down', applied.rows[0].n);
  };
  const statusOf = async (messageId: string) => {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM processed_webhook_messages WHERE message_id = $1',
      [messageId],
    );
    return rows[0]?.status ?? null;
  };

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

  afterEach(async () => {
    await pool.query('TRUNCATE TABLE processed_webhook_messages');
  });

  describe('migration 4100', () => {
    it('adds the claim columns with their checks and the purge index', async () => {
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'processed_webhook_messages' ORDER BY column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'claim_token',
        'claimed_at',
        'lease_expires_at',
        'message_id',
        'seen_at',
        'status',
      ]);
      const reject = (sql: string) =>
        expect(pool.query(sql)).rejects.toMatchObject({ code: '23514' });
      await reject(
        `INSERT INTO processed_webhook_messages (message_id, status)
         VALUES ('wamid.bad-status', 'FAILED')`,
      );
      await reject(
        `INSERT INTO processed_webhook_messages (message_id, status)
         VALUES ('wamid.no-lease', 'PROCESSING')`,
      );
      await reject(
        `INSERT INTO processed_webhook_messages
           (message_id, status, claim_token, claimed_at, lease_expires_at)
         VALUES ('wamid.backwards', 'PROCESSING', gen_random_uuid(), now(),
                 now() - interval '1 second')`,
      );
      await reject(
        `INSERT INTO processed_webhook_messages
           (message_id, claim_token, lease_expires_at)
         VALUES ('wamid.done-lease', gen_random_uuid(), now())`,
      );
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'processed_webhook_messages'`,
      );
      expect(indexes.rows.map((row) => row.indexdef).join('\n')).toMatch(
        /\(seen_at\)/,
      );
    });

    it('keeps the legacy single-column insert (receipt admission) as DONE', async () => {
      await pool.query(
        `INSERT INTO processed_webhook_messages (message_id)
         VALUES ('wamid.receipt') ON CONFLICT (message_id) DO NOTHING`,
      );
      await expect(statusOf('wamid.receipt')).resolves.toBe('DONE');
      await expect(
        new PostgresWebhookDedupStore(pool).claim('wamid.receipt'),
      ).resolves.toBeNull();
    });

    it('turns existing rows into DONE and refuses to roll back over a live claim', async () => {
      await rollBack();
      await pool.query(
        `INSERT INTO processed_webhook_messages (message_id)
         VALUES ('wamid.legacy')`,
      );
      migrate('up');
      await expect(statusOf('wamid.legacy')).resolves.toBe('DONE');

      const store = new PostgresWebhookDedupStore(pool);
      await store.claim('wamid.in-flight');
      await expect(rollBack()).rejects.toThrow(/live claim/);
      await expect(statusOf('wamid.in-flight')).resolves.toBe('PROCESSING');

      // An expired claim was never answered: down drops it so the old
      // schema does not read it as processed. DONE rows survive.
      await pool.query(
        `UPDATE processed_webhook_messages
            SET claimed_at = now() - interval '1 hour',
                lease_expires_at = now() - interval '1 minute'
          WHERE message_id = 'wamid.in-flight'`,
      );
      await rollBack();
      const rows = await pool.query<{ message_id: string }>(
        'SELECT message_id FROM processed_webhook_messages ORDER BY message_id',
      );
      expect(rows.rows).toEqual([{ message_id: 'wamid.legacy' }]);
      migrate('up');
    });
  });

  runWebhookDedupContract('PostgresWebhookDedupStore', (now) =>
    Promise.resolve({
      store: new PostgresWebhookDedupStore(pool, now),
      cleanup: async () => {
        await pool.query('TRUNCATE TABLE processed_webhook_messages');
      },
    }),
  );

  describe('Postgres-only', () => {
    it('lets one of two processes win a concurrent claim', async () => {
      const other = new Pool({ connectionString: uri });
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, i) =>
            new PostgresWebhookDedupStore(i % 2 === 0 ? pool : other).claim(
              'wamid.two-processes',
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const result of results.filter((r) => r.status === 'rejected')) {
          expect(result.reason).toBeInstanceOf(WebhookClaimInFlightError);
        }
      } finally {
        await other.end();
      }
    });

    it('lets one of two processes take over an expired claim', async () => {
      const t0 = new Date('2026-11-09T16:00:00.000Z');
      const later = new Date(t0.getTime() + WEBHOOK_CLAIM_LEASE_MS);
      await new PostgresWebhookDedupStore(pool, () => t0).claim(
        'wamid.takeover',
      );
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          new PostgresWebhookDedupStore(pool, () => later).claim(
            'wamid.takeover',
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((r) => r.status === 'rejected')) {
        expect(result.reason).toBeInstanceOf(WebhookClaimInFlightError);
      }
    });

    it('completes a claim the receipt admission marker could not insert over', async () => {
      const store = new PostgresWebhookDedupStore(pool);
      await store.claim('wamid.receipt-claimed');
      await pool.query(
        `INSERT INTO processed_webhook_messages (message_id)
         VALUES ('wamid.receipt-claimed') ON CONFLICT (message_id) DO NOTHING`,
      );
      await expect(statusOf('wamid.receipt-claimed')).resolves.toBe(
        'PROCESSING',
      );
      await store.markSeen('wamid.receipt-claimed');
      await expect(statusOf('wamid.receipt-claimed')).resolves.toBe('DONE');
    });

    it('still reports duplicates through a fresh adapter instance', async () => {
      await new PostgresWebhookDedupStore(pool).markSeen('wamid.restart');
      await expect(
        new PostgresWebhookDedupStore(pool).claim('wamid.restart'),
      ).resolves.toBeNull();
    });
  });
});
