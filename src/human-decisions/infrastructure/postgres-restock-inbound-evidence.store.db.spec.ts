import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  bindRestockInboundEvidence,
  type RestockInboundEvidence,
} from '../domain/restock-inbound-evidence';
import { PostgresRestockInboundEvidenceStore as Store } from './postgres-restock-inbound-evidence.store';

// Existing behavior proof, not retroactive RED. Synthetic events are NOT
// authenticated capture. Configuration/authentication remain future gates.
// First persisted observation only: no global arrival, latest/window/source
// authority, Meta, backfill, crash or connection-fault proof.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const PHONE = '123456789';
const EARLY = '2026-06-22T01:02:03.004Z';
const LATE = '2026-06-22T02:02:03.004Z';
const CORRUPT_SOURCE = 'aaaaaaaa-1111-4111-8111-111111111111';
function evidence(observedAt = EARLY, providerTimestampSeconds = '1782086400') {
  const result = bindRestockInboundEvidence(
    {
      event: {
        receivingPhoneNumberId: PHONE,
        senderId: 'Sender:e\u0301🙂',
        messageId: 'wamid:MiXeD:e\u0301🙂',
      },
      providerTimestampSeconds,
      observedAt,
    },
    PHONE,
  );
  if (!result) throw new Error('Invalid synthetic domain fixture');
  return result;
}
const persisted = async (client: PoolClient) =>
  (
    await client.query<Record<string, unknown>>(
      'SELECT *, xmin::text AS xmin FROM restock_inbound_evidence',
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
  throw new Error('Expected exact winner PID to block loser insert');
}

ddescribe('inbound evidence store (real PostgreSQL)', () => {
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
    } catch {
      throw new Error('Disposable fixture migration to 260 failed');
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
      await a.query('TRUNCATE TABLE restock_inbound_evidence');
      await run(a, b);
    } finally {
      a?.release();
      b?.release();
    }
  }
  async function assertRead(store: Store, original: RestockInboundEvidence) {
    const upper = original.sourceRequestId.toUpperCase();
    expect(upper).not.toBe(original.sourceRequestId);
    expect(await store.readBySource(upper)).toEqual({
      action: 'found',
      evidence: original,
    });
  }
  async function race(
    a: PoolClient,
    b: PoolClient,
    original: RestockInboundEvidence,
    contender: RestockInboundEvidence,
    conflict: boolean,
  ) {
    const writer = new Store(a);
    const rival = new Store(b);
    let transaction = false;
    let loser: Promise<{ value: unknown } | { error: unknown }> | undefined;
    try {
      const [wp, lp] = await Promise.all([
        a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
        b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
      ]);
      expect(wp.rows[0].pid).not.toBe(lp.rows[0].pid);
      expect(contender.sourceRequestId).toBe(original.sourceRequestId);
      await a.query('BEGIN');
      transaction = true;
      // recorded is provisional here, until the explicit COMMIT below.
      expect(await writer.record(original)).toEqual({
        action: 'recorded',
        evidence: original,
      });
      const snapshot = await persisted(a);
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].xmin).toEqual(expect.any(String));
      loser = rival.record(contender).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await observeBlock(a, wp.rows[0].pid, lp.rows[0].pid);
      await a.query('COMMIT');
      transaction = false;
      const result = await loser;
      if ('error' in result) throw result.error;
      expect(result.value).toEqual(
        conflict
          ? { action: 'hold' }
          : { action: 'replay', evidence: original },
      );
      await assertRead(rival, original);
      expect(await persisted(b)).toEqual(snapshot);
      // Matching retries on either side of the original observation retain it.
      for (const observedAt of [original.observedAt, EARLY, LATE]) {
        expect(await rival.record({ ...original, observedAt })).toEqual({
          action: 'replay',
          evidence: original,
        });
      }
      expect(await rival.record(contender)).toEqual(
        conflict
          ? { action: 'hold' }
          : { action: 'replay', evidence: original },
      );
      expect(
        await rival.record({ ...original, providerTimestampSeconds: '01' }),
      ).toEqual({ action: 'hold' });
      await assertRead(writer, original);
      expect(await persisted(b)).toEqual(snapshot);
    } finally {
      try {
        if (transaction) await a.query('ROLLBACK');
      } finally {
        // Roll back before awaiting the blocked query or releasing clients.
        // Normal cleanup only; no injected connection/rollback failure.
        await loser;
      }
    }
  }

  it.each([false, true])(
    'retains %s later observation first persisted, not min/max arrival',
    async (laterWins) => {
      await sessions(async (a, b) => {
        await race(
          laterWins ? b : a,
          laterWins ? a : b,
          evidence(laterWins ? LATE : EARLY),
          evidence(laterWins ? EARLY : LATE),
          false,
        );
      });
    },
  );
  it.each([false, true])(
    'holds contradictory provider seconds with alternate winner=%s',
    async (alternateWins) => {
      await sessions(async (a, b) => {
        await race(
          alternateWins ? b : a,
          alternateWins ? a : b,
          evidence(EARLY, alternateWins ? '1782086401' : '1782086400'),
          evidence(LATE, alternateWins ? '1782086400' : '1782086401'),
          true,
        );
      });
    },
  );
  it('reads missing then roundtrips all seven original fields cross-pool', async () => {
    await sessions(async (a, b) => {
      const original = evidence();
      const writer = new Store(a);
      const reader = new Store(b);
      expect(await reader.readBySource(original.sourceRequestId)).toEqual({
        action: 'missing',
      });
      expect(original.senderId.normalize('NFC')).not.toBe(original.senderId);
      expect(original.messageId.normalize('NFC')).not.toBe(original.messageId);
      expect(await writer.record(original)).toEqual({
        action: 'recorded',
        evidence: original,
      });
      await assertRead(reader, original);
      expect(await persisted(b)).toHaveLength(1);
    });
  });

  // Isolated direct-SQL corruption fixtures, unreachable through the valid port.
  // These are not normal writer flow, authenticated evidence or SQL immutability.
  async function seedCorrupt(client: PoolClient, row: RestockInboundEvidence) {
    await client.query(
      `INSERT INTO restock_inbound_evidence
       (source_request_id, receiving_phone_number_id, sender_id, message_id,
        provider_timestamp_seconds, observed_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.sourceRequestId,
        row.receivingPhoneNumberId,
        row.senderId,
        row.messageId,
        row.providerTimestampSeconds,
        row.observedAt,
        row.version,
      ],
    );
  }
  it.each([
    { sourceRequestId: CORRUPT_SOURCE },
    { observedAt: '2026-99-99T99:99:99.999Z' },
    { observedAt: '1970-01-01T00:00:01.000Z' },
  ])('holds structurally accepted corrupt SQL row %j', async (patch) => {
    await sessions(async (a, b) => {
      const corrupt = { ...evidence(), ...patch };
      await seedCorrupt(a, corrupt);
      const snapshot = await persisted(a);
      expect(await new Store(b).readBySource(corrupt.sourceRequestId)).toEqual({
        action: 'hold',
      });
      expect(await persisted(b)).toEqual(snapshot);
    });
  });
  it('holds unique-event collision under a corrupt wrong source without overwrite', async () => {
    await sessions(async (a, b) => {
      const original = evidence();
      expect(CORRUPT_SOURCE).not.toBe(original.sourceRequestId);
      await seedCorrupt(a, { ...original, sourceRequestId: CORRUPT_SOURCE });
      const snapshot = await persisted(a);
      const store = new Store(b);
      expect(await store.readBySource(original.sourceRequestId)).toEqual({
        action: 'missing',
      });
      expect(await store.record(original)).toEqual({ action: 'hold' });
      expect(await store.readBySource(original.sourceRequestId)).toEqual({
        action: 'missing',
      });
      expect(await persisted(b)).toEqual(snapshot);
    });
  });
});
