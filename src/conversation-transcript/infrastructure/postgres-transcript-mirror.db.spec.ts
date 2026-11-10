import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { PostgresBackendOutboxStore } from '../../backend-outbox/infrastructure/postgres-backend-outbox.store';
import { TranscriptRecorder } from '../application/transcript-recorder';
import { PostgresTranscriptStore } from './postgres-transcript.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const SENDER = '5215550001111';
const NOW = new Date('2026-11-09T16:02:12.345Z');

/** S1→S2 atomicity: the transcript row and its mirror commit together. */
ddescribe('transcript + outbox mirror atomicity (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool;

  const counts = async () => {
    const { rows } = await pool.query<{ messages: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM conversation_messages) AS messages,
              (SELECT count(*) FROM backend_outbox) AS outbox`,
    );
    return {
      messages: Number(rows[0].messages),
      outbox: Number(rows[0].outbox),
    };
  };

  const inbound = (messageId: string) => ({
    senderId: SENDER,
    text: 'hola',
    messageId,
    timestamp: '2026-11-09T16:02:11.000Z',
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const uri = container.getConnectionUri();
    execFileSync(
      process.execPath,
      [BIN, '-f', 'package.json', '--config-value', 'pg-migrate', 'up'],
      {
        cwd: ROOT,
        env: { DATABASE_URL: uri },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
    pool = new Pool({ connectionString: uri });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await pool.query(
      'TRUNCATE TABLE conversation_messages, backend_outbox, backend_outbox_sequences',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('commits one transcript row and one mirror, and a duplicate adds neither', async () => {
    const recorder = new TranscriptRecorder(
      new PostgresTranscriptStore(pool),
      () => NOW,
      new BackendOutboxService(new PostgresBackendOutboxStore(pool)),
    );
    await recorder.recordInbound(inbound('wamid.in-1'), 'text');
    await recorder.recordInbound(inbound('wamid.in-1'), 'text');
    await expect(counts()).resolves.toEqual({ messages: 1, outbox: 1 });
    const { rows } = await pool.query<{
      conversation_ref: string;
      seq: string;
      kind: string;
      idempotency_key: string;
      payload: unknown;
    }>(
      'SELECT conversation_ref, seq, kind, idempotency_key, payload FROM backend_outbox',
    );
    expect(rows).toEqual([
      {
        conversation_ref: `wa:${SENDER}`,
        seq: '1',
        kind: 'MESSAGE_MIRROR',
        idempotency_key: 'mirror:wamid.in-1',
        payload: {
          waMessageId: 'wamid.in-1',
          direction: 'IN',
          author: 'CUSTOMER',
          type: 'text',
          text: 'hola',
          providerTimestamp: '2026-11-09T16:02:11.000Z',
          observedAt: '2026-11-09T16:02:12.345Z',
        },
      },
    ]);
  });

  it('rolls the transcript row back when the enqueue fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const outboxStore = new PostgresBackendOutboxStore(pool);
    const recorder = new TranscriptRecorder(
      new PostgresTranscriptStore(pool),
      () => NOW,
      {
        // Writes the outbox row on the shared client, then fails: both the
        // outbox row and the transcript row must disappear.
        enqueue: async (input, options) => {
          await outboxStore.enqueue(input, options?.client);
          throw new Error('outbox down');
        },
      },
    );
    await recorder.recordInbound(inbound('wamid.in-2'), 'text');
    await expect(counts()).resolves.toEqual({ messages: 0, outbox: 0 });
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM backend_outbox_sequences',
    );
    expect(rows[0].n).toBe('0');
  });

  it('a mirror enqueue that never receives the client cannot escape the rollback', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    const recorder = new TranscriptRecorder(
      new PostgresTranscriptStore(pool),
      () => NOW,
      {
        enqueue: (_input, options) => {
          seen.push(options?.client);
          return Promise.reject(new Error('outbox down'));
        },
      },
    );
    await recorder.recordInbound(inbound('wamid.in-3'), 'text');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    await expect(counts()).resolves.toEqual({ messages: 0, outbox: 0 });
  });
});
