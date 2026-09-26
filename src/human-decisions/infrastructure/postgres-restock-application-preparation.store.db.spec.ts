import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RestockApplicationCandidateService } from '../application/restock-application-candidate.service';
import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';
import { PostgresRestockApplicationPreparationStore } from './postgres-restock-application-preparation.store';

// Existing-behavior proof, not retroactive RED. POST receipt is SQL-seeded and
// GET is synthetic, not actual backend evidence. Only the local chain is real.
// SQL context mutations simulate races, not supported business writer routes.
// No send/START authority, provider/24h proof, remote atomicity, process crash or
// COMMIT-disconnect injection. Subsequent changes require START revalidation.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const NOW = '2026-06-22T12:00:00.000Z';
const END = '2026-06-22T13:00:00.000Z';
const SOURCE = '848D8B89-B323-5A4F-952E-41EBCC00D733';
const ID = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const SENDER = 'whatsapp:+5215500000001';
const BRANCH = ' trusted branch ';
const clock = () => new Date(NOW);
const subject = {
  productId: PRODUCT,
  productName: 'Collar',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: 0,
  stockObservedAt: NOW,
};
const intake = {
  ...subject,
  sourceRequestId: SOURCE,
  type: 'RESTOCK' as const,
  supersedesDecisionId: null,
};
const decision = {
  id: ID,
  sourceRequestId: SOURCE,
  type: 'RESTOCK' as const,
  createdAt: NOW,
  supersedesDecisionId: null,
  snapshot: { ...subject, branchId: BRANCH, branchName: null },
  status: 'RESOLVED' as const,
  version: 2 as const,
  resolution: {
    action: 'PROVIDE_RESTOCK_ESTIMATE' as const,
    restockDays: 3,
    resolvedAt: NOW,
  },
  applyBefore: END,
};
const pending = {
  state: 'PENDING_DELIVERY' as const,
  senderId: SENDER,
  sourceRequestId: SOURCE,
  branchId: BRANCH,
  decisionId: ID,
  resolutionVersion: 2 as const,
  attemptId: deriveRestockAttemptId(SOURCE, ID)!,
  resolvedAt: NOW,
  applyBefore: END,
};
const reservationSQL =
  'SELECT *, xmin::text AS revision FROM human_decision_reservations WHERE sender_id=$1';
const ledgerSQL =
  'SELECT *, xmin::text AS revision FROM restock_application_ledger';

async function waitForBlock(client: PoolClient, pid: number, blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers',
      [pid],
    );
    if (result.rows[0].blockers.includes(blocker)) return;
    await delay(20);
  }
  throw new Error('preparation did not observably wait for reservation lock');
}

