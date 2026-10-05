import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';

// Run with RUN_DOCKER_TESTS=1. Only the disposable container URI is used;
// migration 290 is real. These observations confer no send or ACK authority.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const pending = () => ({
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2 as const,
  attemptId: deriveExpirationAttemptId(sourceRequestId, decisionId)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-26T10:00:00.000Z',
  state: 'PENDING_DELIVERY' as const,
});

ddescribe('EXPIRATION pending adapter (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresExpirationApplicationLedgerStore;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync(
      process.execPath,
      [
        `${ROOT}/node_modules/node-pg-migrate/bin/node-pg-migrate.js`,
        '-f',
        'package.json',
        '--config-value',
        'pg-migrate',
        'up',
        '2900000000000',
        '--timestamp',
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    pool = new Pool({ connectionString: container.getConnectionUri() });
    store = new PostgresExpirationApplicationLedgerStore(pool);
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE expiration_application_ledger');
  });

  it('round-trips an exact pending snapshot and replays reordered JSON keys', async () => {
    const row = pending();
    expect(await store.readByDecision(decisionId)).toEqual({
      action: 'missing',
    });
    const inserted = await store.insertPending(row);
    expect(inserted).toEqual({ action: 'inserted', row });
    const found = await store.readByDecision(decisionId);
    expect(found).toEqual({ action: 'foundPending', row });
    const reordered = Object.fromEntries(
      Object.entries(row).reverse(),
    ) as typeof row;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(row));
    const replay = await store.insertPending(reordered);
    expect(replay).toEqual({ action: 'replay', row });
    for (const result of [inserted, found, replay]) {
      expect(Object.isFrozen(result)).toBe(true);
      if (!('row' in result)) throw new Error('missing snapshot');
      expect(Object.isFrozen(result.row)).toBe(true);
      expect(result.row).not.toBe(row);
      expect(result).not.toHaveProperty('ack');
    }
    row.branchId = 'caller mutation';
    expect(await store.readByDecision(decisionId)).toEqual({
      action: 'foundPending',
      row: pending(),
    });
  });

  it('holds divergent replays without replacing the original snapshot', async () => {
    const row = pending();
    expect(await store.insertPending(row)).toEqual({ action: 'inserted', row });
    const movedSource = '99998b89-b323-5a4f-952e-41ebcc00d733';
    for (const changed of [
      { ...row, senderId: 'other' },
      { ...row, branchId: 'other' },
      {
        ...row,
        sourceRequestId: movedSource,
        attemptId: deriveExpirationAttemptId(movedSource, decisionId)!,
      },
      {
        ...row,
        resolvedAt: '2026-09-25T10:01:00.000Z',
        applyBefore: '2026-09-26T10:01:00.000Z',
      },
    ]) {
      expect(await store.insertPending(changed)).toEqual({ action: 'hold' });
      expect(await store.readByDecision(decisionId)).toEqual({
        action: 'foundPending',
        row,
      });
      expect(await store.insertPending(row)).toEqual({ action: 'replay', row });
    }
  });

  it.each(['identical', 'divergent'] as const)(
    'serializes %s concurrent inserts on separate connections without overwriting',
    async (kind) => {
      const first = await pool.connect();
      const second = await pool.connect();
      let competing: Promise<unknown> | undefined;
      try {
        await first.query('BEGIN');
        await second.query("SET statement_timeout = '10s'");
        const firstPid = (
          await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        const secondPid = (
          await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(firstPid).not.toBe(secondPid);
        const winner = pending();
        const contender =
          kind === 'identical'
            ? pending()
            : { ...pending(), branchId: 'other' };
        expect(
          await new PostgresExpirationApplicationLedgerStore(
            first,
          ).insertPending(winner),
        ).toEqual({ action: 'inserted', row: winner });
        // Convert rejection to a value immediately so cleanup cannot leak an
        // unhandled rejection if the lock-observation assertion fails.
        competing = new PostgresExpirationApplicationLedgerStore(second)
          .insertPending(contender)
          .catch((error: unknown) => error);
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const { rows } = await pool.query<{ blocked: boolean }>(
            'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
            [firstPid, secondPid],
          );
          if (rows[0].blocked) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        expect(blocked).toBe(true);
        await first.query('COMMIT');
        expect(await competing).toEqual(
          kind === 'identical'
            ? { action: 'replay', row: winner }
            : { action: 'hold' },
        );
        expect(await store.readByDecision(decisionId)).toEqual({
          action: 'foundPending',
          row: winner,
        });
        expect(await store.insertPending(winner)).toEqual({
          action: 'replay',
          row: winner,
        });
      } finally {
        await first.query('ROLLBACK');
        if (competing) await competing;
        first.release();
        second.release();
      }
    },
  );

  it.each(['nonpending', 'noncanonical'] as const)(
    'holds SQL-admissible %s rows instead of treating them as missing or overwriting them',
    async (kind) => {
      const row = pending();
      // Fixture setup only: these shapes pass SQL but are not accepted by
      // the pending-only adapter. Assertions use its public methods.
      const stored =
        kind === 'nonpending'
          ? { ...row, state: 'STALE', staleObservedAt: row.applyBefore }
          : { ...row, applyBefore: 'not-an-instant' };
      await pool.query(
        `INSERT INTO expiration_application_ledger
         (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          decisionId,
          sourceRequestId,
          row.attemptId,
          row.senderId,
          row.branchId,
          JSON.stringify(stored),
        ],
      );
      expect(await store.readByDecision(decisionId)).toEqual({
        action: 'hold',
      });
      expect(await store.insertPending(row)).toEqual({ action: 'hold' });
      expect(await store.readByDecision(decisionId)).toEqual({
        action: 'hold',
      });
    },
  );
});
