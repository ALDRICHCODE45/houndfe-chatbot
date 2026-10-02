import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ExpirationIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import {
  PostgresExpirationPostClaimStore,
  type ExpirationPrepareDecision,
} from './postgres-expiration-post-claim.store';

// Real-PostgreSQL proof for INACTIVE preparePost and beginPost CAS, gated by
// RUN_DOCKER_TESTS=1: actual adapter, schema 280, disposable postgres:16-alpine
// whose generated URI is the ONLY migration-child env (no ambient DATABASE_URL).
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const OTHER_SENDER = 'whatsapp:+5215500000002';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const DECISION = '99999999-9999-4999-8999-999999999999';
const UPPER = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
const AT = '2026-06-22T12:00:00.000Z';

const intake = (
  over: Partial<ExpirationIntakeInput> = {},
): ExpirationIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: null,
  ...over,
});
const input = (over: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  intake: intake(),
  ...over,
});
const restockIntake = JSON.stringify({
  sourceRequestId: SOURCE,
  type: 'RESTOCK',
  productId: PRODUCT,
  variantId: null,
});

type Metadata = Partial<Record<string, string | null>>;
type Settled = PromiseSettledResult<ExpirationPrepareDecision>;
type ClaimSettled = PromiseSettledResult<
  Awaited<ReturnType<PostgresExpirationPostClaimStore['beginPost']>>
>;
type Seed = Partial<{
  senderId: string;
  route: string;
  key: string;
  status: string;
  intake: string;
  meta: Metadata;
}>;

