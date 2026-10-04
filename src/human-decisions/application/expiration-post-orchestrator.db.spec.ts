/** INACTIVE EXPIRATION POST orchestration, PostgreSQL integration (I1/I2): a
 * real ExpirationPostOrchestrator over a real PostgresExpirationPostClaimStore
 * on disposable PostgreSQL, with only submitExpirationIntake mocked. A
 * test-only wrapper gates beginPost until both prepares arrive and the guard
 * row lock proves both claim UPDATEs observably wait; atomicity stays in the
 * store. No DI, runtime, GET/ACK, ingress, backend reads or process restart. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  ExpirationPostOrchestrator,
  type ExpirationPostOrchestrationOutcome,
  type ExpirationPostStorePort,
} from './expiration-post-orchestrator.service';
import { PostgresExpirationPostClaimStore } from '../infrastructure/postgres-expiration-post-claim.store';
import type { ExpirationIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import type { ExpirationIntakeReceipt } from '../../chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto';

const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const DECISION = '99999999-9999-4999-8999-999999999999';
const SEED = `INSERT INTO human_decision_reservations
 (sender_id, route, request_key, status, intake, post_state, backend_decision_id,
  post_attempted_at, receipt_recorded_at, unknown_observed_at)
 VALUES ($1, 'EXPIRATION', $2, 'ACTIVE', $3::jsonb, $4, NULL, NULL, NULL, NULL)`;

const intake = (): ExpirationIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: null,
});
const input = () => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  intake: intake(),
});
const receipt = (): ExpirationIntakeReceipt => ({
  id: DECISION,
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-06-22T12:00:00.000Z',
  snapshot: {
    branchId: 'branch-1',
    branchName: 'Sucursal Centro',
    productId: PRODUCT,
    productName: 'Collar',
    unit: 'pieza',
    variantId: null,
    variantName: null,
    variantOption: null,
    variantValue: null,
  },
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
});

type MockClient = { submitExpirationIntake: jest.Mock };
const mockedClient = (
  impl: () => Promise<ExpirationIntakeReceipt>,
): MockClient => ({ submitExpirationIntake: jest.fn(impl) as jest.Mock });

/** Test-only barrier: both prepares must land before either claim starts. */
class ClaimBarrier {
  private prepared = 0;
  private bothResolve!: () => void;
  private releaseResolve!: () => void;
  private readonly both = new Promise<void>((resolve) => {
    this.bothResolve = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });
  constructor(private readonly participants = 2) {}
  markPrepared(): void {
    this.prepared += 1;
    if (this.prepared >= this.participants) this.bothResolve();
  }
  async waitBothPrepared(): Promise<void> {
    const controller = new AbortController();
    try {
      await Promise.race([
        this.both,
        delay(5_000, undefined, { signal: controller.signal }).then(() => {
          throw new Error('both prepares did not arrive');
        }),
      ]);
    } finally {
      controller.abort();
    }
  }
  release(): void {
    this.releaseResolve();
  }
  async waitRelease(): Promise<void> {
    await this.released;
  }
}

/** Delegates every operation to the real store and only gates beginPost. */
class BarrierStore implements ExpirationPostStorePort {
  constructor(
    private readonly real: PostgresExpirationPostClaimStore,
    private readonly barrier: ClaimBarrier,
  ) {}
  async preparePost(input: unknown) {
    const decision = await this.real.preparePost(input);
    this.barrier.markPrepared();
    return decision;
  }
  async beginPost(input: unknown) {
    await this.barrier.waitBothPrepared();
    await this.barrier.waitRelease();
    return this.real.beginPost(input);
  }
  recordReceipt(input: unknown) {
    return this.real.recordReceipt(input);
  }
  markUnknown(input: unknown) {
    return this.real.markUnknown(input);
  }
}

