import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ExpirationExistingDecisionService } from '../application/expiration-existing-decision.service';
import {
  createExpirationPreparationCandidate,
  type ExpirationPreparationCandidate,
} from '../application/expiration-preparation-candidate';
import type { ExpirationApplicationPendingRow } from '../domain/expiration-application-ledger.port';
import { PostgresExpirationApplicationClaimStore } from './postgres-expiration-application-claim.store';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';
import { PostgresExpirationApplicationPreparationStore } from './postgres-expiration-application-preparation.store';

// Existing-behavior proof, not retroactive RED. Only disposable PostgreSQL and
// real local adapters/migrations; the receipt is seeded and the GET synthetic.
// No backend/WhatsApp, send/ACK/STALE authority, activation, OS-process restart,
// or crash/COMMIT-disconnect proof. Enable with RUN_DOCKER_TESTS=1.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const TOKENS = [
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];
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
async function pid(pool: Pool) {
  return (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
    .rows[0].pid;
}
async function waitForLock(
  observer: PoolClient,
  target: number,
  table: string,
) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    // Activity query text is cached within the guard transaction; refresh it
    // as the contender moves from its reservation read to the ledger wait.
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const { rows } = await observer.query<{ blocked: boolean }>(
      `SELECT cardinality(pg_blocking_pids(pid)) > 0
       AND wait_event_type = 'Lock' AND position($2 in query) > 0 AS blocked
       FROM pg_stat_activity WHERE pid=$1`,
      [target, table],
    );
    if (rows[0]?.blocked) return;
    await delay(10);
  }
  throw new Error('Claim did not observably wait for the expected row lock');
}

ddescribe('EXPIRATION transactional claim with real PostgreSQL', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let first: Pool;
  let second: Pool;
  let observer: Pool;
  let candidate: ExpirationPreparationCandidate;
  let pending: ExpirationApplicationPendingRow;
  let now: string;
  const clock = jest.fn(() => new Date(now));
  const claim = (pool: Pool, token = TOKENS[0]) =>
    new PostgresExpirationApplicationClaimStore(
      pool,
      BRANCH,
      clock,
      () => token,
    )
      .claimPending(candidate)
      .catch(() => ({ action: 'unexpected_rejection' as const }));
  const context = () =>
    new PostgresExpirationApplicationContextStore(
      observer,
    ).readRecordedForSender(SENDER);
  const ledger = () =>
    new PostgresExpirationApplicationLedgerStore(observer).readByDecision(ID);
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
      throw new Error('Disposable EXPIRATION claim fixture setup failed');
    }
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([
        first?.end(),
        second?.end(),
        observer?.end(),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Claim fixture pool cleanup failed');
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    now = AT;
    await observer.query(
      'TRUNCATE expiration_application_ledger, human_decision_reservations',
    );
    await observer.query(
      `INSERT INTO human_decision_reservations
       (sender_id, route, request_key, status, intake, post_state,
        backend_decision_id, post_attempted_at, receipt_recorded_at)
       VALUES ($1, 'EXPIRATION', $2, 'ACTIVE', $3, 'RECEIPT_RECORDED', $4, $5, $5)`,
      [SENDER, SOURCE, JSON.stringify(intake), ID, AT],
    );
    const backend = {
      getExpirationDecision: jest.fn().mockResolvedValue(decision),
    };
    const outcome = await new ExpirationExistingDecisionService(
      new PostgresExpirationApplicationContextStore(observer),
      backend,
      BRANCH,
    ).readExistingDecision(SENDER);
    const snapshot = createExpirationPreparationCandidate(SENDER, outcome, AT);
    expect(backend.getExpirationDecision).toHaveBeenCalledWith(ID);
    if (snapshot.action !== 'candidate') throw new Error('Candidate required');
    candidate = snapshot;
    const prepared = await new PostgresExpirationApplicationPreparationStore(
      first,
      BRANCH,
      clock,
    ).preparePending(candidate);
    if (prepared.action !== 'prepared') throw new Error('Pending row required');
    pending = prepared.row;
    expect(await ledger()).toEqual({ action: 'foundPending', row: pending });
    clock.mockClear();
  });
  it('two observably blocked claims yield one committed winner; fresh-pool replay holds', async () => {
    const before = await context();
    const pids = [await pid(first), await pid(second)];
    expect(pids[0]).not.toBe(pids[1]);
    const guard = await observer.connect();
    let competing: ReturnType<typeof claim>[] = [];
    try {
      await guard.query('BEGIN');
      await guard.query(
        'SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 FOR UPDATE',
        [SENDER],
      );
      competing = [claim(first, TOKENS[0]), claim(second, TOKENS[1])];
      for (const target of pids)
        await waitForLock(guard, target, 'human_decision_reservations');
      expect(clock).not.toHaveBeenCalled();
      await guard.query('COMMIT');
      const results = await Promise.all(competing);
      expect(results.map((result) => result.action).sort()).toEqual([
        'claimed',
        'hold',
      ]);
      const winnerIndex = results.findIndex(
        (result) => result.action === 'claimed',
      );
      expect(results[winnerIndex]).toEqual({
        action: 'claimed',
        row: {
          ...pending,
          state: 'SEND_STARTED',
          sendToken: TOKENS[winnerIndex],
          attemptedAt: AT,
        },
      });
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
    expect(clock).toHaveBeenCalledTimes(1);
    expect(await context()).toEqual(before);
    expect(await ledger()).toEqual({ action: 'hold' });
    const fresh = new Pool({
      connectionString: container!.getConnectionUri(),
      max: 1,
    });
    try {
      expect(await claim(fresh)).toEqual({ action: 'hold' });
      expect(
        await new PostgresExpirationApplicationLedgerStore(fresh).insertPending(
          pending,
        ),
      ).toEqual({ action: 'hold' });
    } finally {
      await fresh.end();
    }
    expect(clock).toHaveBeenCalledTimes(1);
    await idle(first);
    await idle(second);
  });
  it.each(['human_decision_reservations', 'expiration_application_ledger'])(
    'expiration while waiting on %s preserves pending and original context',
    async (table) => {
      const before = await context();
      const target = await pid(second);
      const guard = await observer.connect();
      let competing: ReturnType<typeof claim> | undefined;
      try {
        await guard.query('BEGIN');
        const reservation = table === 'human_decision_reservations';
        await guard.query(
          reservation
            ? 'SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 FOR UPDATE'
            : 'SELECT decision_id FROM expiration_application_ledger WHERE decision_id=$1 FOR UPDATE',
          [reservation ? SENDER : ID],
        );
        competing = claim(second);
        await waitForLock(guard, target, table);
        expect(clock).not.toHaveBeenCalled();
        now = END;
        await guard.query('COMMIT');
        expect(await competing).toEqual({ action: 'hold' });
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
      expect(clock).toHaveBeenCalledTimes(1);
      expect(await ledger()).toEqual({ action: 'foundPending', row: pending });
      expect(await context()).toEqual(before);
      await idle(second);
    },
  );
});