ddescribe('restock preparation under real reservation locks', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let first: Pool;
  let second: Pool;
  const prepare = (pool: Pool) =>
    new PostgresRestockApplicationPreparationStore(pool, BRANCH, clock);
  const reservation = async (pool: Pool) =>
    (await pool.query<Record<string, unknown>>(reservationSQL, [SENDER])).rows;
  const persisted = async () =>
    (await first.query<Record<string, unknown>>(ledgerSQL)).rows;
  const candidate = async () => {
    const backend = {
      getRestockDecision: jest.fn().mockResolvedValue(decision),
    };
    const result = await new RestockApplicationCandidateService(
      new PostgresRestockApplicationContextStore(first),
      backend,
      BRANCH,
      clock,
    ).pollForSender(SENDER);
    expect(backend.getRestockDecision).toHaveBeenCalledWith(ID);
    expect(result.action).toBe('candidate');
    if (result.action !== 'candidate') throw new Error('candidate required');
    expect(result.context).toEqual({
      reservation: {
        status: 'ACTIVE',
        route: 'RESTOCK',
        senderId: SENDER,
        requestKey: SOURCE,
        intake,
      },
      backendDecisionId: ID,
      postAttemptedAt: NOW,
      receiptRecordedAt: NOW,
    });
    return result;
  };
  const idle = async (pool: Pool) => {
    // A follow-up checkout proves return; xact_start NULL on the other session
    // distinguishes idle from idle-in-transaction after COMMIT/ROLLBACK.
    const result = await pool.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const observer = pool === first ? second : first;
    const activity = await observer.query(
      'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
      [result.rows[0].pid],
    );
    expect(activity.rows).toEqual([{ state: 'idle', xact_start: null }]);
  };

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
          '--config-file',
          'package.json',
          '--config-value',
          'pg-migrate',
          'up',
          '2500000000000',
          '--timestamp',
        ],
        {
          cwd: ROOT,
          env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
      const config = {
        connectionString: container.getConnectionUri(),
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 10_000,
        query_timeout: 15_000,
        statement_timeout: 12_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 20_000,
      };
      first = new Pool(config);
      second = new Pool(config);
    } catch {
      // Teardown also covers partial setup; do not expose child output/URI.
      throw new Error('Disposable PostgreSQL preparation fixture setup failed');
    }
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([first?.end(), second?.end()]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Preparation fixture pool cleanup failed');
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await first.query(
      'TRUNCATE restock_application_ledger, human_decision_reservations',
    );
    await first.query(
      `INSERT INTO human_decision_reservations
       (sender_id, route, request_key, status, intake, post_state,
        backend_decision_id, post_attempted_at, receipt_recorded_at)
       VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3, 'RECEIPT_RECORDED', $4, $5, $5)`,
      [SENDER, SOURCE, JSON.stringify(intake), ID, NOW],
    );
  });

  it.each(['unchanged', 'intake', 'POST timestamp', 'POST ID case'])(
    'waits on the exact active reservation: %s',
    async (change) => {
      const snapshot = await candidate();
      const raw = await reservation(first);
      expect(raw[0].post_attempted_at).toBeInstanceOf(Date);
      expect(raw[0].receipt_recorded_at).toBeInstanceOf(Date);
      const probe = await second.connect();
      let pid: number;
      try {
        pid = (
          await probe.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
      } finally {
        probe.release();
      }
      const blocker = await first.connect();
      let transaction = false;
      let settled = false;
      let contender: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        transaction = true;
        const locked = await blocker.query(
          `SELECT sender_id FROM human_decision_reservations
           WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE`,
          [SENDER],
        );
        expect(locked.rows).toEqual([{ sender_id: SENDER }]);
        const blockerPid = (
          await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(pid).not.toBe(blockerPid);
        // Attach both handlers immediately, including cleanup-release rejection.
        contender = prepare(second)
          .preparePending(snapshot)
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
        await waitForBlock(blocker, pid, blockerPid);
        expect(settled).toBe(false);
        expect((await blocker.query(ledgerSQL)).rows).toEqual([]);
        if (change === 'intake')
          await blocker.query(
            `UPDATE human_decision_reservations SET intake =
             jsonb_set(intake, '{productName}', '"Changed collar"') WHERE sender_id=$1`,
            [SENDER],
          );
        if (change === 'POST timestamp')
          await blocker.query(
            `UPDATE human_decision_reservations SET receipt_recorded_at=
             receipt_recorded_at + interval '1 second' WHERE sender_id=$1`,
            [SENDER],
          );
        if (change === 'POST ID case')
          await blocker.query(
            'UPDATE human_decision_reservations SET backend_decision_id=lower(backend_decision_id) WHERE sender_id=$1',
            [SENDER],
          );
        const expectedReservation = (
          await blocker.query(reservationSQL, [SENDER])
        ).rows;
        await blocker.query('COMMIT');
        transaction = false;
        expect(await contender).toEqual({
          value:
            change === 'unchanged'
              ? { action: 'prepared', row: pending }
              : { action: 'hold' },
        });
        // Independent session visibility after function return proves committed
        // pending, rather than merely observing its INSERT inside a transaction.
        const rows = (await blocker.query<Record<string, unknown>>(ledgerSQL))
          .rows;
        expect(rows).toHaveLength(change === 'unchanged' ? 1 : 0);
        if (change === 'unchanged') {
          expect(rows[0].row_data).toEqual(pending);
          expect(rows[0].ack_receipt).toBeNull();
        }
        expect((await blocker.query(reservationSQL, [SENDER])).rows).toEqual(
          expectedReservation,
        );
      } finally {
        try {
          if (transaction) await blocker.query('ROLLBACK');
        } finally {
          await contender;
          blocker.release();
        }
      }
      await idle(second);
      await idle(first);
    },
  );

  it('allows two preparations but persists one row, not an exclusive claim', async () => {
    const snapshot = await candidate();
    const before = await reservation(first);
    const results = await Promise.allSettled([
      prepare(first).preparePending(snapshot),
      prepare(second).preparePending(snapshot),
    ]);
    expect(results).toEqual([
      { status: 'fulfilled', value: { action: 'prepared', row: pending } },
      { status: 'fulfilled', value: { action: 'prepared', row: pending } },
    ]);
    const rows = await persisted();
    expect(rows).toHaveLength(1);
    expect(rows[0].row_data).toEqual(pending);
    expect(rows[0].ack_receipt).toBeNull();
    expect(await reservation(first)).toEqual(before);
    await idle(first);
    await idle(second);
  });

  it('replays exact pending without rewrite, then holds actual SEND_STARTED', async () => {
    const snapshot = await candidate();
    const beforeReservation = await reservation(first);
    expect(await prepare(second).preparePending(snapshot)).toEqual({
      action: 'prepared',
      row: pending,
    });
    const before = await persisted();
    expect(before).toHaveLength(1);
    expect(await prepare(first).preparePending(snapshot)).toEqual({
      action: 'prepared',
      row: pending,
    });
    expect(await persisted()).toEqual(before);
    const advanced = await new PostgresRestockApplicationLedgerStore(
      first,
    ).transitionPending({
      row: pending,
      event: { kind: 'begin_send', sendToken: PRODUCT, attemptedAt: NOW },
    });
    expect(advanced).toEqual({
      action: 'updated',
      row: {
        ...pending,
        state: 'SEND_STARTED',
        sendToken: PRODUCT,
        attemptedAt: NOW,
      },
    });
    const after = await persisted();
    expect(after).toHaveLength(1);
    expect(after[0].ack_receipt).toBeNull();
    expect(await prepare(second).preparePending(snapshot)).toEqual({
      action: 'hold',
    });
    expect(await persisted()).toEqual(after);
    expect(await reservation(first)).toEqual(beforeReservation);
    await idle(first);
    await idle(second);
  });
});
