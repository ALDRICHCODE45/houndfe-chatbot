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
import type { ExpirationApplicationLedgerRow } from '../domain/expiration-application-ledger-row';
import type { RestockApplicationOutcomeAck } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { PostgresExpirationApplicationPreparationStore } from './postgres-expiration-application-preparation.store';
import { PostgresExpirationApplicationClaimStore } from './postgres-expiration-application-claim.store';
import { PostgresExpirationApplicationStaleStore } from './postgres-expiration-application-stale.store';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore as Ledger } from './postgres-expiration-application-ledger.store';
import { PostgresExpirationApplicationCompletionStore as Completion } from './postgres-expiration-application-completion.store';

// Existing-behavior proof, not retroactive RED. Synthetic GET/ACK are not remote
// provenance. No Meta sends, out-of-band no-send proof, OS restart or ambiguous
// COMMIT/crash injection. Explicit abort below rolls back BEFORE COMMIT.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const AT = '2026-06-23T08:00:00.000Z';
const END = '2026-06-24T08:00:00.000Z';
const BRANCH = ' branch ';
const SENDER = 'customer';
const hold = { action: 'hold' };
const closed = { action: 'closed' };
type Terminal = Extract<
  ExpirationApplicationLedgerRow,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' | 'STALE' }
>;
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
  applyBefore: END,
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
};
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

