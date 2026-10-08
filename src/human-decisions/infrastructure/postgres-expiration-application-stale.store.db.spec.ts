import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
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
import { PostgresExpirationApplicationStaleStore } from './postgres-expiration-application-stale.store';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';
import { PostgresExpirationApplicationPreparationStore } from './postgres-expiration-application-preparation.store';

// Existing-behavior proof, not retroactive RED. Synthetic GET/seeded receipt are
// not remote provenance. No WhatsApp, ACK, closure, OS restart or ambiguous
// COMMIT/disconnect proof. The explicit rollback below aborts BEFORE COMMIT.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const TOKEN = '55555555-5555-4555-8555-555555555555';
const AT = '2026-06-23T08:00:00.000Z';
const END = '2026-06-24T08:00:00.000Z';
const BRANCH = ' branch ';
const SENDER = 'customer';
const hold = { action: 'hold' };
const intake = {
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: ID,
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
    productId: ID,
    productName: 'Food',
    unit: 'PZA',
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
  resolution: {
    action: 'PROVIDE_EXPIRATION_TEXT',
    expirationText: 'March 2027',
    resolvedAt: AT,
  },
  applyBefore: END,
};
type Mode = 'claim' | 'stale';
const pid = async (pool: Pool) =>
  (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
    .pid;
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

ddescribe('EXPIRATION STALE versus begin-send in real PostgreSQL', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let first: Pool;
  let second: Pool;
  let observer: Pool;
  let candidate: ExpirationPreparationCandidate;
  let pending: ExpirationApplicationPendingRow;
  let now: string;
  const clocks = {
    claim: jest.fn(() => new Date(now)),
    stale: jest.fn(() => new Date(now)),
  };
  const run = async (mode: Mode, pool: Pool) =>
    (mode === 'claim'
      ? new PostgresExpirationApplicationClaimStore(
          pool,
          BRANCH,
          clocks.claim,
          () => TOKEN,
        ).claimPending(candidate)
      : new PostgresExpirationApplicationStaleStore(
          pool,
          BRANCH,
          clocks.stale,
        ).expirePending(candidate)
    ).catch(() => ({ action: 'unexpected_rejection' as const }));
  const context = () =>
    new PostgresExpirationApplicationContextStore(
      observer,
    ).readRecordedForSender(SENDER);
  const stale = () => ({
    action: 'recordedStale',
    row: { ...pending, state: 'STALE', staleObservedAt: END },
  });
  const started = () => ({
    action: 'claimed',
    row: {
      ...pending,
      state: 'SEND_STARTED',
      sendToken: TOKEN,
      attemptedAt: AT,
    },
  });
  const config = () => ({
    connectionString: container.getConnectionUri(),
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 12_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 20_000,
  });
  beforeAll(async () => {
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
    first = new Pool(config());
    second = new Pool(config());
    observer = new Pool(config());
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([
        first?.end(),
        second?.end(),
        observer?.end(),
      ]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
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
      (sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at)
      VALUES ($1, 'EXPIRATION', $2, 'ACTIVE', $3, 'RECEIPT_RECORDED', $4, $5, $5)`,
      [SENDER, SOURCE, JSON.stringify(intake), ID, AT],
    );
    const outcome = await new ExpirationExistingDecisionService(
      new PostgresExpirationApplicationContextStore(observer),
      { getExpirationDecision: jest.fn().mockResolvedValue(decision) },
      BRANCH,
    ).readExistingDecision(SENDER);
    const snapshot = createExpirationPreparationCandidate(SENDER, outcome, AT);
    if (snapshot.action !== 'candidate') throw new Error('Candidate required');
    candidate = snapshot;
    const prepared = await new PostgresExpirationApplicationPreparationStore(
      first,
      BRANCH,
      () => new Date(now),
    ).preparePending(candidate);
    if (prepared.action !== 'prepared') throw new Error('Pending required');
    pending = prepared.row;
    clocks.claim.mockClear();
    clocks.stale.mockClear();
  });
  const resolvedEvidence = () => ({
    outcome: 'resolved' as const,
    binding: candidate.binding,
    decision: candidate.decision,
  });
  it('inserts a missing STALE directly and preserves it on a later sweep', async () => {
    await observer.query('DELETE FROM expiration_application_ledger');
    now = END;
    const store = new PostgresExpirationApplicationStaleStore(
      first,
      BRANCH,
      clocks.stale,
    );
    const before = await context();
    expect(await store.expireResolvedOutcome(resolvedEvidence())).toEqual(
      stale(),
    );
    const stored = await observer.query<{ row_data: unknown }>(
      'SELECT row_data FROM expiration_application_ledger',
    );
    expect(stored.rows).toEqual([{ row_data: stale().row }]);
    expect(stored.rows[0].row_data).not.toHaveProperty('attemptedAt');
    expect(stored.rows[0].row_data).not.toHaveProperty('sendToken');
    expect(await store.expireResolvedOutcome(resolvedEvidence())).toEqual(hold);
    expect(
      (
        await observer.query(
          'SELECT row_data FROM expiration_application_ledger',
        )
      ).rows,
    ).toEqual(stored.rows);
    expect(await context()).toEqual(before);
  });
  it('holds an insert race without overwriting a concurrently inserted pending row', async () => {
    await observer.query('DELETE FROM expiration_application_ledger');
    now = END;
    const client = await first.connect();
    let raced = false;
    const competing = new PostgresExpirationApplicationLedgerStore(second);
    const wrapped = {
      connect: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (
            sql.includes('expiration_application_ledger') &&
            sql.includes('FOR UPDATE') &&
            result.rowCount === 0
          ) {
            raced = true;
            expect((await competing.insertPending(pending)).action).toBe(
              'inserted',
            );
          }
          return result;
        },
        release: () => client.release(),
      }),
    } as unknown as Pool;
    expect(
      await new PostgresExpirationApplicationStaleStore(
        wrapped,
        BRANCH,
        clocks.stale,
      ).expireResolvedOutcome(resolvedEvidence()),
    ).toEqual(hold);
    expect(raced).toBe(true);
    expect(await competing.readByDecision(ID)).toEqual({
      action: 'foundPending',
      row: pending,
    });
  });
  async function blocked(blocker: number, waiter: number, table: string) {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      // Observer is autocommit: activity snapshots are fresh on every probe.
      const result = await observer.query<{ blocked: boolean }>(
        `SELECT $1::int = ANY(pg_blocking_pids(pid))
        AND wait_event_type='Lock' AND position($3 in query)>0 AS blocked
        FROM pg_stat_activity WHERE pid=$2`,
        [blocker, waiter, table],
      );
      if (result.rows[0]?.blocked) return;
      await delay(10);
    }
    throw new Error('Expected distinct-session row lock was not observed');
  }
  async function idle(pool: Pool) {
    expect(
      (
        await observer.query(
          'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
          [await pid(pool)],
        )
      ).rows,
    ).toEqual([{ state: 'idle', xact_start: null }]);
  }
  async function replaysHold() {
    const fresh = new Pool(config());
    try {
      expect(await run('claim', fresh)).toEqual(hold);
      expect(await run('stale', fresh)).toEqual(hold);
      const ledger = new PostgresExpirationApplicationLedgerStore(fresh);
      expect(await ledger.readByDecision(ID)).toEqual(hold);
      expect(await ledger.insertPending(pending)).toEqual(hold);
    } finally {
      await fresh.end();
    }
  }
  it.each([
    ['claim', 'COMMIT'],
    ['claim', 'ROLLBACK'],
    ['stale', 'COMMIT'],
    ['stale', 'ROLLBACK'],
  ] as const)(
    '%s first, %s: only the committed eligible transition survives',
    async (mode, completion) => {
      const before = await context();
      const [leader, waiter] = [await pid(first), await pid(second)];
      expect(leader).not.toBe(waiter);
      const client = await first.connect();
      const reached = gate();
      const resume = gate();
      let atCommit = false;
      let settled = false;
      let primary: ReturnType<typeof run> | undefined;
      let competing: ReturnType<typeof run> | undefined;
      // Forward actual SQL unchanged, pausing only before COMMIT. Explicit abort
      // executes real ROLLBACK and throws; it never forges COMMIT success.
      const gated = {
        connect: async () => ({
          query: async (sql: string, values?: unknown[]) => {
            if (sql === 'COMMIT') {
              atCommit = true;
              reached.open();
              await resume.promise;
              if (completion === 'ROLLBACK') {
                await client.query('ROLLBACK');
                throw new Error('Explicit test abort before COMMIT');
              }
            }
            return client.query<Record<string, unknown>>(sql, values);
          },
          release: () => client.release(),
        }),
      } as unknown as Pool;
      try {
        now = mode === 'claim' ? AT : END;
        primary = run(mode, gated).then((value) => {
          settled = true;
          return value;
        });
        await Promise.race([reached.promise, primary]);
        expect(atCommit).toBe(true);
        expect(settled).toBe(false);
        now = END;
        const contender = mode === 'claim' ? 'stale' : 'claim';
        competing = run(contender, second);
        await blocked(leader, waiter, 'human_decision_reservations');
        expect(clocks[contender]).not.toHaveBeenCalled();
        resume.open();
        expect(await primary).toEqual(
          completion === 'COMMIT'
            ? mode === 'claim'
              ? started()
              : stale()
            : hold,
        );
        expect(await competing).toEqual(
          completion === 'ROLLBACK' && mode === 'claim' ? stale() : hold,
        );
      } finally {
        resume.open();
        await Promise.allSettled([primary, competing]);
        if (!primary) client.release();
      }
      // A reverted STALE leaves the pending opportunity, but the expired claim
      // cannot send. A fresh expiration operation must still be able to win.
      if (mode === 'stale' && completion === 'ROLLBACK') {
        expect(
          await new PostgresExpirationApplicationLedgerStore(
            observer,
          ).readByDecision(ID),
        ).toEqual({ action: 'foundPending', row: pending });
        expect(await run('stale', first)).toEqual(stale());
      }
      expect(await context()).toEqual(before);
      await replaysHold();
      await idle(first);
      await idle(second);
    },
  );
  it.each(['human_decision_reservations', 'expiration_application_ledger'])(
    'samples the deadline only after waiting on %s',
    async (table) => {
      const before = await context();
      const [leader, waiter] = [await pid(first), await pid(second)];
      expect(leader).not.toBe(waiter);
      const guard = await first.connect();
      let competing: ReturnType<typeof run> | undefined;
      try {
        await guard.query('BEGIN');
        const reservation = table === 'human_decision_reservations';
        await guard.query(
          reservation
            ? 'SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 FOR UPDATE'
            : 'SELECT decision_id FROM expiration_application_ledger WHERE decision_id=$1 FOR UPDATE',
          [reservation ? SENDER : ID],
        );
        competing = run('stale', second);
        await blocked(leader, waiter, table);
        expect(clocks.stale).not.toHaveBeenCalled();
        now = END;
        await guard.query('COMMIT');
        expect(await competing).toEqual(stale());
      } finally {
        try {
          await guard.query('ROLLBACK');
        } finally {
          await competing;
          guard.release();
        }
      }
      expect(clocks.stale).toHaveBeenCalledTimes(1);
      expect(await context()).toEqual(before);
      await replaysHold();
      await idle(second);
    },
  );
});
