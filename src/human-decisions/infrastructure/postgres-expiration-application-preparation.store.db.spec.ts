import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ExpirationExistingDecisionService } from '../application/expiration-existing-decision.service';
import { createExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';
import { PostgresExpirationApplicationPreparationStore } from './postgres-expiration-application-preparation.store';

// Existing-behavior proof, not retroactive RED. Real migrations and local chain;
// SQL-seeded receipt and synthetic GET are not backend or delivery evidence.
// Fixture updates simulate drift, not supported business writers. No send/ACK,
// runtime activation, remote atomicity, process crash or COMMIT-disconnect proof.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const SENDER = 'customer';
const BRANCH = ' branch ';
const AT = '2026-06-23T08:00:00.000Z';
const END = '2026-06-24T08:00:00.000Z';
const intake = {
  sourceRequestId: SOURCE,
  type: 'EXPIRATION' as const,
  productId: PRODUCT,
  variantId: null,
};
const decision = {
  id: ID,
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  status: 'RESOLVED',
  version: 2,
  createdAt: AT,
  supersedesDecisionId: null,
  snapshot: {
    branchId: BRANCH,
    branchName: null,
    productId: PRODUCT,
    productName: 'Food',
    unit: 'PZA',
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
  resolution: {
    action: 'PROVIDE_EXPIRATION_TEXT',
    expirationText: 'Vence 03/2027',
    resolvedAt: AT,
  },
  applyBefore: END,
};
const pending = {
  state: 'PENDING_DELIVERY' as const,
  senderId: SENDER,
  branchId: BRANCH,
  sourceRequestId: SOURCE,
  decisionId: ID,
  resolutionVersion: 2 as const,
  attemptId: deriveExpirationAttemptId(SOURCE, ID)!,
  resolvedAt: AT,
  applyBefore: END,
};
async function pid(pool: Pool) {
  return (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
    .rows[0].pid;
}
async function waitForBlock(observer: PoolClient, target: number) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const result = await observer.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [target],
    );
    if (result.rows[0].blocked) return;
    await delay(10);
  }
  throw new Error('Preparation did not observably wait for reservation lock');
}

