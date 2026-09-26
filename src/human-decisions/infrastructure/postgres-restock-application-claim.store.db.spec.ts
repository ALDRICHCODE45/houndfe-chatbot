import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RestockApplicationCandidateService } from '../application/restock-application-candidate.service';
import { bindRestockInboundEvidence } from '../domain/restock-inbound-evidence';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';
import { PostgresRestockApplicationPreparationStore } from './postgres-restock-application-preparation.store';
import { PostgresRestockApplicationClaimStore } from './postgres-restock-application-claim.store';
import { PostgresRestockInboundEvidenceStore } from './postgres-restock-inbound-evidence.store';

// Existing implementation proof, not retroactive RED. Synthetic POST receipt
// and resolved GET fixtures are not backend/authentication evidence. Real local
// locks/CAS/COMMIT only: no crash, connection-loss, Meta or device-delivery proof.
// Reconstruction is not crash recovery; helper locks do not fence all writers.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const NOW = '2026-06-22T12:00:00.000Z';
const END = '2026-06-22T13:00:00.000Z';
const SENDER = 'whatsapp:+5215500000001';
const PHONE = '123456789';
const BRANCH = ' trusted branch ';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TOKENS = [
  '99999999-9999-4999-8999-999999999999',
  '88888888-8888-4888-8888-888888888888',
];
const clock = () => new Date(NOW);
const evidence = bindRestockInboundEvidence(
  {
    event: {
      receivingPhoneNumberId: PHONE,
      senderId: SENDER,
      messageId: 'wamid.db',
    },
    providerTimestampSeconds: String(Date.parse(NOW) / 1000),
    observedAt: NOW,
  },
  PHONE,
)!;
const subject = {
  productId: TOKENS[0],
  productName: 'Collar',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: 0,
  stockObservedAt: NOW,
};
const intake = {
  ...subject,
  sourceRequestId: evidence.sourceRequestId,
  type: 'RESTOCK' as const,
  supersedesDecisionId: null,
};
const decision = {
  id: ID,
  sourceRequestId: evidence.sourceRequestId,
  type: 'RESTOCK' as const,
  createdAt: NOW,
  supersedesDecisionId: null,
  snapshot: { ...subject, branchId: BRANCH, branchName: null },
  status: 'RESOLVED' as const,
  version: 2 as const,
  applyBefore: END,
  resolution: {
    action: 'PROVIDE_RESTOCK_ESTIMATE' as const,
    restockDays: 3,
    resolvedAt: NOW,
  },
};
async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(20);
  }
  throw new Error('Expected bounded PostgreSQL race condition not observed');
}
// Attach rejection handlers immediately, before any observation can fail.
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