ddescribe('EXPIRATION POST orchestration (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let setup: Pool;
  let left: Pool;
  let right: Pool;

  const store = (pool: Pool) => new PostgresExpirationPostClaimStore(pool);
  const tableRows = async () =>
    (await setup.query('SELECT * FROM human_decision_reservations'))
      .rows as Record<string, unknown>[];
  const seed = (postState: string | null = null) =>
    setup.query(SEED, [SENDER, SOURCE, JSON.stringify(intake()), postState]);
  const waitForTwoLockedUpdates = async (observer: PoolClient) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await observer.query('SELECT pg_stat_clear_snapshot()');
      const { rows } = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE state = 'active' AND wait_event_type = 'Lock'
           AND query LIKE 'UPDATE human_decision_reservations%'`,
      );
      if (rows[0].n >= 2) return;
      await delay(20);
    }
    throw new Error('two claim UPDATEs did not observably wait on the row');
  };
  const overlap = async (
    first: ExpirationPostOrchestrator,
    second: ExpirationPostOrchestrator,
    barrier: ClaimBarrier,
  ): Promise<ExpirationPostOrchestrationOutcome[]> => {
    const drained = Promise.allSettled([
      first.orchestrateExpirationPost(input()),
      second.orchestrateExpirationPost(input()),
    ]);
    const guard = await setup.connect();
    let open = false;
    let failure: Error | undefined;
    try {
      await barrier.waitBothPrepared();
      await guard.query('BEGIN');
      open = true;
      await guard.query(
        'SELECT sender_id FROM human_decision_reservations WHERE sender_id = $1 FOR UPDATE',
        [SENDER],
      );
      barrier.release();
      await waitForTwoLockedUpdates(guard);
      await guard.query('COMMIT');
      open = false;
    } catch (error) {
      failure = error instanceof Error ? error : new Error('overlap failed');
    } finally {
      barrier.release();
      try {
        if (open) await guard.query('ROLLBACK');
      } catch (error) {
        failure ??=
          error instanceof Error ? error : new Error('rollback failed');
      } finally {
        guard.release();
      }
    }
    const settled = await drained;
    if (failure !== undefined) throw failure;
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    return settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
  };
  const nonAuthorizing = (outcomes: ExpirationPostOrchestrationOutcome[]) =>
    outcomes.filter(
      (outcome) =>
        (outcome.action === 'hold' && outcome.reason === 'post_in_flight') ||
        outcome.action === 'historical_receipt',
    );

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
          '2800000000000',
          '--timestamp',
        ],
        {
          cwd: ROOT,
          env: { DATABASE_URL: container.getConnectionUri() },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
      const config = {
        connectionString: container.getConnectionUri(),
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 10_000,
        query_timeout: 15_000,
        statement_timeout: 12_000,
        lock_timeout: 10_000,
      };
      setup = new Pool({ ...config, max: 3 });
      left = new Pool({ ...config, max: 1 });
      right = new Pool({ ...config, max: 1 });
    } catch {
      throw new Error('disposable PostgreSQL orchestration fixture failed');
    }
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([
        setup?.end(),
        left?.end(),
        right?.end(),
      ]);
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('orchestration fixture pool cleanup failed');
      }
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await setup.query('TRUNCATE human_decision_reservations');
  });

  it('runs two concurrent orchestrators to exactly one real POST', async () => {
    await seed(null);
    const barrier = new ClaimBarrier();
    const firstClient = mockedClient(async () => receipt());
    const secondClient = mockedClient(async () => receipt());
    const outcomes = await overlap(
      new ExpirationPostOrchestrator(
        new BarrierStore(store(left), barrier),
        firstClient,
      ),
      new ExpirationPostOrchestrator(
        new BarrierStore(store(right), barrier),
        secondClient,
      ),
      barrier,
    );

    expect(
      firstClient.submitExpirationIntake.mock.calls.length +
        secondClient.submitExpirationIntake.mock.calls.length,
    ).toBe(1);
    expect(
      outcomes.filter((outcome) => outcome.action === 'receipt_recorded'),
    ).toHaveLength(1);
    expect(nonAuthorizing(outcomes)).toHaveLength(1);

    const rows = await tableRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ACTIVE',
      post_state: 'RECEIPT_RECORDED',
      backend_decision_id: DECISION,
      unknown_observed_at: null,
      intake: intake(),
    });
    expect(rows[0].post_attempted_at).toBeInstanceOf(Date);
    expect(rows[0].receipt_recorded_at).toBeInstanceOf(Date);
  });

  it('keeps an ambiguous timeout blocked and never resends when re-invoked', async () => {
    await seed(null);
    const failing = mockedClient(async () => {
      throw new Error('simulated transport timeout');
    });
    await expect(
      new ExpirationPostOrchestrator(
        store(left),
        failing,
      ).orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(failing.submitExpirationIntake).toHaveBeenCalledTimes(1);

    const rows = await tableRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ACTIVE',
      post_state: 'UNKNOWN',
      backend_decision_id: null,
      receipt_recorded_at: null,
      intake: intake(),
    });
    expect(rows[0].post_attempted_at).toBeInstanceOf(Date);
    expect(rows[0].unknown_observed_at).toBeInstanceOf(Date);

    const fresh = mockedClient(async () => receipt());
    await expect(
      new ExpirationPostOrchestrator(
        store(right),
        fresh,
      ).orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'blocked', reason: 'prepare_unknown_row' });
    expect(fresh.submitExpirationIntake).not.toHaveBeenCalled();
    expect(await tableRows()).toEqual(rows);
  });

  it('persists a receipt and does not resend on a fresh orchestration', async () => {
    await seed(null);
    const first = mockedClient(async () => receipt());
    await expect(
      new ExpirationPostOrchestrator(
        store(left),
        first,
      ).orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'receipt_recorded',
      backendDecisionId: DECISION,
    });
    expect(first.submitExpirationIntake).toHaveBeenCalledTimes(1);

    const recorded = await tableRows();
    expect(recorded[0]).toMatchObject({
      status: 'ACTIVE',
      post_state: 'RECEIPT_RECORDED',
      backend_decision_id: DECISION,
      unknown_observed_at: null,
      intake: intake(),
    });
    expect(recorded[0].post_attempted_at).toBeInstanceOf(Date);
    expect(recorded[0].receipt_recorded_at).toBeInstanceOf(Date);

    const fresh = mockedClient(async () => receipt());
    await expect(
      new ExpirationPostOrchestrator(
        store(right),
        fresh,
      ).orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'blocked', reason: 'prepare_unknown_row' });
    expect(fresh.submitExpirationIntake).not.toHaveBeenCalled();
    expect(await tableRows()).toEqual(recorded);
  });
});
