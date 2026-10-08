import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  ExpirationApplicationOutcomeCoordinator,
  type ExpirationApplicationOutcomePorts,
} from '../application/expiration-application-outcome-coordinator';
import { ExpirationRecoveryPoller } from '../application/expiration-recovery-poller';
import { ExpirationDeliveryService } from '../application/expiration-delivery.service';
import { PostgresExpirationRecoveryDiscoveryStore } from './postgres-expiration-recovery-discovery.store';
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
import { PostgresExpirationApplicationContextStore as Context } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore as Ledger } from './postgres-expiration-application-ledger.store';
import { PostgresExpirationApplicationCompletionStore as Completion } from './postgres-expiration-application-completion.store';

// Existing-behavior proof, not retroactive RED. GET/inbound/send/report responses
// are synthetic, not remote provenance or HTTP concurrency proof. No live sends,
// out-of-band no-send proof, OS restart or ambiguous COMMIT injection. Disposable DBs only.
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

ddescribe('EXPIRATION outcome coordination with real PostgreSQL', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let first: Pool;
  let second: Pool;
  let observer: Pool;
  let candidate: ExpirationPreparationCandidate;
  let row: Terminal;
  let receipt: RestockApplicationOutcomeAck;
  let report: jest.MockedFunction<
    ExpirationApplicationOutcomePorts['recordRestockApplicationOutcome']
  >;
  const config = () => ({
    connectionString: container.getConnectionUri(),
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 12_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 20_000,
  });
  function run(pool: Pool) {
    const context = new Context(pool);
    const ledger = new Ledger(pool);
    const completion = new Completion(pool, BRANCH);
    return new ExpirationApplicationOutcomeCoordinator(
      {
        readRecordedForSender: (sender) =>
          context.readRecordedForSender(sender),
        readOutcomeByDecision: (id) => ledger.readOutcomeByDecision(id),
        recordOutcomeAck: (expected, ack) =>
          ledger.recordOutcomeAck(expected, ack),
        closeAcknowledged: (original, expected, ack) =>
          completion.closeAcknowledged(original, expected, ack),
        recordRestockApplicationOutcome: report,
      },
      BRANCH,
    ).finishOnce(candidate, row);
  }
  async function snapshot(pool: Pool = observer) {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT sender_id, route, request_key, status, intake, post_state,
      backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at
      FROM human_decision_reservations WHERE sender_id=$1`,
      [SENDER],
    );
    return {
      reservations: result.rows,
      outcome: await new Ledger(pool).readOutcomeByDecision(ID),
    };
  }
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
  async function seedRecorded() {
    await observer.query(
      'TRUNCATE expiration_application_ledger, human_decision_reservations',
    );
    await observer.query(
      `INSERT INTO human_decision_reservations
      (sender_id,route,request_key,status,intake,post_state,backend_decision_id,post_attempted_at,receipt_recorded_at)
      VALUES ($1,'EXPIRATION',$2,'ACTIVE',$3,'RECEIPT_RECORDED',$4,$5,$5)`,
      [SENDER, SOURCE, JSON.stringify(intake), ID, AT],
    );
  }
  async function seed(state: Terminal['state'], withAck = false) {
    await seedRecorded();
    const original = await new ExpirationExistingDecisionService(
      new Context(observer),
      { getExpirationDecision: jest.fn().mockResolvedValue(decision) },
      BRANCH,
    ).readExistingDecision(SENDER);
    const prepared = createExpirationPreparationCandidate(SENDER, original, AT);
    if (prepared.action !== 'candidate') throw new Error('Candidate required');
    candidate = prepared;
    expect(
      (
        await new PostgresExpirationApplicationPreparationStore(
          first,
          BRANCH,
          () => new Date(AT),
        ).preparePending(candidate)
      ).action,
    ).toBe('prepared');
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
    report = jest.fn().mockResolvedValue(receipt);
  }
  // Public poller lifecycle with real stores; only external GET, inbound and
  // provider/report responses are simulated. New instances are not OS crashes.
  function composePoller(
    pool: Pool,
    at: string,
    send: jest.Mock,
    failClose = false,
  ) {
    const context = new Context(pool);
    const ledger = new Ledger(pool);
    const completion = new Completion(pool, BRANCH);
    const claim = new PostgresExpirationApplicationClaimStore(
      pool,
      BRANCH,
      () => new Date(at),
    );
    const coordinator = new ExpirationApplicationOutcomeCoordinator(
      {
        readRecordedForSender: context.readRecordedForSender.bind(context),
        readOutcomeByDecision: ledger.readOutcomeByDecision.bind(ledger),
        recordOutcomeAck: ledger.recordOutcomeAck.bind(ledger),
        recordRestockApplicationOutcome: report,
        closeAcknowledged: failClose
          ? async () => ({ action: 'hold' as const })
          : completion.closeAcknowledged.bind(completion),
      },
      BRANCH,
    );
    const delivery = new ExpirationDeliveryService(
      {
        claimPending: claim.claimPending.bind(claim),
        recordAcceptance: ledger.recordAcceptance.bind(ledger),
        readLatest: async () => ({
          kind: 'found',
          observation: {
            senderId: SENDER,
            receivingPhoneNumberId: '123456',
            messageId: 'wamid.inbound',
            providerTimestampSeconds: String(Date.parse(AT) / 1000),
            observedAt: AT,
          },
        }),
        sendText: send,
      },
      BRANCH,
      '123456',
      () => new Date(at),
    );
    return new ExpirationRecoveryPoller(
      new PostgresExpirationRecoveryDiscoveryStore(pool),
      new ExpirationExistingDecisionService(
        context,
        { getExpirationDecision: jest.fn().mockResolvedValue(decision) },
        BRANCH,
      ),
      new PostgresExpirationApplicationPreparationStore(
        pool,
        BRANCH,
        () => new Date(at),
      ),
      () => new Date(at),
      delivery,
      ledger,
      coordinator,
      new PostgresExpirationApplicationStaleStore(
        pool,
        BRANCH,
        () => new Date(at),
      ),
    );
  }
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(20);
    }
    throw new Error('Composed poller did not reach expected durable state');
  }
  function acknowledgeReports() {
    report = jest.fn(async (id, request) => ({
      id,
      version: 2 as const,
      attemptId: request.attemptId,
      outcome: request.outcome,
      ackReceivedAt: END,
    }));
  }
  it.each(['none', 'report', 'closure'] as const)(
    'composes send through durable closure, recovering %s failure without resend',
    async (failure) => {
      await seedRecorded();
      acknowledgeReports();
      if (failure === 'report')
        report.mockRejectedValueOnce(
          new Error('simulated unavailable backend'),
        );
      const send = jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'wamid.accepted' });
      const poller = composePoller(first, AT, send, failure === 'closure');
      poller.start();
      try {
        await until(async () => report.mock.calls.length === 1);
      } finally {
        await poller.stop();
      }
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({
        to: SENDER,
        text: expect.stringContaining('Food') as unknown,
      });
      const before = await snapshot();
      expect(before.reservations[0].status).toBe(
        failure === 'none' ? 'CLOSED' : 'ACTIVE',
      );
      expect(before.outcome).toMatchObject({
        action: 'foundOutcome',
        row: {
          state: 'PROVIDER_ACCEPTED',
          providerMessageId: 'wamid.accepted',
        },
        receipt: failure === 'report' ? null : { outcome: 'PROVIDER_ACCEPTED' },
      });
      if (failure !== 'none') {
        const fresh = new Pool(config());
        const recovery = composePoller(fresh, END, send);
        recovery.start();
        try {
          await until(
            async () => (await snapshot()).reservations[0].status === 'CLOSED',
          );
        } finally {
          await recovery.stop();
          await fresh.end();
        }
      }
      expect(send).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(failure === 'report' ? 2 : 1);
      const after = await snapshot();
      expect(after.reservations[0].status).toBe('CLOSED');
      expect(after.outcome).toMatchObject({
        action: 'foundOutcome',
        receipt: { outcome: 'PROVIDER_ACCEPTED' },
      });
      expect(
        await new PostgresExpirationRecoveryDiscoveryStore(
          observer,
        ).discoverRecordedHints({ limit: 1, afterRequestKey: null }),
      ).toEqual({ action: 'page', hints: [], nextCursor: null });
    },
  );
  it.each([false, true])(
    'recovers STALE to ACK/closure across fresh pollers without send (prepared=%s)',
    async (prepared) => {
      await seedRecorded();
      if (prepared) {
        const original = await new ExpirationExistingDecisionService(
          new Context(first),
          { getExpirationDecision: jest.fn().mockResolvedValue(decision) },
          BRANCH,
        ).readExistingDecision(SENDER);
        const input = createExpirationPreparationCandidate(
          SENDER,
          original,
          AT,
        );
        if (input.action !== 'candidate') throw new Error('Candidate required');
        expect(
          (
            await new PostgresExpirationApplicationPreparationStore(
              first,
              BRANCH,
              () => new Date(AT),
            ).preparePending(input)
          ).action,
        ).toBe('prepared');
      }
      acknowledgeReports();
      const send = jest.fn();
      const poller = composePoller(first, END, send);
      poller.start();
      try {
        await until(
          async () =>
            (await new Ledger(observer).readOutcomeByDecision(ID)).action ===
            'foundOutcome',
        );
      } finally {
        await poller.stop();
      }
      expect(report).not.toHaveBeenCalled();
      expect((await snapshot()).outcome).toMatchObject({
        action: 'foundOutcome',
        row: { state: 'STALE' },
        receipt: null,
      });
      const fresh = new Pool(config());
      const recovery = composePoller(fresh, END, send);
      recovery.start();
      try {
        await until(
          async () => (await snapshot()).reservations[0].status === 'CLOSED',
        );
      } finally {
        await recovery.stop();
        await fresh.end();
      }
      expect(send).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(ID, {
        attemptId: expect.any(String) as unknown,
        expectedResolutionVersion: 2,
        outcome: 'STALE',
      });
      expect((await snapshot()).outcome).toMatchObject({
        action: 'foundOutcome',
        receipt: { outcome: 'STALE' },
      });
    },
  );
  async function freshAndStable(expected: unknown) {
    const calls = report.mock.calls.length;
    const fresh = new Pool(config());
    try {
      expect(await run(fresh)).toEqual(hold);
      expect(report).toHaveBeenCalledTimes(calls);
      expect(await snapshot(fresh)).toEqual(expected);
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
    ['PROVIDER_ACCEPTED', false],
    ['PROVIDER_ACCEPTED', true],
    ['STALE', false],
    ['STALE', true],
    ['PROVIDER_ACCEPTED_LATE', false],
    ['PROVIDER_ACCEPTED_LATE', true],
  ] as const)(
    '%s / existing ACK=%s persists evidence and only closes eligible work',
    async (state, withAck) => {
      await seed(state, withAck);
      const before = await snapshot();
      expect(before.outcome).toEqual({
        action: 'foundOutcome',
        row,
        receipt: withAck ? receipt : null,
      });
      expect(await run(first)).toEqual(
        state === 'PROVIDER_ACCEPTED_LATE' ? hold : closed,
      );
      expect(report).toHaveBeenCalledTimes(withAck ? 0 : 1);
      if (!withAck)
        expect(report).toHaveBeenCalledWith(ID, {
          attemptId: row.attemptId,
          expectedResolutionVersion: 2,
          outcome: state,
          ...(row.state === 'STALE'
            ? {}
            : {
                attemptedAt: AT,
                providerMessageId: 'opaque',
                providerAcceptedObservedAt: row.providerAcceptedObservedAt,
              }),
        });
      const after = {
        reservations: [
          {
            ...before.reservations[0],
            status: state === 'PROVIDER_ACCEPTED_LATE' ? 'ACTIVE' : 'CLOSED',
          },
        ],
        outcome: { action: 'foundOutcome', row, receipt },
      };
      expect(await snapshot()).toEqual(after);
      await freshAndStable(after);
    },
  );
  it.each(['mismatch', 'rejection'])(
    'holds backend %s without changing any durable evidence',
    async (failure) => {
      await seed('STALE');
      const before = await snapshot();
      if (failure === 'mismatch')
        report.mockResolvedValue({ ...receipt, id: SOURCE });
      else report.mockRejectedValue(new Error('Simulated backend failure'));
      expect(await run(first)).toEqual(hold);
      expect(report).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each(['COMMIT', 'ROLLBACK'])(
    'retains durable ACK across %s context drift while closure waits',
    async (finish) => {
      await seed('STALE');
      const before = await snapshot();
      const [leader, waiter] = [await pid(second), await pid(first)];
      expect(leader).not.toBe(waiter);
      const guard = await second.connect();
      let running: ReturnType<typeof run> | undefined;
      let settled = false;
      // Controlled concurrent context writer, not production overwrite permission.
      report.mockImplementation(async () => {
        await guard.query('BEGIN');
        await guard.query(
          'UPDATE human_decision_reservations SET backend_decision_id=$2 WHERE sender_id=$1',
          [SENDER, SOURCE],
        );
        return receipt;
      });
      try {
        running = run(first).then((result) => {
          settled = true;
          return result;
        });
        const until = Date.now() + 5_000;
        let blocked = false;
        while (Date.now() < until && !settled) {
          const activity = await observer.query<{ blocked: boolean }>(
            `SELECT $1::int=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
          AND position('human_decision_reservations' in query)>0 AS blocked
          FROM pg_stat_activity WHERE pid=$2`,
            [leader, waiter],
          );
          if (activity.rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
        // ACK is already committed and independently visible before close finishes.
        expect(await snapshot()).toEqual({
          ...before,
          outcome: { action: 'foundOutcome', row, receipt },
        });
        await guard.query(finish);
        expect(await running).toEqual(finish === 'COMMIT' ? hold : closed);
      } finally {
        try {
          await guard.query('ROLLBACK');
        } finally {
          await running;
          guard.release();
        }
      }
      expect(report).toHaveBeenCalledTimes(1);
      const after = {
        reservations: [
          {
            ...before.reservations[0],
            status: finish === 'COMMIT' ? 'ACTIVE' : 'CLOSED',
            backend_decision_id: finish === 'COMMIT' ? SOURCE : ID,
          },
        ],
        outcome: { action: 'foundOutcome', row, receipt },
      };
      expect(await snapshot()).toEqual(after);
      await freshAndStable(after);
    },
  );
});