ddescribe('restock claim permission after real PostgreSQL COMMIT', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let pools: Pool[] = [];
  let observer: Pool;
  const store = (pool: Pool, now = NOW) =>
    new PostgresRestockApplicationClaimStore(
      pool,
      BRANCH,
      PHONE,
      () => new Date(now),
    );
  const ledger = async () =>
    (
      await observer.query(
        'SELECT *, xmin::text AS revision FROM restock_application_ledger',
      )
    ).rows as Record<string, unknown>[];
  const originals = async () => {
    const rows = [];
    for (const sql of [
      'SELECT *, xmin::text AS revision FROM restock_inbound_evidence ORDER BY sender_id',
      'SELECT *, xmin::text AS revision FROM human_decision_reservations ORDER BY sender_id',
      'SELECT *, xmin::text AS revision FROM conversation_state ORDER BY sender_id',
    ]) {
      rows.push((await observer.query(sql)).rows);
    }
    return rows;
  };
  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
          '--config-file',
          'package.json',
          '--config-value',
          'pg-migrate',
          'up',
          '2600000000000',
          '--timestamp',
        ],
        {
          cwd: ROOT,
          env: { DATABASE_URL: container.getConnectionUri() },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
      const options = {
        connectionString: container.getConnectionUri(),
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        statement_timeout: 12_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 20_000,
      };
      pools = [new Pool(options), new Pool(options), new Pool(options)];
      observer = pools[2];
    } catch {
      throw new Error('Disposable claim fixture setup/migration to 260 failed');
    }
  });
  afterAll(async () => {
    try {
      const ended = await Promise.allSettled(pools.map((pool) => pool.end()));
      if (ended.some((result) => result.status === 'rejected'))
        throw new Error('Claim fixture pool cleanup failed');
    } finally {
      await container?.stop();
    }
  });
  beforeEach(async () => {
    await observer.query(
      'TRUNCATE restock_application_ledger, restock_inbound_evidence, human_decision_reservations, conversation_state',
    );
    expect(
      await new PostgresRestockInboundEvidenceStore(observer).record(evidence),
    ).toEqual({ action: 'recorded', evidence });
    // Explicitly synthetic POST receipt fixture, not a backend request.
    await observer.query(
      `INSERT INTO human_decision_reservations
      (sender_id, route, request_key, status, intake, post_state,
       backend_decision_id, post_attempted_at, receipt_recorded_at)
      VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3, 'RECEIPT_RECORDED', $4, $5, $5)`,
      [SENDER, evidence.sourceRequestId, JSON.stringify(intake), ID, NOW],
    );
    await observer.query(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
      VALUES ($1, $2, $3)`,
      [SENDER, NOW, JSON.stringify({ messages: [] })],
    );
  });
  async function prepared() {
    const candidate = await new RestockApplicationCandidateService(
      new PostgresRestockApplicationContextStore(observer),
      { getRestockDecision: async () => decision },
      BRANCH,
      clock,
    ).pollForSender(SENDER);
    if (candidate.action !== 'candidate')
      throw new Error('Expected real recorded context');
    expect(candidate.context.reservation.requestKey).toBe(
      evidence.sourceRequestId,
    );
    const result = await new PostgresRestockApplicationPreparationStore(
      observer,
      BRANCH,
      clock,
    ).preparePending(candidate);
    if (result.action !== 'prepared')
      throw new Error('Expected real pending preparation');
    return { candidate, pending: result.row };
  }
  async function idle(pool: Pool) {
    const pid = (
      await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0].pid;
    expect(
      (
        await observer.query(
          'SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1',
          [pid],
        )
      ).rows,
    ).toEqual([{ state: 'idle', xact_start: null }]);
  }
  it.each([0, 1])(
    'forces pool %s to win while the rival waits on its ACTIVE lock',
    async (winnerIndex) => {
      const { candidate, pending } = await prepared();
      const before = await originals();
      const pendingRows = await ledger();
      const winnerPool = pools[winnerIndex];
      const loserPool = pools[1 - winnerIndex];
      const loserPid = (
        await loserPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const client = await winnerPool.connect();
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let atCommit = false;
      let returned = false;
      let winner: ReturnType<typeof settle> | undefined;
      let loser: ReturnType<typeof settle> | undefined;
      const query = client.query.bind(client);
      // Narrow pg's callback overloads to the promise API used by the stores.
      const promisePool = winnerPool as unknown as {
        connect(): Promise<PoolClient>;
      };
      const promiseClient = client as unknown as {
        query(sql: string, values?: unknown[]): Promise<QueryResult>;
      };
      const connectSpy = jest
        .spyOn(promisePool, 'connect')
        .mockResolvedValue(client);
      // Transparent gate: never synthesize a query result or permission.
      const querySpy = jest
        .spyOn(promiseClient, 'query')
        .mockImplementation(async (sql, values) => {
          if (sql === 'COMMIT') {
            atCommit = true;
            await gate;
          }
          return query(sql, values);
        });
      try {
        const winnerPid = (
          await query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(winnerPid).not.toBe(loserPid);
        expect(TOKENS[0]).not.toBe(TOKENS[1]);
        winner = settle(
          store(winnerPool)
            .claimPending(candidate, pending, TOKENS[winnerIndex])
            .then((value) => {
              returned = true;
              return value;
            }),
        );
        await until(async () => atCommit);
        const provisional = (
          await query<{ row_data: unknown }>(
            'SELECT row_data FROM restock_application_ledger',
          )
        ).rows[0].row_data;
        expect(provisional).toEqual({
          ...pending,
          state: 'SEND_STARTED',
          sendToken: TOKENS[winnerIndex],
          attemptedAt: NOW,
        });
        loser = settle(
          store(loserPool).claimPending(
            candidate,
            pending,
            TOKENS[1 - winnerIndex],
          ),
        );
        await until(async () => {
          const result = await observer.query<{
            blockers: number[];
            query: string;
            wait_event_type: string;
          }>(
            'SELECT pg_blocking_pids(pid) AS blockers, query, wait_event_type FROM pg_stat_activity WHERE pid=$1',
            [loserPid],
          );
          const activity = result.rows[0];
          return (
            activity.blockers.includes(winnerPid) &&
            activity.wait_event_type === 'Lock' &&
            activity.query.includes("status='ACTIVE' FOR UPDATE")
          );
        });
        expect(returned).toBe(false);
        expect(await ledger()).toEqual(pendingRows);
        unblock();
        expect(await winner).toEqual({
          value: { action: 'started', row: provisional, evidence },
        });
        expect(await loser).toEqual({ value: { action: 'hold' } });
        const committed = await ledger();
        expect(committed).toHaveLength(1);
        expect(committed[0].row_data).toEqual(provisional);
        expect(committed[0].ack_receipt).toBeNull();
        for (const token of TOKENS) {
          expect(
            await store(loserPool).claimPending(candidate, pending, token),
          ).toEqual({ action: 'hold' });
          expect(await ledger()).toEqual(committed);
        }
        expect(await originals()).toEqual(before);
      } finally {
        unblock();
        await Promise.allSettled([winner, loser]);
        querySpy.mockRestore();
        connectSpy.mockRestore();
        // Normal cleanup only, not injected rollback/release failure coverage.
        if (!winner) client.release();
      }
      await idle(winnerPool);
      await idle(loserPool);
    },
  );
});
