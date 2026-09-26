import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { classifyRestockApplicationStart } from '../domain/restock-application-ledger-start';
import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import type {
  RestockApplicationPendingTransition,
  RestockApplicationTransition,
} from '../domain/restock-application-ledger.port';
import { PostgresRestockApplicationLedgerStore as Store } from './postgres-restock-application-ledger.store';

// LOCAL row CAS only. No active-reservation atomicity, current GET, frozen
// subject, WhatsApp 24h, ownership, provider HTTP, send or history proof.
// Event timestamps are classifier inputs, not real-clock/authority evidence.
// Existing CAS behavior: integration proof, not retroactive RED.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const SOURCE = 'AAAAAAAA-1111-4111-8111-111111111111';
const DECISION = 'BBBBBBBB-3333-4333-8333-333333333333';
const TOKEN_A = 'CCCCCCCC-4444-4444-8444-444444444444';
const TOKEN_B = 'DDDDDDDD-5555-4555-8555-555555555555';
const pending = () => ({
  state: 'PENDING_DELIVERY' as const,
  senderId: 'fixture:Sender',
  branchId: '  branch:East  ',
  sourceRequestId: SOURCE,
  decisionId: DECISION,
  resolutionVersion: 2 as const,
  attemptId: deriveRestockAttemptId(SOURCE, DECISION)!,
  resolvedAt: '2026-06-22T01:00:00.000Z',
  applyBefore: '2026-06-22T02:00:00.000Z',
});
type Event = RestockApplicationPendingTransition['event'];
const begin = (sendToken: string): Event => ({
  kind: 'begin_send',
  sendToken,
  attemptedAt: '2026-06-22T01:30:00.000Z',
});
const expire: Event = {
  kind: 'expire_unsent',
  observedAt: '2026-06-22T02:00:00.000Z',
};
const next = (event: Event) =>
  event.kind === 'begin_send'
    ? {
        ...pending(),
        state: 'SEND_STARTED',
        sendToken: event.sendToken,
        attemptedAt: event.attemptedAt,
      }
    : { ...pending(), state: 'STALE', staleObservedAt: event.observedAt };
const persisted = async (client: PoolClient) =>
  (
    await client.query<Record<string, unknown>>(
      'SELECT * FROM restock_application_ledger',
    )
  ).rows;

// A rejected loser is captured immediately, including assertion-failure paths.
type Settled =
  | { ok: true; value: RestockApplicationTransition }
  | { ok: false; error: unknown };
async function observeBlock(
  winner: PoolClient,
  winnerPid: number,
  loserPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await winner.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers',
      [loserPid],
    );
    if (result.rows[0].blockers.includes(winnerPid)) return;
    await delay(20);
  }
  throw new Error('Competing UPDATE was not observed blocked by winner');
}

ddescribe('pending transition controlled row locks (real PostgreSQL)', () => {
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

  it.each([
    ['A beats B', begin(TOKEN_A), begin(TOKEN_B), false],
    ['B beats A', begin(TOKEN_B), begin(TOKEN_A), true],
    ['begin beats expiry', begin(TOKEN_A), expire, false],
    ['expiry beats begin', expire, begin(TOKEN_B), true],
  ] as const)(
    '%s: observed lock wait, committed winner, durable hold',
    async (_name, winningEvent, losingEvent, reverse) => {
      if (!first || !second) throw new Error('Fixture pools unavailable');
      let a: PoolClient | undefined;
      let b: PoolClient | undefined;
      let winner: PoolClient | undefined;
      let inTransaction = false;
      let loserResult: Promise<Settled> | undefined;
      try {
        a = await first.connect();
        b = await second.connect();
        winner = reverse ? b : a;
        const loser = reverse ? a : b;
        const [wp, lp] = await Promise.all([
          winner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
          loser.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
        ]);
        expect(wp.rows[0].pid).not.toBe(lp.rows[0].pid);
        await winner.query('TRUNCATE TABLE restock_application_ledger');
        const writer = new Store(winner);
        const rival = new Store(loser);
        expect(await writer.insertPending(pending())).toEqual({
          action: 'inserted',
          row: pending(),
        });
        const before = await persisted(loser);
        expect(before).toHaveLength(1);
        await winner.query('BEGIN');
        inTransaction = true;
        // updated is provisional inside this manual transaction, NOT durable yet.
        const provisional = await writer.transitionPending({
          row: pending(),
          event: winningEvent,
        });
        expect(provisional).toEqual({
          action: 'updated',
          row: next(winningEvent),
        });
        loserResult = rival
          .transitionPending({ row: pending(), event: losingEvent })
          .then(
            (value): Settled => ({ ok: true, value }),
            (error: unknown): Settled => ({ ok: false, error }),
          );
        // Polling delay is not the proof: PostgreSQL must report this exact blocker.
        await observeBlock(winner, wp.rows[0].pid, lp.rows[0].pid);
        await winner.query('COMMIT');
        inTransaction = false;
        const settled = await loserResult;
        if (!settled.ok) throw settled.error;
        expect([provisional.action, settled.value.action].sort()).toEqual([
          'hold',
          'updated',
        ]);
        expect(settled.value).toEqual({ action: 'hold' });
        const committed = await persisted(loser);
        expect(committed).toEqual([
          { ...before[0], row_data: next(winningEvent), ack_receipt: null },
        ]);
        // Exact JSON strings + every scalar ID are unchanged except transition data.
        for (const event of [begin(TOKEN_A), begin(TOKEN_B), expire]) {
          expect(
            await rival.transitionPending({ row: pending(), event }),
          ).toEqual({
            action: 'hold',
          });
        }
        expect(await rival.insertPending(pending())).toEqual({
          action: 'hold',
        });
        expect(await persisted(loser)).toEqual(committed);

        // Reacquire a client and reconstruct the store: coordinator restart
        // observation only, NOT a process crash or connection-loss simulation.
        a.release();
        a = undefined;
        b.release();
        b = undefined;
        a = await first.connect();
        const recovered = new Store(a);
        const found = await recovered.readByDecision(DECISION);
        expect(found).toEqual({
          action: 'found',
          row: next(winningEvent),
          ack: null,
        });
        if (found.action !== 'found') throw new Error('Expected recovered row');
        // The classifier accepts unknown snapshots; the port intentionally types
        // only pending inputs. Exercise read/start recovery without an unsafe cast.
        expect(
          classifyRestockApplicationStart({
            row: found.row,
            event: winningEvent,
          }),
        ).toEqual({ action: 'hold', reason: 'not_pending' });
        expect(
          await recovered.transitionPending({
            row: pending(),
            event: winningEvent,
          }),
        ).toEqual({ action: 'hold' });
        expect(await persisted(a)).toEqual(committed);
      } finally {
        try {
          if (inTransaction && winner) await winner.query('ROLLBACK');
        } finally {
          // Server lock/statement timeouts also bound settlement if rollback fails.
          await loserResult;
          a?.release();
          b?.release();
        }
      }
    },
  );
});
