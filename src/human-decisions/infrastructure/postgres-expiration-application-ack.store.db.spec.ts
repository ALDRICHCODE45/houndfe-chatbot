import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationLedgerStore as Store } from './postgres-expiration-application-ledger.store';

// Existing-behavior proof only: synthetic ACKs are not HTTP provenance. A fresh
// pool is not an OS restart; no crash or COMMIT-disconnect injection is claimed.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const pending = {
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2 as const,
  attemptId: deriveExpirationAttemptId(sourceRequestId, decisionId)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-26T10:00:00.000Z',
  state: 'PENDING_DELIVERY' as const,
};
const begin = {
  kind: 'begin_send',
  sendToken: '33333333-3333-4333-8333-333333333333',
  attemptedAt: pending.resolvedAt,
};
const started = {
  ...pending,
  state: 'SEND_STARTED',
  sendToken: begin.sendToken,
  attemptedAt: begin.attemptedAt,
};
const TERMINALS = [
  'PROVIDER_ACCEPTED',
  'PROVIDER_ACCEPTED_LATE',
  'STALE',
] as const;
type Terminal = (typeof TERMINALS)[number];
const terminal = (state: Terminal) =>
  state === 'STALE'
    ? { ...pending, state, staleObservedAt: pending.applyBefore }
    : {
        ...started,
        state,
        providerMessageId: ' provider opaque ',
        providerAcceptedObservedAt:
          state === 'PROVIDER_ACCEPTED'
            ? '2026-09-25T10:01:00.000Z'
            : pending.applyBefore,
      };
const ack = (row: {
  decisionId: string;
  attemptId: string;
  state: string;
}) => ({
  id: row.decisionId,
  version: 2,
  attemptId: row.attemptId,
  outcome: row.state,
  ackReceivedAt: '2026-09-26T04:01:00-06:00',
});
const hold = { action: 'hold' };
const CASES = TERMINALS.flatMap(
  (state) =>
    [
      { state, conflict: false, completion: 'COMMIT' },
      { state, conflict: true, completion: 'COMMIT' },
      { state, conflict: true, completion: 'ROLLBACK' },
    ] as const,
);