ddescribe('EXPIRATION preparePost CAS (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let setup: Pool;
  let left: Pool;
  let right: Pool;

  const store = (pool: Pool) => new PostgresExpirationPostClaimStore(pool);
  const snapshot = async () =>
    (await setup.query('SELECT * FROM human_decision_reservations'))
      .rows as Record<string, unknown>[];
  const seed = async (o: Seed = {}) => {
    const meta = o.meta ?? {};
    await setup.query(
      `INSERT INTO human_decision_reservations
       (sender_id, route, request_key, status, intake, post_state,
        backend_decision_id, post_attempted_at, receipt_recorded_at,
        unknown_observed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [
        o.senderId ?? SENDER,
        o.route ?? 'EXPIRATION',
        o.key ?? SOURCE,
        o.status ?? 'ACTIVE',
        o.intake ?? JSON.stringify(intake()),
        meta.post_state ?? null,
        meta.backend_decision_id ?? null,
        meta.post_attempted_at ?? null,
        meta.receipt_recorded_at ?? null,
        meta.unknown_observed_at ?? null,
      ],
    );
  };
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
    throw new Error('concurrent prepares did not observably wait on the row');
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
      throw new Error('disposable PostgreSQL prepare fixture setup failed');
    }
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([
        setup?.end(),
        left?.end(),
        right?.end(),
      ]);
      if (results.some((r) => r.status === 'rejected'))
        throw new Error('prepare fixture pool cleanup failed');
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await setup.query('TRUNCATE human_decision_reservations');
  });

  it('reserves one NULL row to RESERVED while every POST metadata stays NULL', async () => {
    await seed();
    await expect(store(left).preparePost(input())).resolves.toEqual({
      action: 'prepared',
    });
    const rows = await snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sender_id: SENDER,
      route: 'EXPIRATION',
      request_key: SOURCE,
      status: 'ACTIVE',
      post_state: 'RESERVED',
      backend_decision_id: null,
      post_attempted_at: null,
      receipt_recorded_at: null,
      unknown_observed_at: null,
      intake: intake(),
    });
  });

  it('reports already_prepared on a duplicate after a fresh store and pool connection', async () => {
    await seed();
    await store(left).preparePost(input());
    const before = await snapshot();
    await expect(
      new PostgresExpirationPostClaimStore(right).preparePost(input()),
    ).resolves.toEqual({ action: 'already_prepared' });
    expect(await snapshot()).toEqual(before);
  });

  it('accepts a non-null variant whose stored JSONB key order differs', async () => {
    const value = intake({ variantId: VARIANT });
    await seed({
      intake: JSON.stringify({
        variantId: VARIANT,
        productId: PRODUCT,
        type: 'EXPIRATION',
        sourceRequestId: SOURCE,
      }),
    });
    await expect(
      store(left).preparePost({
        senderId: SENDER,
        sourceRequestId: SOURCE,
        intake: value,
      }),
    ).resolves.toEqual({ action: 'prepared' });
    const rows = await snapshot();
    expect(rows[0]).toMatchObject({ post_state: 'RESERVED', intake: value });
  });

  it('serializes two overlapped prepares to one prepared and one already_prepared', async () => {
    await seed();
    const guard = await setup.connect();
    let open = false;
    let failure: unknown;
    let settled: Promise<Settled[]> | undefined;
    try {
      await guard.query('BEGIN');
      open = true;
      const locked = await guard.query(
        'SELECT sender_id FROM human_decision_reservations WHERE sender_id = $1 FOR UPDATE',
        [SENDER],
      );
      expect(locked.rows).toEqual([{ sender_id: SENDER }]);
      settled = Promise.allSettled([
        store(left).preparePost(input()),
        store(right).preparePost(input()),
      ]);
      await waitForTwoLockedUpdates(guard);
      await guard.query('COMMIT');
      open = false;
    } finally {
      try {
        if (open) await guard.query('ROLLBACK');
      } catch (error) {
        failure = error;
      } finally {
        guard.release(failure instanceof Error ? failure : undefined);
      }
      if (settled !== undefined) await settled;
    }
    const results = await settled;
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const decisions = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(decisions.filter((r) => r.action === 'prepared')).toHaveLength(1);
    expect(
      decisions.filter((r) => r.action === 'already_prepared'),
    ).toHaveLength(1);
    const rows = await snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].post_state).toBe('RESERVED');
  });

  it.each([
    ['wrong sender', {}, input({ senderId: OTHER_SENDER }), 'missing_row'],
    [
      'wrong source key',
      {},
      input({
        sourceRequestId: OTHER,
        intake: intake({ sourceRequestId: OTHER }),
      }),
      'missing_row',
    ],
    [
      'wrong route',
      {
        route: 'RESTOCK',
        intake: restockIntake,
        meta: { post_state: 'RESERVED' },
      },
      input(),
      'missing_row',
    ],
    ['CLOSED', { status: 'CLOSED' }, input(), 'unknown_row'],
    [
      'UNKNOWN',
      { meta: { post_state: 'UNKNOWN', unknown_observed_at: AT } },
      input(),
      'unknown_row',
    ],
    [
      'POST_IN_FLIGHT',
      { meta: { post_state: 'POST_IN_FLIGHT', post_attempted_at: AT } },
      input(),
      'unknown_row',
    ],
    [
      'RECEIPT_RECORDED',
      {
        meta: {
          post_state: 'RECEIPT_RECORDED',
          backend_decision_id: DECISION,
          post_attempted_at: AT,
          receipt_recorded_at: AT,
        },
      },
      input(),
      'unknown_row',
    ],
  ])(
    'blocks %s without mutating the persisted row',
    async (_name, over, call, reason) => {
      await seed(over);
      const before = await snapshot();
      await expect(store(left).preparePost(call)).resolves.toEqual({
        action: 'blocked',
        reason,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    ['productId', intake({ productId: OTHER })],
    ['variantId', intake({ variantId: VARIANT })],
  ])(
    'rejects a %s substitution sharing the same request key',
    async (_name, other) => {
      await seed();
      const before = await snapshot();
      await expect(
        store(left).preparePost({
          senderId: SENDER,
          sourceRequestId: SOURCE,
          intake: other,
        }),
      ).resolves.toEqual({ action: 'blocked', reason: 'intake_mismatch' });
      expect(await snapshot()).toEqual(before);
    },
  );

  it('binds a mixed-case key byte-for-byte and blocks the wrong case', async () => {
    const exact = intake({ sourceRequestId: UPPER });
    await seed({ key: UPPER, intake: JSON.stringify(exact) });
    const lower = UPPER.toLowerCase();
    const before = await snapshot();
    await expect(
      store(left).preparePost({
        senderId: SENDER,
        sourceRequestId: lower,
        intake: intake({ sourceRequestId: lower }),
      }),
    ).resolves.toEqual({ action: 'blocked', reason: 'missing_row' });
    expect(await snapshot()).toEqual(before);
    await expect(
      store(left).preparePost({
        senderId: SENDER,
        sourceRequestId: UPPER,
        intake: exact,
      }),
    ).resolves.toEqual({ action: 'prepared' });
    const rows = await snapshot();
    expect(rows[0]).toMatchObject({
      request_key: UPPER,
      post_state: 'RESERVED',
    });
  });

  it.each([
    ['null', null],
    ['extra key', { ...input(), extra: 1 }],
    [
      'unbound intake',
      {
        senderId: SENDER,
        sourceRequestId: SOURCE,
        intake: intake({ sourceRequestId: OTHER }),
      },
    ],
  ])(
    'fails a malformed caller (%s) before touching the row',
    async (_name, call) => {
      await seed();
      const before = await snapshot();
      await expect(store(left).preparePost(call)).resolves.toEqual({
        action: 'blocked',
        reason: 'malformed_input',
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  describe('beginPost authorization', () => {
    it('authorizes one RESERVED -> POST_IN_FLIGHT while other metadata stays NULL', async () => {
      await seed({ meta: { post_state: 'RESERVED' } });
      await expect(store(left).beginPost(input())).resolves.toEqual({
        action: 'authorize_post',
      });
      const rows = await snapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sender_id: SENDER,
        route: 'EXPIRATION',
        request_key: SOURCE,
        status: 'ACTIVE',
        post_state: 'POST_IN_FLIGHT',
        backend_decision_id: null,
        receipt_recorded_at: null,
        unknown_observed_at: null,
        intake: intake(),
      });
      expect(rows[0].post_attempted_at).toBeInstanceOf(Date);
      expect(Number.isNaN((rows[0].post_attempted_at as Date).getTime())).toBe(
        false,
      );
    });

    it('serializes two overlapped begins to one authorized and one held without a repeat', async () => {
      await seed({ meta: { post_state: 'RESERVED' } });
      const guard = await setup.connect();
      let open = false;
      let failure: unknown;
      let settled: Promise<ClaimSettled[]> | undefined;
      try {
        await guard.query('BEGIN');
        open = true;
        const locked = await guard.query(
          'SELECT sender_id FROM human_decision_reservations WHERE sender_id = $1 FOR UPDATE',
          [SENDER],
        );
        expect(locked.rows).toEqual([{ sender_id: SENDER }]);
        settled = Promise.allSettled([
          store(left).beginPost(input()),
          new PostgresExpirationPostClaimStore(right).beginPost(input()),
        ]);
        await waitForTwoLockedUpdates(guard);
        await guard.query('COMMIT');
        open = false;
      } finally {
        try {
          if (open) await guard.query('ROLLBACK');
        } catch (error) {
          failure = error;
        } finally {
          guard.release(failure instanceof Error ? failure : undefined);
        }
        if (settled !== undefined) await settled;
      }
      const results = await settled;
      const decisions = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      expect(results.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      expect(
        decisions.filter((r) => r.action === 'authorize_post'),
      ).toHaveLength(1);
      expect(decisions.filter((r) => r.action === 'hold')).toHaveLength(1);
      const after = await snapshot();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        post_state: 'POST_IN_FLIGHT',
        backend_decision_id: null,
        receipt_recorded_at: null,
        unknown_observed_at: null,
      });
      expect(after[0].post_attempted_at).toBeInstanceOf(Date);
      // A fresh store cannot authorize the same row a second time.
      await expect(
        new PostgresExpirationPostClaimStore(right).beginPost(input()),
      ).resolves.toEqual({ action: 'hold', reason: 'post_in_flight' });
      expect(await snapshot()).toEqual(after);
    });

    it.each([
      [
        'unprepared NULL',
        { meta: {} },
        input(),
        { action: 'blocked', reason: 'malformed_row' },
      ],
      [
        'CLOSED',
        { status: 'CLOSED', meta: { post_state: 'RESERVED' } },
        input(),
        { action: 'blocked', reason: 'unknown_row' },
      ],
      [
        'wrong sender',
        { meta: { post_state: 'RESERVED' } },
        input({ senderId: OTHER_SENDER }),
        { action: 'blocked', reason: 'missing_row' },
      ],
      [
        'substituted intake',
        { meta: { post_state: 'RESERVED' } },
        {
          senderId: SENDER,
          sourceRequestId: SOURCE,
          intake: intake({ productId: OTHER }),
        },
        { action: 'blocked', reason: 'intake_mismatch' },
      ],
    ])(
      'fails closed on %s without mutating the persisted row',
      async (_name, over, call, expectedDecision) => {
        await seed(over);
        const before = await snapshot();
        await expect(store(left).beginPost(call)).resolves.toEqual(
          expectedDecision,
        );
        expect(await snapshot()).toEqual(before);
      },
    );
  });

  describe('recordReceipt authorization', () => {
    const receipt = (
      decision = DECISION,
      over: Record<string, unknown> = {},
    ) => ({ ...input(over), backendDecisionId: decision });
    const inFlight = { post_state: 'POST_IN_FLIGHT', post_attempted_at: AT };

    it('records one POST_IN_FLIGHT receipt while preserving the attempt instant', async () => {
      await seed({ meta: inFlight });
      await expect(store(left).recordReceipt(receipt())).resolves.toEqual({
        action: 'record_receipt',
        backendDecisionId: DECISION,
      });
      const rows = await snapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: DECISION,
        unknown_observed_at: null,
        intake: intake(),
      });
      expect((rows[0].post_attempted_at as Date).toISOString()).toBe(AT);
      expect(rows[0].receipt_recorded_at).toBeInstanceOf(Date);
    });

    // Holds the row lock so the loser must wait, then re-read the committed
    // winner instead of racing: two identical ids must not double-record and
    // two different ids must keep one winner while the loser conflicts.
    it.each([
      ['identical', DECISION, DECISION, 'replay_receipt'],
      ['different', DECISION, OTHER, 'conflict'],
    ])(
      'serializes two overlapped %s receipts to one record and one %s',
      async (_name, first, second, loserAction) => {
        await seed({ meta: inFlight });
        const guard = await setup.connect();
        let open = false;
        let failure: unknown;
        let settled: Promise<ClaimSettled[]> | undefined;
        try {
          await guard.query('BEGIN');
          open = true;
          await guard.query(
            'SELECT sender_id FROM human_decision_reservations WHERE sender_id = $1 FOR UPDATE',
            [SENDER],
          );
          settled = Promise.allSettled([
            store(left).recordReceipt(receipt(first)),
            new PostgresExpirationPostClaimStore(right).recordReceipt(
              receipt(second),
            ),
          ]);
          await waitForTwoLockedUpdates(guard);
          await guard.query('COMMIT');
          open = false;
        } finally {
          try {
            if (open) await guard.query('ROLLBACK');
          } catch (error) {
            failure = error;
          } finally {
            guard.release(failure instanceof Error ? failure : undefined);
          }
          if (settled !== undefined) await settled;
        }
        const results = await settled;
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const decisions = results.flatMap((r) =>
          r.status === 'fulfilled' ? [r.value] : [],
        );
        const recorded = decisions.find((r) => r.action === 'record_receipt');
        expect(recorded).toBeDefined();
        expect(decisions.filter((r) => r.action === loserAction)).toHaveLength(
          1,
        );
        const winner = (recorded as { backendDecisionId: string })
          .backendDecisionId;
        const after = await snapshot();
        expect(after).toHaveLength(1);
        expect(after[0].backend_decision_id).toBe(winner);
        if (loserAction === 'conflict') {
          expect(decisions.find((r) => r.action === 'conflict')).toMatchObject({
            storedBackendDecisionId: winner,
          });
        }
      },
    );

    it('replays the same receipt and conflicts on a different id through a fresh store', async () => {
      await seed({ meta: inFlight });
      await store(left).recordReceipt(receipt());
      const after = await snapshot();
      const fresh = new PostgresExpirationPostClaimStore(right);
      await expect(fresh.recordReceipt(receipt())).resolves.toEqual({
        action: 'replay_receipt',
        backendDecisionId: DECISION,
      });
      await expect(fresh.recordReceipt(receipt(OTHER))).resolves.toEqual({
        action: 'conflict',
        storedBackendDecisionId: DECISION,
      });
      expect(await snapshot()).toEqual(after);
    });

    const blocks: Array<[string, Seed, string, unknown?]> = [
      ['unprepared NULL', { meta: {} }, 'malformed_row'],
      ['RESERVED', { meta: { post_state: 'RESERVED' } }, 'not_in_flight'],
      [
        'UNKNOWN',
        { meta: { post_state: 'UNKNOWN', unknown_observed_at: AT } },
        'unknown_state',
      ],
      ['CLOSED', { status: 'CLOSED', meta: inFlight }, 'unknown_row'],
      [
        'wrong route',
        { route: 'RESTOCK', intake: restockIntake, meta: inFlight },
        'missing_row',
      ],
      [
        'wrong sender',
        { meta: inFlight },
        'missing_row',
        receipt(DECISION, { senderId: OTHER_SENDER }),
      ],
      [
        'substituted intake',
        { meta: inFlight },
        'intake_mismatch',
        receipt(DECISION, { intake: intake({ productId: OTHER }) }),
      ],
    ];
    it.each(blocks)(
      'blocks %s without mutating the persisted row',
      async (_name, over, reason, call = receipt()) => {
        await seed(over);
        const before = await snapshot();
        await expect(store(left).recordReceipt(call)).resolves.toEqual({
          action: 'blocked',
          reason,
        });
        expect(await snapshot()).toEqual(before);
      },
    );
  });
});
