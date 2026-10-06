import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
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

  // Existing-behavior proof of the low-level CAS, not send authority or a
  // reservation/fresh-clock claim. No crash or COMMIT-disconnect injection.
  const begin = (sendToken = '33333333-3333-4333-8333-333333333333') => ({
    kind: 'begin_send',
    sendToken,
    attemptedAt: pending().resolvedAt,
  });
  const started = () => ({
    ...pending(),
    state: 'SEND_STARTED' as const,
    sendToken: begin().sendToken,
    attemptedAt: begin().attemptedAt,
  });
  const acceptance = (observedAt = pending().resolvedAt) => ({
    kind: 'provider_accepted',
    attemptId: pending().attemptId,
    sendToken: begin().sendToken,
    providerMessageId: ' provider opaque ',
    providerAcceptedObservedAt: observedAt,
  });
  const startRow = async () => {
    expect(await store.insertPending(pending())).toEqual({
      action: 'inserted',
      row: pending(),
    });
    expect(
      await store.transitionPending({ row: pending(), event: begin() }),
    ).toEqual({
      action: 'updated',
      row: started(),
    });
  };

  // Acceptance proof uses the public adapters, not direct row-data assertions.
  // A provisional updated result is not COMMIT; a fresh pool is not an OS
  // restart. Receipt evidence is synthetic, never a real provider send.
  it.each([
    ['on-time identical', pending().resolvedAt, false, 'COMMIT'],
    ['on-time conflicting', pending().resolvedAt, true, 'COMMIT'],
    ['late identical', pending().applyBefore, false, 'COMMIT'],
    ['late conflicting', pending().applyBefore, true, 'COMMIT'],
    ['rolled-back conflicting', pending().resolvedAt, true, 'ROLLBACK'],
  ] as const)(
    'acceptance %s serializes a blocked contender with the expected transaction outcome',
    async (_, observedAt, conflict, completion) => {
      await startRow();
      const row = started();
      const event = acceptance(observedAt);
      const next = {
        ...row,
        state:
          observedAt === pending().applyBefore
            ? 'PROVIDER_ACCEPTED_LATE'
            : 'PROVIDER_ACCEPTED',
        providerMessageId: event.providerMessageId,
        providerAcceptedObservedAt: observedAt,
      };
      const contender = {
        ...event,
        providerMessageId: conflict
          ? 'different receipt'
          : event.providerMessageId,
      };
      const first = await pool.connect();
      let second: PoolClient | undefined;
      let competing: Promise<unknown> | undefined;
      try {
        second = await pool.connect();
        await first.query("SET statement_timeout = '10s'");
        await second.query("SET statement_timeout = '10s'");
        const firstPid = (
          await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        const secondPid = (
          await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(firstPid).not.toBe(secondPid);
        await first.query('BEGIN');
        expect(
          await new PostgresExpirationApplicationLedgerStore(
            first,
          ).recordAcceptance({ row, event }),
        ).toEqual({ action: 'updated', row: next });
        let settled = false;
        competing = new PostgresExpirationApplicationLedgerStore(second)
          .recordAcceptance({ row, event: contender })
          .then(
            (value) => {
              settled = true;
              return { value };
            },
            () => {
              settled = true;
              return { rejected: true };
            },
          );
        let blocked = false;
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          // Blocking PIDs are live; no cached activity query text is consulted.
          const { rows } = await first.query<{ blocked: boolean }>(
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
        expect(settled).toBe(false);
        await first.query(completion);
        expect(await competing).toEqual({
          value:
            completion === 'COMMIT'
              ? { action: 'hold' }
              : {
                  action: 'updated',
                  row: {
                    ...next,
                    providerMessageId: contender.providerMessageId,
                  },
                },
        });
        const activity = await pool.query(
          'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
          [secondPid],
        );
        expect(activity.rows).toEqual([{ state: 'idle', xact_start: null }]);
      } finally {
        try {
          await first.query('ROLLBACK');
        } finally {
          try {
            await competing;
          } finally {
            first.release();
            second?.release();
          }
        }
      }
      const fresh = new Pool({
        connectionString: container.getConnectionUri(),
        max: 1,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 10_000,
      });
      try {
        const replay = new PostgresExpirationApplicationLedgerStore(fresh);
        expect(await replay.recordAcceptance({ row, event })).toEqual({
          action: 'hold',
        });
        expect(
          await replay.recordAcceptance({ row, event: contender }),
        ).toEqual({ action: 'hold' });
        expect(await replay.readByDecision(decisionId)).toEqual({
          action: 'hold',
        });
        expect(await replay.insertPending(pending())).toEqual({
          action: 'hold',
        });
        expect(
          await replay.transitionPending({ row: pending(), event: begin() }),
        ).toEqual({ action: 'hold' });
      } finally {
        await fresh.end();
      }
    },
  );
  it('rejects absent or divergent expected started rows without losing the exact acceptance CAS', async () => {
    const row = started();
    const event = acceptance('2026-09-25T11:00:00.000Z');
    expect(await store.recordAcceptance({ row, event })).toEqual({
      action: 'hold',
    });
    expect(await store.readByDecision(decisionId)).toEqual({
      action: 'missing',
    });
    await startRow();
    const otherSource = '99998b89-b323-5a4f-952e-41ebcc00d733';
    const otherDecision = '22222222-2222-4222-8222-222222222222';
    for (const changed of [
      { ...row, senderId: 'other' },
      { ...row, branchId: 'branch' },
      { ...row, sendToken: otherDecision },
      { ...row, attemptedAt: '2026-09-25T10:01:00.000Z' },
      {
        ...row,
        resolvedAt: '2026-09-25T09:00:00.000Z',
        applyBefore: '2026-09-26T09:00:00.000Z',
      },
      {
        ...row,
        sourceRequestId: otherSource,
        attemptId: deriveExpirationAttemptId(otherSource, decisionId)!,
      },
      {
        ...row,
        decisionId: otherDecision,
        attemptId: deriveExpirationAttemptId(sourceRequestId, otherDecision)!,
      },
    ]) {
      expect(
        await store.recordAcceptance({
          row: changed,
          event: {
            ...event,
            attemptId: changed.attemptId,
            sendToken: changed.sendToken,
          },
        }),
      ).toEqual({ action: 'hold' });
    }
    // The final exact CAS proves rejected candidates left the original started
    // row intact; JSONB object key order is not identity.
    expect(
      await store.recordAcceptance({
        row: Object.fromEntries(Object.entries(row).reverse()),
        event,
      }),
    ).toEqual({
      action: 'updated',
      row: {
        ...row,
        state: 'PROVIDER_ACCEPTED',
        providerMessageId: event.providerMessageId,
        providerAcceptedObservedAt: event.providerAcceptedObservedAt,
      },
    });
    expect(await store.recordAcceptance({ row, event })).toEqual({
      action: 'hold',
    });
  });

  it.each(['identical', 'different'] as const)(
    'one real CAS wins while a blocked %s-token contender holds after commit',
    async (kind) => {
      const row = pending();
      expect(await store.insertPending(row)).toEqual({
        action: 'inserted',
        row,
      });
      const first = await pool.connect();
      let second: PoolClient | undefined;
      let competing: Promise<unknown> | undefined;
      try {
        second = await pool.connect();
        await first.query("SET statement_timeout = '10s'");
        await second.query("SET statement_timeout = '10s'");
        await first.query('BEGIN');
        const firstPid = (
          await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        const secondPid = (
          await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(firstPid).not.toBe(secondPid);
        const winner = {
          ...row,
          state: 'SEND_STARTED',
          sendToken: begin().sendToken,
          attemptedAt: begin().attemptedAt,
        };
        expect(
          await new PostgresExpirationApplicationLedgerStore(
            first,
          ).transitionPending({ row, event: begin() }),
        ).toEqual({ action: 'updated', row: winner });
        const event =
          kind === 'identical'
            ? begin()
            : begin('44444444-4444-4444-8444-444444444444');
        let settled = false;
        competing = new PostgresExpirationApplicationLedgerStore(second)
          .transitionPending({ row, event })
          .then(
            (value) => {
              settled = true;
              return { value };
            },
            () => {
              settled = true;
              return { rejected: true };
            },
          );
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const observation = await first.query<{ blocked: boolean }>(
            'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
            [firstPid, secondPid],
          );
          if (observation.rows[0].blocked) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
        // Other sessions still see pending until the transaction owner commits.
        expect(await store.readByDecision(decisionId)).toEqual({
          action: 'foundPending',
          row,
        });
        await first.query('COMMIT');
        expect(await competing).toEqual({ value: { action: 'hold' } });
        expect(await store.readByDecision(decisionId)).toEqual({
          action: 'hold',
        });
        expect(await store.insertPending(row)).toEqual({ action: 'hold' });
        expect(await store.transitionPending({ row, event: begin() })).toEqual({
          action: 'hold',
        });
        expect(await store.transitionPending({ row, event })).toEqual({
          action: 'hold',
        });
        const activity = await pool.query(
          'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
          [secondPid],
        );
        expect(activity.rows).toEqual([{ state: 'idle', xact_start: null }]);
      } finally {
        try {
          await first.query('ROLLBACK');
        } finally {
          try {
            await competing;
          } finally {
            first.release();
            second?.release();
          }
        }
      }
    },
  );
  it('keeps updated provisional: caller rollback restores pending and allows a later CAS', async () => {
    const row = pending();
    expect(await store.insertPending(row)).toEqual({ action: 'inserted', row });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const next = {
        ...row,
        state: 'SEND_STARTED',
        sendToken: begin().sendToken,
        attemptedAt: begin().attemptedAt,
      };
      expect(
        await new PostgresExpirationApplicationLedgerStore(
          client,
        ).transitionPending({ row, event: begin() }),
      ).toEqual({ action: 'updated', row: next });
      expect(await store.readByDecision(decisionId)).toEqual({
        action: 'foundPending',
        row,
      });
      await client.query('ROLLBACK');
      expect(await store.readByDecision(decisionId)).toEqual({
        action: 'foundPending',
        row,
      });
      expect(await store.transitionPending({ row, event: begin() })).toEqual({
        action: 'updated',
        row: next,
      });
      expect(await store.transitionPending({ row, event: begin() })).toEqual({
        action: 'hold',
      });
    } finally {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
  });
  it('holds missing or mismatched full expected snapshots without altering pending', async () => {
    const row = pending();
    expect(await store.transitionPending({ row, event: begin() })).toEqual({
      action: 'hold',
    });
    expect(await store.readByDecision(decisionId)).toEqual({
      action: 'missing',
    });
    expect(await store.insertPending(row)).toEqual({ action: 'inserted', row });
    for (const changed of [
      { ...row, senderId: 'other' },
      { ...row, branchId: row.branchId.trim() },
      {
        ...row,
        resolvedAt: '2026-09-25T09:00:00.000Z',
        applyBefore: '2026-09-26T09:00:00.000Z',
      },
    ]) {
      expect(
        await store.transitionPending({ row: changed, event: begin() }),
      ).toEqual({ action: 'hold' });
      expect(await store.readByDecision(decisionId)).toEqual({
        action: 'foundPending',
        row,
      });
    }
    const reordered = Object.fromEntries(Object.entries(row).reverse());
    expect(
      await store.transitionPending({ row: reordered, event: begin() }),
    ).toEqual({
      action: 'updated',
      row: {
        ...row,
        state: 'SEND_STARTED',
        sendToken: begin().sendToken,
        attemptedAt: begin().attemptedAt,
      },
    });
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