ddescribe('EXPIRATION completion transactions with real PostgreSQL', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let first: Pool;
  let second: Pool;
  let observer: Pool;
  let candidate: ExpirationPreparationCandidate;
  let row: Terminal;
  let receipt: RestockApplicationOutcomeAck;
  const config = () => ({
    connectionString: container.getConnectionUri(),
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 12_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 20_000,
  });
  const run = (pool: Pool) =>
    new Completion(pool, BRANCH)
      .closeAcknowledged(candidate, row, receipt)
      .catch(() => ({ action: 'unexpected_rejection' }));
  async function reservation() {
    const result = await observer.query<Record<string, unknown>>(
      `SELECT sender_id, route, request_key, status, intake, post_state,
      backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at
      FROM human_decision_reservations WHERE sender_id=$1`,
      [SENDER],
    );
    return result.rows;
  }
  const outcome = (pool: Pool = observer) =>
    new Ledger(pool).readOutcomeByDecision(ID);
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
        '3000000000000',
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
  async function seed(state: Terminal['state'], withAck = true) {
    await observer.query(
      'TRUNCATE expiration_application_ledger, human_decision_reservations',
    );
    await observer.query(
      `INSERT INTO human_decision_reservations
      (sender_id,route,request_key,status,intake,post_state,backend_decision_id,post_attempted_at,receipt_recorded_at)
      VALUES ($1,'EXPIRATION',$2,'ACTIVE',$3,'RECEIPT_RECORDED',$4,$5,$5)`,
      [SENDER, SOURCE, JSON.stringify(intake), ID, AT],
    );
    const original = await new ExpirationExistingDecisionService(
      new PostgresExpirationApplicationContextStore(observer),
      { getExpirationDecision: jest.fn().mockResolvedValue(decision) },
      BRANCH,
    ).readExistingDecision(SENDER);
    const snapshot = createExpirationPreparationCandidate(SENDER, original, AT);
    if (snapshot.action !== 'candidate') throw new Error('Candidate required');
    candidate = snapshot;
    const prepared = await new PostgresExpirationApplicationPreparationStore(
      first,
      BRANCH,
      () => new Date(AT),
    ).preparePending(candidate);
    expect(prepared.action).toBe('prepared');
    if (state === 'STALE') {
      const expired = await new PostgresExpirationApplicationStaleStore(
        first,
        BRANCH,
        () => new Date(END),
      ).expirePending(candidate);
      if (expired.action !== 'recordedStale') throw new Error('STALE required');
      row = expired.row;
    } else {
      const claimed = await new PostgresExpirationApplicationClaimStore(
        first,
        BRANCH,
        () => new Date(AT),
        () => ID,
      ).claimPending(candidate);
      if (claimed.action !== 'claimed') throw new Error('Claim required');
      const accepted = await new Ledger(first).recordAcceptance({
        row: claimed.row,
        event: {
          kind: 'provider_accepted',
          attemptId: claimed.row.attemptId,
          sendToken: ID,
          providerMessageId: 'opaque',
          providerAcceptedObservedAt: state === 'PROVIDER_ACCEPTED' ? AT : END,
        },
      });
      if (accepted.action !== 'updated') throw new Error('Acceptance required');
      row = accepted.row;
    }
    receipt = {
      id: ID,
      version: 2,
      attemptId: row.attemptId,
      outcome: row.state,
      ackReceivedAt: END,
    };
    if (withAck)
      expect(await new Ledger(first).recordOutcomeAck(row, receipt)).toEqual({
        action: 'updated',
        row,
        receipt,
      });
  }
  async function blocked(blocker: number, waiter: number, table: string) {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const result = await observer.query<{ blocked: boolean }>(
        `SELECT
        $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
        AND position($3 in query)>0 AS blocked FROM pg_stat_activity WHERE pid=$2`,
        [blocker, waiter, table],
      );
      if (result.rows[0]?.blocked) return;
      await delay(10);
    }
    throw new Error('Expected distinct-session row lock was not observed');
  }
  async function freshAndIdle(expected: unknown) {
    const fresh = new Pool(config());
    try {
      expect(await run(fresh)).toEqual(hold);
      expect(await outcome(fresh)).toEqual(expected);
    } finally {
      await fresh.end();
    }
    for (const pool of [first, second]) {
      const activity = await observer.query(
        'SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',
        [await pid(pool)],
      );
      expect(activity.rows).toEqual([{ state: 'idle', xact_start: null }]);
    }
  }
  it.each([
    ['STALE', 'COMMIT'],
    ['STALE', 'ROLLBACK'],
    ['PROVIDER_ACCEPTED', 'COMMIT'],
    ['PROVIDER_ACCEPTED', 'ROLLBACK'],
  ] as const)(
    '%s / %s: one durable close despite competing closer',
    async (state, completion) => {
      await seed(state);
      const before = await reservation();
      const evidence = await outcome();
      const [leader, waiter] = [await pid(first), await pid(second)];
      expect(leader).not.toBe(waiter);
      const client = await first.connect();
      const reached = gate();
      const resume = gate();
      let settled = false;
      let primary: ReturnType<typeof run> | undefined;
      let competing: ReturnType<typeof run> | undefined;
      const gated = {
        connect: async () => ({
          query: async (sql: string, values?: unknown[]) => {
            if (sql === 'COMMIT') {
              reached.open();
              await resume.promise;
              if (completion === 'ROLLBACK') {
                await client.query('ROLLBACK');
                throw new Error('Explicit test abort before COMMIT');
              }
            }
            return client.query(sql, values);
          },
          release: (error?: Error) => client.release(error),
        }),
      } as unknown as Pool;
      try {
        primary = run(gated).then((value) => {
          settled = true;
          return value;
        });
        await Promise.race([reached.promise, primary]);
        expect(settled).toBe(false);
        expect(
          (await client.query('SELECT status FROM human_decision_reservations'))
            .rows,
        ).toEqual([{ status: 'CLOSED' }]);
        expect(await reservation()).toEqual(before);
        competing = run(second);
        await blocked(leader, waiter, 'human_decision_reservations');
        resume.open();
        expect(await primary).toEqual(completion === 'COMMIT' ? closed : hold);
        expect(await competing).toEqual(
          completion === 'COMMIT' ? hold : closed,
        );
      } finally {
        resume.open();
        await Promise.allSettled([primary, competing]);
        if (!primary) client.release();
      }
      expect(await reservation()).toEqual([{ ...before[0], status: 'CLOSED' }]);
      expect(await outcome()).toEqual(evidence);
      await freshAndIdle(evidence);
    },
  );
  it.each([
    ['reservation', 'COMMIT'],
    ['reservation', 'ROLLBACK'],
    ['ack', 'COMMIT'],
    ['ack', 'ROLLBACK'],
  ] as const)(
    '%s / %s: closing rechecks evidence after its lock wait',
    async (change, completion) => {
      await seed('STALE');
      const before = await reservation();
      const evidence = await outcome();
      const replacement = {
        ...receipt,
        ackReceivedAt: '2026-06-24T08:01:00.000Z',
      };
      const [leader, waiter] = [await pid(first), await pid(second)];
      expect(leader).not.toBe(waiter);
      const guard = await first.connect();
      let competing: ReturnType<typeof run> | undefined;
      try {
        await guard.query('BEGIN');
        // Controlled concurrent writers, not production ACK-overwrite permission.
        await guard.query(
          change === 'reservation'
            ? 'UPDATE human_decision_reservations SET backend_decision_id=$2 WHERE sender_id=$1'
            : 'UPDATE expiration_application_ledger SET ack_receipt=$2::jsonb WHERE decision_id=$1',
          change === 'reservation'
            ? [SENDER, SOURCE]
            : [ID, JSON.stringify(replacement)],
        );
        competing = run(second);
        await blocked(
          leader,
          waiter,
          change === 'reservation'
            ? 'human_decision_reservations'
            : 'expiration_application_ledger',
        );
        await guard.query(completion);
        expect(await competing).toEqual(
          completion === 'COMMIT' ? hold : closed,
        );
      } finally {
        try {
          await guard.query('ROLLBACK');
        } finally {
          await competing;
          guard.release();
        }
      }
      expect(await reservation()).toEqual([
        {
          ...before[0],
          status: completion === 'COMMIT' ? 'ACTIVE' : 'CLOSED',
          backend_decision_id:
            completion === 'COMMIT' && change === 'reservation' ? SOURCE : ID,
        },
      ]);
      const expected =
        completion === 'COMMIT' && change === 'ack'
          ? { action: 'foundOutcome', row, receipt: replacement }
          : evidence;
      expect(await outcome()).toEqual(expected);
      await freshAndIdle(expected);
    },
  );
  it.each([
    ['STALE', false],
    ['PROVIDER_ACCEPTED', false],
    ['PROVIDER_ACCEPTED_LATE', true],
  ] as const)(
    '%s with ACK=%s holds without changing stored evidence',
    async (state, withAck) => {
      await seed(state, withAck);
      const before = await reservation();
      const evidence = await outcome();
      expect(await run(second)).toEqual(hold);
      expect(await reservation()).toEqual(before);
      expect(await outcome()).toEqual(evidence);
      await freshAndIdle(evidence);
    },
  );
});