ddescribe('EXPIRATION preparation under real reservation locks', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let first: Pool;
  let second: Pool;
  let observer: Pool;
  let now: string;
  const clock = jest.fn(() => new Date(now));
  const prepare = (pool: Pool) =>
    new PostgresExpirationApplicationPreparationStore(pool, BRANCH, clock);
  const context = () =>
    new PostgresExpirationApplicationContextStore(
      observer,
    ).readRecordedForSender(SENDER);
  const ledger = () =>
    new PostgresExpirationApplicationLedgerStore(observer).readByDecision(ID);
  const candidate = async () => {
    const backend = {
      getExpirationDecision: jest.fn().mockResolvedValue(decision),
    };
    const outcome = await new ExpirationExistingDecisionService(
      new PostgresExpirationApplicationContextStore(observer),
      backend,
      BRANCH,
    ).readExistingDecision(SENDER);
    const result = createExpirationPreparationCandidate(SENDER, outcome, AT);
    expect(backend.getExpirationDecision).toHaveBeenCalledWith(ID);
    if (result.action !== 'candidate') throw new Error('Candidate required');
    return result;
  };
  const idle = async (pool: Pool) => {
    const result = await observer.query(
      'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
      [await pid(pool)],
    );
    expect(result.rows).toEqual([{ state: 'idle', xact_start: null }]);
  };
  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
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
      const config = {
        connectionString: container.getConnectionUri(),
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 12_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 20_000,
      };
      first = new Pool(config);
      second = new Pool(config);
      observer = new Pool(config);
    } catch {
      throw new Error('Disposable EXPIRATION preparation fixture setup failed');
    }
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([
        first?.end(),
        second?.end(),
        observer?.end(),
      ]);
      if (results.some((r) => r.status === 'rejected'))
        throw new Error('Preparation fixture pool cleanup failed');
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    now = AT;
    clock.mockClear();
    await observer.query(
      'TRUNCATE expiration_application_ledger, human_decision_reservations',
    );
    await observer.query(
      `INSERT INTO human_decision_reservations
       (sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at)
       VALUES ($1, 'EXPIRATION', $2, 'ACTIVE', $3, 'RECEIPT_RECORDED', $4, $5, $5)`,
      [SENDER, SOURCE, JSON.stringify(intake), ID, AT],
    );
  });
  it.each([
    'unchanged',
    'post_attempted_at',
    'receipt_recorded_at',
    'backend_decision_id',
    'intake',
    'expired-empty',
    'expired-pending',
  ])(
    'rereads original context and fresh time after an observed lock wait: %s',
    async (change) => {
      const snapshot = await candidate();
      if (change === 'expired-pending')
        expect(await prepare(first).preparePending(snapshot)).toEqual({
          action: 'prepared',
          row: pending,
        });
      const before = await ledger();
      clock.mockClear();
      const contenderPid = await pid(second);
      const guard = await observer.connect();
      let competing: Promise<unknown> | undefined;
      try {
        await guard.query('BEGIN');
        await guard.query(
          "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE",
          [SENDER],
        );
        competing = prepare(second)
          .preparePending(snapshot)
          .then(
            (value) => ({ value }),
            () => ({ rejected: true }),
          );
        await waitForBlock(guard, contenderPid);
        expect(clock).not.toHaveBeenCalled();
        if (
          change === 'post_attempted_at' ||
          change === 'receipt_recorded_at'
        ) {
          const sql =
            change === 'post_attempted_at'
              ? "UPDATE human_decision_reservations SET post_attempted_at=post_attempted_at+interval '1 second' WHERE sender_id=$1"
              : "UPDATE human_decision_reservations SET receipt_recorded_at=receipt_recorded_at+interval '1 second' WHERE sender_id=$1";
          await guard.query(sql, [SENDER]);
        }
        if (change === 'backend_decision_id')
          await guard.query(
            'UPDATE human_decision_reservations SET backend_decision_id=$2 WHERE sender_id=$1',
            [SENDER, PRODUCT],
          );
        if (change === 'intake')
          await guard.query(
            "UPDATE human_decision_reservations SET intake=jsonb_set(intake, '{productId}', to_jsonb($2::text)) WHERE sender_id=$1",
            [SENDER, ID],
          );
        if (change.startsWith('expired')) now = END;
        const expectedContext =
          await new PostgresExpirationApplicationContextStore(
            guard,
          ).readRecordedForSender(SENDER);
        await guard.query('COMMIT');
        expect(await competing).toEqual({
          value:
            change === 'unchanged'
              ? { action: 'prepared', row: pending }
              : { action: 'hold' },
        });
        expect(
          await new PostgresExpirationApplicationContextStore(
            guard,
          ).readRecordedForSender(SENDER),
        ).toEqual(expectedContext);
      } finally {
        try {
          await guard.query('ROLLBACK');
        } finally {
          try {
            await competing;
          } finally {
            guard.release();
          }
        }
      }
      expect(await ledger()).toEqual(
        change === 'unchanged'
          ? { action: 'foundPending', row: pending }
          : before,
      );
      expect(clock).toHaveBeenCalledTimes(
        change === 'unchanged' || change.startsWith('expired') ? 1 : 0,
      );
      await idle(second);
    },
  );
  it('two observably blocked preparations commit one pending row, not exclusive send authority', async () => {
    const snapshot = await candidate();
    const before = await context();
    const pids = [await pid(first), await pid(second)];
    expect(pids[0]).not.toBe(pids[1]);
    const guard = await observer.connect();
    let competing: Promise<unknown>[] = [];
    try {
      await guard.query('BEGIN');
      await guard.query(
        'SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 FOR UPDATE',
        [SENDER],
      );
      competing = [first, second].map((pool) =>
        prepare(pool)
          .preparePending(snapshot)
          .then(
            (value) => ({ value }),
            () => ({ rejected: true }),
          ),
      );
      for (const target of pids) await waitForBlock(guard, target);
      expect(clock).not.toHaveBeenCalled();
      await guard.query('COMMIT');
      expect(await Promise.all(competing)).toEqual([
        { value: { action: 'prepared', row: pending } },
        { value: { action: 'prepared', row: pending } },
      ]);
    } finally {
      try {
        await guard.query('ROLLBACK');
      } finally {
        try {
          await Promise.all(competing);
        } finally {
          guard.release();
        }
      }
    }
    expect(await ledger()).toEqual({ action: 'foundPending', row: pending });
    expect(await context()).toEqual(before);
    await idle(first);
    await idle(second);
  });
  it('replays via a fresh pool and holds a divergent pending row without changing context', async () => {
    const snapshot = await candidate();
    const before = await context();
    expect(await prepare(first).preparePending(snapshot)).toEqual({
      action: 'prepared',
      row: pending,
    });
    const fresh = new Pool({
      connectionString: container!.getConnectionUri(),
      max: 1,
    });
    try {
      expect(await prepare(fresh).preparePending(snapshot)).toEqual({
        action: 'prepared',
        row: pending,
      });
    } finally {
      await fresh.end();
    }
    await observer.query('TRUNCATE expiration_application_ledger');
    const divergent = { ...pending, branchId: 'other' };
    expect(
      await new PostgresExpirationApplicationLedgerStore(
        observer,
      ).insertPending(divergent),
    ).toEqual({ action: 'inserted', row: divergent });
    expect(await prepare(second).preparePending(snapshot)).toEqual({
      action: 'hold',
    });
    expect(await ledger()).toEqual({ action: 'foundPending', row: divergent });
    expect(await context()).toEqual(before);
    await idle(second);
  });
});