ddescribe('EXPIRATION ACK CAS (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: Store;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync(
      process.execPath,
      [
        `${ROOT}/node_modules/node-pg-migrate/bin/node-pg-migrate.js`,
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
    pool = new Pool({
      connectionString: container.getConnectionUri(),
      max: 4,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
    });
    store = new Store(pool);
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE expiration_application_ledger');
  });
  const seed = async (state: Terminal) => {
    const row = terminal(state);
    if (row.state === 'STALE') {
      // No STALE producer exists yet. This SQL fixture asserts neither no-send
      // history nor permission to close; the operation under test is public CAS.
      await pool.query(
        `INSERT INTO expiration_application_ledger
        (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          decisionId,
          sourceRequestId,
          pending.attemptId,
          pending.senderId,
          pending.branchId,
          JSON.stringify(row),
        ],
      );
    } else {
      expect(await store.insertPending(pending)).toEqual({
        action: 'inserted',
        row: pending,
      });
      expect(
        await store.transitionPending({ row: pending, event: begin }),
      ).toEqual({ action: 'updated', row: started });
      expect(
        await store.recordAcceptance({
          row: started,
          event: {
            kind: 'provider_accepted',
            attemptId: row.attemptId,
            sendToken: begin.sendToken,
            providerMessageId: row.providerMessageId,
            providerAcceptedObservedAt: row.providerAcceptedObservedAt,
          },
        }),
      ).toEqual({ action: 'updated', row });
    }
    return row;
  };

  it.each(CASES)(
    '$state $completion conflict=$conflict has the expected concurrent winner',
    async ({ state, conflict, completion }) => {
      const row = await seed(state);
      const receipt = ack(row);
      const contender = {
        ...receipt,
        ackReceivedAt: conflict
          ? '2026-09-26T04:01:01-06:00'
          : receipt.ackReceivedAt,
      };
      const first = await pool.connect();
      let second: PoolClient | undefined;
      let competing: Promise<unknown> | undefined;
      try {
        second = await pool.connect();
        const firstPid = (
          await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        const secondPid = (
          await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(firstPid).not.toBe(secondPid);
        await first.query('BEGIN');
        // updated is provisional: only the following transaction outcome decides
        // whether this ACK survives. The second connection uses autocommit.
        expect(await new Store(first).recordOutcomeAck(row, receipt)).toEqual({
          action: 'updated',
          row,
          receipt,
        });
        let settled = false;
        competing = new Store(second).recordOutcomeAck(row, contender).then(
          (value) => {
            settled = true;
            return { value };
          },
          () => {
            settled = true;
            return { rejected: true };
          },
        );
        let blocked = false;
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          // Live lock evidence, not a sleep-based race or cached activity text.
          const probe = await first.query<{ blocked: boolean }>(
            'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
            [firstPid, secondPid],
          );
          if (probe.rows[0].blocked) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
        await first.query(completion);
        expect(await competing).toEqual({
          value:
            completion === 'COMMIT'
              ? hold
              : { action: 'updated', row, receipt: contender },
        });
        expect(
          (
            await pool.query(
              'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
              [secondPid],
            )
          ).rows,
        ).toEqual([{ state: 'idle', xact_start: null }]);
      } finally {
        try {
          await first.query('ROLLBACK');
        } finally {
          try {
            await competing;
          } finally {
            first.release();
            second?.release();
          }
        }
      }
      const fresh = new Pool({
        connectionString: container.getConnectionUri(),
        max: 1,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 10_000,
      });
      try {
        const reopened = new Store(fresh);
        expect(await reopened.recordOutcomeAck(row, receipt)).toEqual(hold);
        expect(await reopened.recordOutcomeAck(row, contender)).toEqual(hold);
        expect(await reopened.readByDecision(decisionId)).toEqual(hold);
        expect(await reopened.insertPending(pending)).toEqual(hold);
        expect(
          await reopened.transitionPending({ row: pending, event: begin }),
        ).toEqual(hold);
      } finally {
        await fresh.end();
      }
    },
  );
  it('holds absent and valid divergent expected snapshots, preserving the exact ACK opportunity', async () => {
    const expected = terminal('PROVIDER_ACCEPTED');
    expect(await store.recordOutcomeAck(expected, ack(expected))).toEqual(hold);
    expect(await store.readByDecision(decisionId)).toEqual({
      action: 'missing',
    });
    const row = await seed('PROVIDER_ACCEPTED');
    const other = '99998b89-b323-5a4f-952e-41ebcc00d733';
    for (const changed of [
      { ...row, senderId: 'other' },
      { ...row, branchId: 'branch' },
      { ...row, sendToken: other },
      { ...row, attemptedAt: '2026-09-25T10:00:01.000Z' },
      { ...row, providerMessageId: 'other' },
      { ...row, providerAcceptedObservedAt: '2026-09-25T10:01:01.000Z' },
      {
        ...row,
        resolvedAt: '2026-09-25T09:00:00.000Z',
        applyBefore: '2026-09-26T09:00:00.000Z',
      },
      {
        ...row,
        sourceRequestId: other,
        attemptId: deriveExpirationAttemptId(other, decisionId)!,
      },
      {
        ...row,
        decisionId: other,
        attemptId: deriveExpirationAttemptId(sourceRequestId, other)!,
      },
      terminal('PROVIDER_ACCEPTED_LATE'),
    ]) {
      // Receipt identity/outcome follow the changed valid row: the mismatch is
      // against stored JSONB/columns, not a pure ACK binding rejection.
      expect(await store.recordOutcomeAck(changed, ack(changed))).toEqual(hold);
    }
    const receipt = ack(row);
    expect(
      await store.recordOutcomeAck(
        Object.fromEntries(Object.entries(row).reverse()),
        Object.fromEntries(Object.entries(receipt).reverse()),
      ),
    ).toEqual({ action: 'updated', row, receipt });
    expect(await store.recordOutcomeAck(row, receipt)).toEqual(hold);
  });
});
