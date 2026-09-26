import { PostgresRestockApplicationCompletionStore } from './postgres-restock-application-completion.store';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';
import { prepareRestockApplicationOutcome } from '../domain/restock-application-ledger-ack-preparation';
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
  // Forensic-only bounded markers: static labels, generated ID and timing.
  // No URI, config, or environment values are emitted.
  const stage = (label: string) =>
    process.stderr.write(`[claim-db] ${label} t=${Date.now()}\n`);
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
      stage('container.start.begin');
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      stage(`container.start.end id=${container.getId()}`);
      stage('migration.begin');
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
      stage('migration.end');
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
      stage('setup.ready');
    } catch {
      throw new Error('Disposable claim fixture setup/migration to 260 failed');
    }
  });
  afterAll(async () => {
    stage('cleanup.begin');
    try {
      const ended = await Promise.allSettled(pools.map((pool) => pool.end()));
      stage('cleanup.pools.end');
      if (ended.some((result) => result.status === 'rejected'))
        throw new Error('Claim fixture pool cleanup failed');
    } finally {
      await container?.stop();
      stage('cleanup.end');
    }
  });
  beforeEach(async () => {
    stage(`test.begin ${expect.getState().currentTestName ?? 'unknown'}`);
    stage('seed.truncate.begin');
    await observer.query(
      'TRUNCATE restock_application_ledger, restock_inbound_evidence, human_decision_reservations, conversation_state',
    );
    stage('seed.truncate.end');
    stage('seed.evidence.begin');
    expect(
      await new PostgresRestockInboundEvidenceStore(observer).record(evidence),
    ).toEqual({ action: 'recorded', evidence });
    stage('seed.evidence.end');
    // Explicitly synthetic POST receipt fixture, not a backend request.
    stage('seed.reservation.begin');
    await observer.query(
      `INSERT INTO human_decision_reservations
      (sender_id, route, request_key, status, intake, post_state,
       backend_decision_id, post_attempted_at, receipt_recorded_at)
      VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3, 'RECEIPT_RECORDED', $4, $5, $5)`,
      [SENDER, evidence.sourceRequestId, JSON.stringify(intake), ID, NOW],
    );
    stage('seed.reservation.end');
    stage('seed.conversation.begin');
    await observer.query(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
      VALUES ($1, $2, $3)`,
      [SENDER, NOW, JSON.stringify({ messages: [] })],
    );
    stage('seed.conversation.end');
    stage('beforeEach.done');
  });
  afterEach(() => stage('test.end'));
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
  describe('unwired completion against durable local terminal ACK', () => {
    const completion = (pool: Pick<Pool, 'query'> = pools[0]) =>
      new PostgresRestockApplicationCompletionStore(pool, BRANCH);
    // Synthetic port only; Pool['query'] overloads are not mockable directly.
    const fakeQuery = (query: unknown): Pick<Pool, 'query'> =>
      ({ query }) as unknown as Pick<Pool, 'query'>;
    async function acknowledged(state = 'PROVIDER_ACCEPTED') {
      stage('ack.prepared.begin');
      const { candidate, pending } = await prepared();
      stage('ack.prepared.end');
      stage('ack.claim.begin');
      const claimed = await store(
        pools[0],
        state === 'STALE' ? END : NOW,
      ).claimPending(candidate, pending, TOKENS[0]);
      stage('ack.claim.end');
      if (claimed.action !== 'started' && claimed.action !== 'stale')
        throw new Error('Expected real terminal preparation');
      let row: unknown = claimed.row;
      const persistence = new PostgresRestockApplicationLedgerStore(pools[0]);
      if (claimed.action === 'started') {
        stage('ack.acceptance.begin');
        const accepted = await persistence.recordAcceptance({
          row: claimed.row,
          event: {
            kind: 'provider_accepted',
            attemptId: claimed.row.attemptId,
            sendToken: TOKENS[0],
            providerMessageId: 'wamid.synthetic.acceptance',
            providerAcceptedObservedAt:
              state === 'PROVIDER_ACCEPTED_LATE' ? END : NOW,
          },
        });
        stage('ack.acceptance.end');
        if (accepted.action !== 'updated')
          throw new Error('Expected acceptance');
        row = accepted.row;
      }
      const outcome = prepareRestockApplicationOutcome(row);
      if (outcome.action !== 'prepared') throw new Error('Expected outcome');
      // Explicit synthetic backend ACK; no backend or provider call.
      stage('ack.record.begin');
      const ack = await persistence.recordOutcomeAck(outcome.expected, {
        id: outcome.decisionId,
        version: 2,
        attemptId: outcome.request.attemptId,
        outcome: outcome.request.outcome,
        ackReceivedAt: NOW,
      });
      stage('ack.record.end');
      if (ack.action !== 'recorded') throw new Error('Expected durable ACK');
      return ack.record;
    }
    it.each(['PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'STALE'])(
      'closes %s once; replay changes no reservation bytes or xmin',
      async (state) => {
        const record = await acknowledged(state);
        const before = (await originals()) as Record<string, unknown>[][];
        const application = await ledger();
        expect(await completion().closeAcknowledged(record)).toEqual({
          action: 'closed',
        });
        const after = (await originals()) as Record<string, unknown>[][];
        expect(after[0]).toEqual(before[0]);
        expect(after[2]).toEqual(before[2]);
        expect(after[1]).toHaveLength(1);
        expect(after[1][0]).toEqual({
          ...before[1][0],
          status: 'CLOSED',
          updated_at: after[1][0].updated_at,
          revision: after[1][0].revision,
        });
        expect(after[1][0].revision).not.toBe(before[1][0].revision);
        expect(await completion().closeAcknowledged(record)).toEqual({
          action: 'replay',
        });
        expect(await originals()).toEqual(after);
        expect(await ledger()).toEqual(application);
      },
    );
    // Keep every tuple arity 3: jest-each injects `done` into short rows.
    it.each<[string, string, string | undefined]>([
      [
        'missing ACK',
        'UPDATE restock_application_ledger SET ack_receipt=NULL',
        undefined,
      ],
      [
        'different ACK',
        `UPDATE restock_application_ledger SET ack_receipt=jsonb_set(ack_receipt,'{ackReceivedAt}',to_jsonb($1::text))`,
        END,
      ],
      [
        'different terminal row',
        `UPDATE restock_application_ledger SET row_data=jsonb_set(row_data,'{providerMessageId}',to_jsonb($1::text))`,
        'wamid.other',
      ],
      [
        'different branch',
        `UPDATE restock_application_ledger
         SET branch_id=$1, row_data=jsonb_set(row_data,'{branchId}',to_jsonb($1::text))`,
        'other',
      ],
      [
        'different source scalar',
        `UPDATE restock_application_ledger
         SET source_request_id=$1::uuid,
             row_data=jsonb_set(row_data,'{sourceRequestId}',to_jsonb($1::text))`,
        TOKENS[1],
      ],
      [
        'different receipt identity',
        'UPDATE human_decision_reservations SET backend_decision_id=$1::uuid',
        TOKENS[1],
      ],
      [
        'LEGACY_OPS route',
        `UPDATE human_decision_reservations
         SET route='LEGACY_OPS', request_key='abcdef123456', intake=NULL,
             post_state=NULL, backend_decision_id=NULL,
             post_attempted_at=NULL, receipt_recorded_at=NULL`,
        undefined,
      ],
      [
        'request key case',
        `UPDATE human_decision_reservations
         SET request_key=upper(request_key),
             intake=jsonb_set(intake,'{sourceRequestId}',to_jsonb(upper(request_key)))`,
        undefined,
      ],
    ])('holds SQL mismatch: %s', async (_label, sql, value) => {
      const record = await acknowledged();
      // Deliberate raw-SQL corruption is negative proof, not a supported port.
      await observer.query(sql, value === undefined ? [] : [value]);
      const before = await originals();
      const application = await ledger();
      expect(await completion().closeAcknowledged(record)).toEqual({
        action: 'hold',
      });
      expect(await originals()).toEqual(before);
      expect(await ledger()).toEqual(application);
    });
    it('old source A replays without closing active successor B', async () => {
      const record = await acknowledged();
      expect(await completion().closeAcknowledged(record)).toEqual({
        action: 'closed',
      });
      await observer.query(
        `INSERT INTO human_decision_reservations
        (sender_id, route, request_key, status, intake, post_state,
         backend_decision_id, post_attempted_at, receipt_recorded_at)
        VALUES ($1,'RESTOCK',$2,'ACTIVE',$3,'RECEIPT_RECORDED',$4,$5,$5)`,
        [
          SENDER,
          TOKENS[1],
          JSON.stringify({ ...intake, sourceRequestId: TOKENS[1] }),
          TOKENS[1],
          NOW,
        ],
      );
      const before = await originals();
      expect(await completion().closeAcknowledged(record)).toEqual({
        action: 'replay',
      });
      expect(await originals()).toEqual(before);
    });
    it('SIMULATED result loss holds without retry/readback although SQL committed', async () => {
      const record = await acknowledged();
      const query = jest.fn(async (sql: string, values?: unknown[]) => {
        await pools[0].query(sql, values);
        throw new Error('simulated application result loss');
      });
      expect(
        await completion(fakeQuery(query)).closeAcknowledged(record),
      ).toEqual({ action: 'hold' });
      expect(query).toHaveBeenCalledTimes(1);
      // Independent observer, not adapter reconciliation or real connection loss.
      expect(
        ((await originals()) as Record<string, unknown>[][])[1][0].status,
      ).toBe('CLOSED');
    });
    it('rejects invalid records before SQL', async () => {
      const query = jest.fn();
      expect(
        await completion(fakeQuery(query)).closeAcknowledged(null),
      ).toEqual({ action: 'hold' });
      expect(query).not.toHaveBeenCalled();
    });
  });
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

  it('expires cached ready at applyBefore without send authority or replay rewrite', async () => {
    const { candidate, pending } = await prepared();
    expect(candidate.classification.action).toBe('ready');
    expect(Date.parse(evidence.observedAt)).toBeLessThanOrEqual(
      Date.parse(END),
    );
    expect(Date.parse(END)).toBeLessThan(
      Number(evidence.providerTimestampSeconds) * 1000 + 86_400_000,
    );
    const before = await originals();
    const pendingRows = await ledger();
    expect(pendingRows).toHaveLength(1);
    const staleRow = { ...pending, state: 'STALE', staleObservedAt: END };
    expect(
      await store(pools[0], END).claimPending(candidate, pending, TOKENS[0]),
    ).toEqual({ action: 'stale', row: staleRow, evidence });
    const stale = await ledger();
    expect(stale).toHaveLength(1);
    // Exact JSON equality excludes send/provider metadata, not just known tokens.
    expect(stale[0]).toEqual({
      ...pendingRows[0],
      row_data: staleRow,
      revision: stale[0].revision,
    });
    expect(stale[0].revision).toEqual(expect.any(String));
    expect(stale[0].revision).not.toBe(pendingRows[0].revision);
    expect(stale[0].ack_receipt).toBeNull();
    expect(
      await store(pools[1], END).claimPending(candidate, pending, TOKENS[1]),
    ).toEqual({ action: 'hold' });
    expect(await ledger()).toEqual(stale);
    expect(await originals()).toEqual(before);
    await idle(pools[0]);
    await idle(pools[1]);
  });

  it.each(['receipt pointer presence', 'missing conversation'])(
    'holds %s without changing pending or surrounding evidence',
    async (collision) => {
      const { candidate, pending } = await prepared();
      if (collision === 'receipt pointer presence') {
        // Unsupported key presence is conservative even when null; this is not
        // a claim that the fixture represents a legitimate receipt workflow.
        await observer.query(
          'UPDATE conversation_state SET data=$1 WHERE sender_id=$2',
          [
            JSON.stringify({ messages: [], receiptAmountPointer: null }),
            SENDER,
          ],
        );
      } else {
        // Bounded absent-row HOLD only, not phantom/external-writer exclusion.
        await observer.query(
          'DELETE FROM conversation_state WHERE sender_id=$1',
          [SENDER],
        );
      }
      const before = await originals();
      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0].row_data).toEqual(pending);
      expect(rows[0].ack_receipt).toBeNull();
      expect(
        await store(pools[0]).claimPending(candidate, pending, TOKENS[0]),
      ).toEqual({ action: 'hold' });
      expect(await ledger()).toEqual(rows);
      expect(await originals()).toEqual(before);
      await idle(pools[0]);
    },
  );
});
