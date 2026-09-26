import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import type { RestockApplicationAcceptanceInput } from '../domain/restock-application-ledger.port';
import { PostgresRestockApplicationLedgerStore as Store } from './postgres-restock-application-ledger.store';

// Existing behavior, not retroactive RED. Synthetic evidence, LOCAL ledger only:
// no provider/backend HTTP, device delivery, send authority, reservation atomicity,
// history/source authority or crash proof. Two sessions, not all schedules.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const anyXmin: unknown = expect.any(String);
const SOURCE = 'AAAAAAAA-1111-4111-8111-111111111111';
const DECISION = 'BBBBBBBB-3333-4333-8333-333333333333';
const pending = () => ({
  state: 'PENDING_DELIVERY' as const,
  senderId: 'whatsapp:+5215500000001',
  branchId: '  branch-e\u0301  ',
  sourceRequestId: SOURCE,
  decisionId: DECISION,
  resolutionVersion: 2 as const,
  attemptId: deriveRestockAttemptId(SOURCE, DECISION)!,
  resolvedAt: '2026-06-22T01:00:00.000Z',
  applyBefore: '2026-06-22T02:00:00.000Z',
});
const begin = {
  kind: 'begin_send' as const,
  sendToken: 'CCCCCCCC-4444-4444-8444-444444444444',
  attemptedAt: '2026-06-22T01:30:00.000Z',
};
const started = () => ({
  ...pending(),
  state: 'SEND_STARTED' as const,
  sendToken: begin.sendToken,
  attemptedAt: begin.attemptedAt,
});
const acceptance = (
  late: boolean,
): RestockApplicationAcceptanceInput['event'] => ({
  kind: 'provider_accepted',
  attemptId: pending().attemptId,
  sendToken: begin.sendToken,
  providerMessageId: '  Provider-e\u0301  ',
  providerAcceptedObservedAt: late
    ? pending().applyBefore
    : '2026-06-22T01:45:00.000Z',
});
const terminal = (late: boolean) => ({
  ...started(),
  state: late
    ? ('PROVIDER_ACCEPTED_LATE' as const)
    : ('PROVIDER_ACCEPTED' as const),
  providerMessageId: acceptance(late).providerMessageId,
  providerAcceptedObservedAt: acceptance(late).providerAcceptedObservedAt,
});
type Terminal = Parameters<Store['recordOutcomeAck']>[0];
const receipt = (row: Terminal, alternate = false) => ({
  id: DECISION,
  version: 2 as const,
  attemptId: row.attemptId,
  outcome: row.state,
  // Valid server strings retained verbatim; no invented local-clock ordering.
  ackReceivedAt: alternate ? '2020-01-02T00:00:00Z' : '2020-01-01T00:00:00Z',
});
const persisted = async (client: PoolClient) =>
  (
    await client.query<Record<string, unknown>>(
      'SELECT *, xmin::text AS xmin FROM restock_application_ledger',
    )
  ).rows;
async function observeBlock(winner: PoolClient, wp: number, lp: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await winner.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers',
      [lp],
    );
    if (result.rows[0].blockers.includes(wp)) return;
    await delay(20);
  }
  throw new Error('Expected exact winner PID to block loser');
}

