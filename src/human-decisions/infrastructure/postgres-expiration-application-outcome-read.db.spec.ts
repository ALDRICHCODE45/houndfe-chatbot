import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationLedgerStore as Store } from './postgres-expiration-application-ledger.store';

// Existing-behavior proof, not retroactive RED. Synthetic receipts/STALE fixtures
// do not establish HTTP provenance/no-send history. A fresh pool is not an OS
// restart; no crash, uncertain COMMIT, WhatsApp, retries or closure are tested.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const source = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const pending = {
  state: 'PENDING_DELIVERY' as const,
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId: source,
  decisionId: id,
  resolutionVersion: 2 as const,
  attemptId: deriveExpirationAttemptId(source, id)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-26T10:00:00.000Z',
};
const begin = {
  kind: 'begin_send',
  sendToken: id,
  attemptedAt: pending.resolvedAt,
};
const started = {
  ...pending,
  state: 'SEND_STARTED',
  sendToken: id,
  attemptedAt: pending.resolvedAt,
};
const states = [
  'PROVIDER_ACCEPTED',
  'PROVIDER_ACCEPTED_LATE',
  'STALE',
] as const;
type State = (typeof states)[number];
const terminal = (state: State) =>
  state === 'STALE'
    ? { ...pending, state, staleObservedAt: pending.applyBefore }
    : {
        ...started,
        state,
        providerMessageId: ' opaque ',
        providerAcceptedObservedAt:
          state === 'PROVIDER_ACCEPTED'
            ? pending.resolvedAt
            : pending.applyBefore,
      };
const ack = (state: State) => ({
  id,
  version: 2,
  attemptId: pending.attemptId,
  outcome: state,
  ackReceivedAt: '2026-09-26T04:01:00-06:00',
});
const found = (state: State, receipt: unknown = null) => ({
  action: 'foundOutcome',
  row: terminal(state),
  receipt,
});
const hold = { action: 'hold' };

ddescribe('EXPIRATION outcome/ACK reads with real PostgreSQL', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: Store;
  const config = () => ({
    connectionString: container.getConnectionUri(),
    max: 3,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
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
    pool = new Pool(config());
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
  async function seed(state: State) {
    const row = terminal(state);
    if (row.state === 'STALE') {
      // Reader-only fixture. Production STALE generation has its own DB proof.
      await pool.query(
        `INSERT INTO expiration_application_ledger
        (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          id,
          source,
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
            sendToken: id,
            providerMessageId: row.providerMessageId,
            providerAcceptedObservedAt: row.providerAcceptedObservedAt,
          },
        }),
      ).toEqual({ action: 'updated', row });
    }
    return row;
  }
  it.each(
    states.flatMap((state) =>
      (['COMMIT', 'ROLLBACK'] as const).map((completion) => ({
        state,
        completion,
      })),
    ),
  )(
    '$state: ACK visibility follows $completion across physical sessions',
    async ({ state, completion }) => {
      const row = await seed(state);
      const receipt = ack(state);
      expect(await store.readOutcomeByDecision(id)).toEqual(found(state));
      const writer = await pool.connect();
      let reader: PoolClient | undefined;
      try {
        reader = await pool.connect();
        const writerPid = (
          await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        const readerPid = (
          await reader.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        expect(writerPid).not.toBe(readerPid);
        const local = new Store(writer);
        const remote = new Store(reader);
        await writer.query('BEGIN');
        expect(await local.recordOutcomeAck(row, receipt)).toEqual({
          action: 'updated',
          row,
          receipt,
        });
        // Own-transaction reads are provisional. Another session still sees
        // the committed terminal with SQL NULL ACK, and must not block on it.
        expect(await local.readOutcomeByDecision(id)).toEqual(
          found(state, receipt),
        );
        expect(await remote.readOutcomeByDecision(id)).toEqual(found(state));
        await writer.query(completion);
        const expected = found(state, completion === 'COMMIT' ? receipt : null);
        expect(await remote.readOutcomeByDecision(id)).toEqual(expected);
        const fresh = new Pool(config());
        try {
          expect(await new Store(fresh).readOutcomeByDecision(id)).toEqual(
            expected,
          );
        } finally {
          await fresh.end();
        }
        expect(await remote.readByDecision(id)).toEqual(hold);
        expect(await remote.insertPending(pending)).toEqual(hold);
        expect(await remote.recordOutcomeAck(row, receipt)).toEqual(
          completion === 'COMMIT' ? hold : { action: 'updated', row, receipt },
        );
        expect(await remote.readOutcomeByDecision(id)).toEqual(
          found(state, receipt),
        );
        const different = {
          ...receipt,
          ackReceivedAt: '2026-09-26T04:01:01-06:00',
        };
        expect(await remote.recordOutcomeAck(row, different)).toEqual(hold);
        expect(await remote.readOutcomeByDecision(id)).toEqual(
          found(state, receipt),
        );
      } finally {
        try {
          await writer.query('ROLLBACK');
        } finally {
          writer.release();
          reader?.release();
        }
      }
    },
  );
  it('distinguishes missing, pending and started without widening the original pending read', async () => {
    expect(await store.readOutcomeByDecision(id)).toEqual({
      action: 'missing',
    });
    expect(await store.insertPending(pending)).toEqual({
      action: 'inserted',
      row: pending,
    });
    expect(await store.readOutcomeByDecision(id)).toEqual(hold);
    expect(await store.readByDecision(id)).toEqual({
      action: 'foundPending',
      row: pending,
    });
    expect(
      await store.transitionPending({ row: pending, event: begin }),
    ).toEqual({ action: 'updated', row: started });
    expect(await store.readOutcomeByDecision(id)).toEqual(hold);
    expect(await store.readByDecision(id)).toEqual(hold);
    expect(await store.readOutcomeByDecision(source)).toEqual({
      action: 'missing',
    });
  });
  it.each(states)(
    'holds semantically invalid stored ACK for %s without treating it as absent',
    async (state) => {
      const row = await seed(state);
      // The CHECK permits a string timestamp; semantic time validation is the
      // domain reader's responsibility. All schema constraints remain enabled.
      await pool.query(
        'UPDATE expiration_application_ledger SET ack_receipt=$2::jsonb WHERE decision_id=$1',
        [id, JSON.stringify({ ...ack(state), ackReceivedAt: 'invalid' })],
      );
      expect(await store.readOutcomeByDecision(id)).toEqual(hold);
      expect(await store.readByDecision(id)).toEqual(hold);
      expect(await store.recordOutcomeAck(row, ack(state))).toEqual(hold);
      expect(await store.readOutcomeByDecision(id)).toEqual(hold);
    },
  );
});
