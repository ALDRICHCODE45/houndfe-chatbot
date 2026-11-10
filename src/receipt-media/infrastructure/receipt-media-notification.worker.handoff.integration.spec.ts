import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type {
  OutboundText,
  SendResult,
} from '../../whatsapp/domain/whatsapp-sender.port';
import { PostgresReceiptOutboxStore } from './postgres-receipt-outbox.store';
import { ReceiptMediaNotificationWorker } from './receipt-media-notification.worker';

/** S7 over the real fenced outbox SQL: a HUMAN hold leaves the claimed row
 * SENDING with `attempts` unchanged; once the 60 s lease expires the claim
 * picks it up again and a BOT-mode worker sends it. Gated by
 * RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const OWNER = 's7.worker';
const RECIPIENT = '+525500000000';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

ddescribe('receipt notification S7 handoff hold (real outbox SQL)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptOutboxStore;
  let priorDatabaseUrl: string | undefined;
  const workers = new Set<ReceiptMediaNotificationWorker>();

  const boot = (human: () => Promise<boolean>) => {
    const calls: OutboundText[] = [];
    const reads: string[] = [];
    const worker = new ReceiptMediaNotificationWorker(
      store,
      {
        sendText: (message): Promise<SendResult> => {
          calls.push(message);
          return Promise.resolve({ providerMessageId: 'wamid.s7' });
        },
      },
      { onExhausted: () => Promise.resolve() },
      { owner: OWNER, pollIntervalMs: 50, batchSize: 4, maxConcurrency: 4 },
      undefined,
      undefined,
      {
        isHumanMode: (id) => {
          reads.push(id);
          return human();
        },
      },
    );
    workers.add(worker);
    worker.onApplicationBootstrap();
    return { worker, calls, reads };
  };

  const insert = async (): Promise<string> => {
    const { rows } = await pool.query<Row>(
      `INSERT INTO receipt_media_outbox
         (id, dedupe_key, source_webhook_message_id, recipient_id,
          template_key, template_args, status, attempts)
       VALUES ($1, $2, $3, $4, 'RECEIPT_ATTACHED_PENDING', $5, 'PENDING', 0)
       RETURNING id`,
      [
        randomUUID(),
        `s7.${randomUUID()}`,
        `wamid.s7.${randomUUID()}`,
        RECIPIENT,
        JSON.stringify({ folio: 'F-1' }),
      ],
    );
    return rows[0].id as string;
  };

  const readRow = async (id: string): Promise<Row> =>
    (
      await pool.query<Row>(
        'SELECT * FROM receipt_media_outbox WHERE id = $1',
        [id],
      )
    ).rows[0];

  const waitFor = async <T>(
    probe: () => T | null | Promise<T | null>,
    ms = 40_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('S7: waitFor timed out');
      await delay(25);
    }
  };

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({
      connectionString: container.getConnectionUri(),
      options: '-c statement_timeout=8000',
    });
    store = new PostgresReceiptOutboxStore(pool);
  });

  afterEach(async () => {
    for (const worker of workers) await worker.onModuleDestroy();
    workers.clear();
    await pool.query('TRUNCATE receipt_media_outbox');
  });

  afterAll(async () => {
    for (const worker of workers) await worker.onModuleDestroy();
    if (pool) await pool.end();
    if (container) await container.stop();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  it.each([
    ['HUMAN', () => Promise.resolve(true)],
    ['an unreadable mode', () => Promise.reject(new Error('db down'))],
  ])(
    '%s holds without bookkeeping; after the lease expires a BOT worker sends it with attempts unchanged',
    async (_label, mode) => {
      const id = await insert();
      const held = boot(mode);
      const claimed = await waitFor(async () => {
        const row = await readRow(id);
        return held.reads.length > 0 && row.status === 'SENDING' ? row : null;
      });
      await held.worker.onModuleDestroy();
      expect(held.calls).toEqual([]);
      expect(claimed).toMatchObject({
        status: 'SENDING',
        attempts: 0,
        lease_owner: OWNER,
        provider_message_id: null,
      });
      // The live lease keeps the row away from any other claim.
      await expect(store.claimBatch(4, 'other')).resolves.toEqual([]);
      expect(await readRow(id)).toMatchObject({
        status: 'SENDING',
        attempts: 0,
      });

      // The 60 s lease runs out (simulated); the claim picks the row again.
      await pool.query(
        `UPDATE receipt_media_outbox
            SET lease_expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [id],
      );
      const resumed = boot(() => Promise.resolve(false));
      const sent = await waitFor(async () => {
        const row = await readRow(id);
        return row.status === 'SENT' ? row : null;
      });
      expect(resumed.calls).toHaveLength(1);
      expect(resumed.calls[0].to).toBe(RECIPIENT);
      expect(sent).toMatchObject({
        status: 'SENT',
        attempts: 0,
        provider_message_id: 'wamid.s7',
      });
    },
  );
});