ddescribe('outcome controlled locks (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let first: Pool | undefined;
  let second: Pool | undefined;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    try {
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
          env: { DATABASE_URL: container.getConnectionUri() },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
    } catch {
      throw new Error('Disposable fixture migration to 250 failed');
    }
    const options = {
      connectionString: container.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 12_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 20_000,
    };
    first = new Pool(options);
    second = new Pool(options);
  });
  afterAll(async () => {
    try {
      const ended = await Promise.allSettled([first?.end(), second?.end()]);
      for (const result of ended)
        if (result.status === 'rejected') throw result.reason;
    } finally {
      await container?.stop();
    }
  });

  async function sessions(
    run: (a: PoolClient, b: PoolClient) => Promise<void>,
  ) {
    if (!first || !second) throw new Error('Fixture pools unavailable');
    let a: PoolClient | undefined;
    let b: PoolClient | undefined;
    try {
      a = await first.connect();
      b = await second.connect();
      await a.query('TRUNCATE TABLE restock_application_ledger');
      expect(await new Store(a).insertPending(pending())).toEqual({
        action: 'inserted',
        row: pending(),
      });
      await run(a, b);
    } finally {
      a?.release();
      b?.release();
    }
  }
  async function race<T>(
    a: PoolClient,
    b: PoolClient,
    win: () => Promise<T>,
    lose: () => Promise<T>,
    expected: T,
    losing: T,
  ) {
    let transaction = false;
    let loser: Promise<{ value: T } | { error: unknown }> | undefined;
    try {
      const [wp, lp] = await Promise.all([
        a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
        b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
      ]);
      expect(wp.rows[0].pid).not.toBe(lp.rows[0].pid);
      await a.query('BEGIN');
      transaction = true;
      // updated/recorded here is provisional until COMMIT, not durable proof.
      expect(await win()).toEqual(expected);
      const snapshot = await persisted(a);
      loser = lose().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await observeBlock(a, wp.rows[0].pid, lp.rows[0].pid);
      await a.query('COMMIT');
      transaction = false;
      const result = await loser;
      if ('error' in result) throw result.error;
      expect(result.value).toEqual(losing);
      expect(await persisted(b)).toEqual(snapshot);
      return snapshot;
    } finally {
      try {
        if (transaction) await a.query('ROLLBACK');
      } finally {
        // Normal cleanup, not fault injection. Timeouts bound failed rollback too.
        await loser;
      }
    }
  }
  async function seedStarted(store: Store) {
    expect(
      await store.transitionPending({ row: pending(), event: begin }),
    ).toEqual({
      action: 'updated',
      row: started(),
    });
  }
  async function assertRead(
    store: Store,
    row: Terminal,
    ack: ReturnType<typeof receipt>,
  ) {
    expect(await store.readByDecision(DECISION.toLowerCase())).toEqual({
      action: 'found',
      row,
      ack,
    });
  }

  it.each([false, true])(
    'acceptance late=%s wins; opposite observation holds',
    async (late) => {
      await sessions(async (a, b) => {
        const writer = new Store(a);
        const rival = new Store(b);
        await seedStarted(writer);
        const row = terminal(late);
        await race(
          a,
          b,
          () =>
            writer.recordAcceptance({
              row: started(),
              event: acceptance(late),
            }),
          () =>
            rival.recordAcceptance({
              row: started(),
              event: acceptance(!late),
            }),
          { action: 'updated', row },
          { action: 'hold' },
        );
        const ack = receipt(row);
        expect(await writer.recordOutcomeAck(row, ack)).toEqual({
          action: 'recorded',
          record: { row, receipt: ack },
        });
        const snapshot = await persisted(b);
        expect(snapshot).toEqual([
          {
            decision_id: DECISION.toLowerCase(),
            source_request_id: SOURCE.toLowerCase(),
            attempt_id: row.attemptId,
            sender_id: row.senderId,
            branch_id: row.branchId,
            row_data: row,
            ack_receipt: ack,
            xmin: anyXmin,
          },
        ]);
        expect(
          await rival.recordAcceptance({ row, event: acceptance(late) }),
        ).toEqual({
          action: 'replay',
          row,
        });
        expect(
          await rival.recordAcceptance({ row, event: acceptance(!late) }),
        ).toEqual({ action: 'hold' });
        expect(
          await rival.recordAcceptance({
            row: started(),
            event: acceptance(late),
          }),
        ).toEqual({ action: 'hold' });
        // Valid but different expected terminal evidence must not overwrite ACK.
        for (const altered of [
          { ...row, branchId: ' other-branch ' },
          { ...row, providerMessageId: ' other-provider ' },
        ])
          expect(await rival.recordOutcomeAck(altered, ack)).toEqual({
            action: 'hold',
          });
        expect(await rival.recordOutcomeAck(row, ack)).toEqual({
          action: 'replay',
          record: { row, receipt: ack },
        });
        await assertRead(rival, row, ack);
        expect(await persisted(b)).toEqual(snapshot);
      });
    },
  );

  it.each([
    ['identical', false, false],
    ['first timestamp', false, true],
    ['second timestamp', true, true],
  ] as const)('ACK race: %s wins', async (_name, alternate, different) => {
    await sessions(async (a, b) => {
      const writer = new Store(a);
      const rival = new Store(b);
      await seedStarted(writer);
      const row = terminal(alternate);
      expect(
        await writer.recordAcceptance({
          row: started(),
          event: acceptance(alternate),
        }),
      ).toEqual({ action: 'updated', row });
      const before = await persisted(a);
      const ack = receipt(row, alternate);
      const other = receipt(row, different ? !alternate : alternate);
      const record = { row, receipt: ack };
      const snapshot = await race(
        a,
        b,
        () => writer.recordOutcomeAck(row, ack),
        () => rival.recordOutcomeAck(row, other),
        { action: 'recorded', record },
        different ? { action: 'hold' } : { action: 'replay', record },
      );
      expect(snapshot).toEqual([
        { ...before[0], ack_receipt: ack, xmin: anyXmin },
      ]);
      expect(snapshot[0].xmin).not.toBe(before[0].xmin);
      // Identical loser exercises zero-row UPDATE followed by real READ.
      for (let replay = 0; replay < 2; replay++) {
        expect(await rival.recordOutcomeAck(row, ack)).toEqual({
          action: 'replay',
          record,
        });
      }
      await assertRead(rival, row, ack);
      expect(await persisted(b)).toEqual(snapshot);
    });
  });

  it('expires unsent to STALE then records and replays its bound ACK', async () => {
    await sessions(async (a, b) => {
      const writer = new Store(a);
      const row = {
        ...pending(),
        state: 'STALE' as const,
        staleObservedAt: pending().applyBefore,
      };
      expect(
        await writer.transitionPending({
          row: pending(),
          event: { kind: 'expire_unsent', observedAt: row.staleObservedAt },
        }),
      ).toEqual({ action: 'updated', row });
      const before = await persisted(a);
      const ack = receipt(row);
      const record = { row, receipt: ack };
      expect(await writer.recordOutcomeAck(row, ack)).toEqual({
        action: 'recorded',
        record,
      });
      const snapshot = await persisted(b);
      expect(snapshot).toEqual([
        { ...before[0], ack_receipt: ack, xmin: anyXmin },
      ]);
      const reader = new Store(b);
      expect(await reader.recordOutcomeAck(row, ack)).toEqual({
        action: 'replay',
        record,
      });
      await assertRead(reader, row, ack);
      expect(await persisted(b)).toEqual(snapshot);
    });
  });
});
