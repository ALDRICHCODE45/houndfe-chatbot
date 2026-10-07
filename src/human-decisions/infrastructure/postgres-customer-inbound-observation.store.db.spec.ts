import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  normalizeCustomerInboundObservation,
  type CustomerInboundObservation,
} from '../domain/customer-inbound-observation';
import { PostgresCustomerInboundObservationStore as Store } from './postgres-customer-inbound-observation.store';

// Proof of committed behavior, not retroactive RED or authenticated capture.
// All adapters use standalone Pools. Raw SQL below is controlled fixture setup
// or preservation/lock instrumentation, never a provisional adapter success.
// Fresh pools prove persisted visibility, not OS restart or ambiguous COMMIT.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const PHONE = '123456789';
const EARLY = '2026-06-22T01:02:03.004Z';
const LATE = '2026-06-22T02:02:03.004Z';
function observation(patch: Partial<CustomerInboundObservation> = {}) {
  const value = normalizeCustomerInboundObservation({
    senderId: 'Sender:e\u0301🙂',
    receivingPhoneNumberId: PHONE,
    messageId: 'wamid:MiXeD:e\u0301🙂',
    providerTimestampSeconds: '100',
    observedAt: EARLY,
    ...patch,
  });
  if (!value) throw new Error('Invalid synthetic observation fixture');
  return value;
}
const found = (value: CustomerInboundObservation) => ({
  kind: 'found',
  observation: value,
});
const snapshot = async (pool: Pool) =>
  (
    await pool.query(`SELECT *, xmin::text AS xmin
    FROM customer_inbound_observations
    ORDER BY receiving_phone_number_id, message_id`)
  ).rows as unknown[];
async function seed(client: PoolClient, value: CustomerInboundObservation) {
  await client.query(
    `INSERT INTO customer_inbound_observations
     (receiving_phone_number_id, sender_id, message_id, provider_timestamp_seconds, observed_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      value.receivingPhoneNumberId,
      value.senderId,
      value.messageId,
      value.providerTimestampSeconds,
      value.observedAt,
    ],
  );
}
async function blocked(observer: Pool, owner: number, contender: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{
      blockers: number[];
      wait_event_type: string | null;
      query: string;
    }>(
      `SELECT pg_blocking_pids(pid) AS blockers, wait_event_type, query
        FROM pg_stat_activity WHERE pid = $1`,
      [contender],
    );
    if (rows[0]?.blockers.includes(owner)) {
      expect(rows[0].wait_event_type).toBe('Lock');
      expect(rows[0].query).toContain(
        'INSERT INTO customer_inbound_observations',
      );
      return;
    }
    await delay(20);
  }
  throw new Error('Expected exact fixture PID to block adapter INSERT');
}

ddescribe('customer inbound observation adapter (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let writer: Pool;
  let reader: Pool;
  let control: Pool;
  const makePool = () => {
    if (!container) throw new Error('Disposable container unavailable');
    return new Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 12_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 20_000,
    });
  };
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
        '3100000000000',
        '--timestamp',
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
    writer = makePool();
    reader = makePool();
    control = makePool();
  });
  afterAll(async () => {
    try {
      const ended = await Promise.allSettled([
        writer?.end(),
        reader?.end(),
        control?.end(),
      ]);
      for (const result of ended)
        if (result.status === 'rejected') throw result.reason;
    } finally {
      await container?.stop();
    }
  });
  beforeEach(async () => {
    await writer.query('TRUNCATE TABLE customer_inbound_observations');
  });
  async function freshRead(sender = observation().senderId, phone = PHONE) {
    const pool = makePool();
    try {
      return await new Store(pool).readLatest(sender, phone);
    } finally {
      await pool.end();
    }
  }

  it('roundtrips original bytes and retains the first persisted observation on replay', async () => {
    const original = observation();
    const store = new Store(writer);
    expect(await freshRead()).toEqual({ kind: 'missing' });
    expect(original.senderId.normalize('NFC')).not.toBe(original.senderId);
    expect(original.messageId.normalize('NFC')).not.toBe(original.messageId);
    expect(await store.record(original)).toEqual({
      kind: 'recorded',
      observation: original,
    });
    const before = await snapshot(reader);
    expect(before).toHaveLength(1);
    for (const observedAt of ['2026-06-22T00:02:03.004Z', EARLY, LATE]) {
      expect(
        await new Store(reader).record({ ...original, observedAt }),
      ).toEqual({
        kind: 'replay',
        observation: original,
      });
      expect(await store.readLatest(original.senderId, PHONE)).toEqual(
        found(original),
      );
    }
    expect(await snapshot(reader)).toEqual(before);
    expect(await freshRead()).toEqual(found(original));
  });

  it('selects numeric provider time and C-ID ties despite arrival order, scoped to sender/phone', async () => {
    const store = new Store(writer);
    const latest = observation({
      messageId: 'z',
      providerTimestampSeconds: '100',
    });
    const otherSender = observation({
      senderId: 'other',
      messageId: 'other',
      providerTimestampSeconds: '200',
    });
    const otherPhone = observation({
      messageId: 'z',
      receivingPhoneNumberId: '987654321',
      providerTimestampSeconds: '300',
    });
    const events = [
      latest,
      observation({
        messageId: 'nine',
        providerTimestampSeconds: '9',
        observedAt: LATE,
      }),
      observation({
        messageId: 'a',
        providerTimestampSeconds: '100',
        observedAt: LATE,
      }),
      observation({
        messageId: 'ten',
        providerTimestampSeconds: '10',
        observedAt: LATE,
      }),
      otherSender,
      otherPhone,
    ];
    for (const event of events)
      expect(await store.record(event)).toEqual({
        kind: 'recorded',
        observation: event,
      });
    expect(await freshRead()).toEqual(found(latest));
    expect(await freshRead('other')).toEqual(found(otherSender));
    expect(await freshRead(latest.senderId, '987654321')).toEqual(
      found(otherPhone),
    );
    expect(await freshRead('other', '987654321')).toEqual({ kind: 'missing' });
    expect(await snapshot(reader)).toHaveLength(events.length);
  });

  it('remembers historical sender/provider conflicts after newer events without renewing latest', async () => {
    const store = new Store(writer);
    const original = observation();
    const latest = observation({
      messageId: 'newer',
      providerTimestampSeconds: '200',
    });
    for (const event of [original, latest])
      expect(await store.record(event)).toEqual({
        kind: 'recorded',
        observation: event,
      });
    const before = await snapshot(reader);
    for (const patch of [
      { senderId: 'other' },
      { providerTimestampSeconds: '300' },
    ]) {
      expect(
        await new Store(reader).record({
          ...original,
          ...patch,
          observedAt: LATE,
        }),
      ).toEqual({ kind: 'hold' });
      expect(await store.readLatest(original.senderId, PHONE)).toEqual(
        found(latest),
      );
      expect(await snapshot(reader)).toEqual(before);
    }
    expect(await store.record({ ...original, observedAt: LATE })).toEqual({
      kind: 'replay',
      observation: original,
    });
    expect(await freshRead('other')).toEqual({ kind: 'missing' });
    expect(await freshRead()).toEqual(found(latest));
    expect(await snapshot(reader)).toEqual(before);
  });

  it('holds malformed latest without falling back to older evidence or repairing a replay', async () => {
    const store = new Store(writer);
    const older = observation();
    expect(await store.record(older)).toEqual({
      kind: 'recorded',
      observation: older,
    });
    const validRetry = observation({
      messageId: 'corrupt',
      providerTimestampSeconds: '200',
    });
    const client = await control.connect();
    try {
      // Schema permits this shape, but the domain rejects its calendar.
      await seed(client, {
        ...validRetry,
        observedAt: '2026-99-99T99:99:99.999Z',
      });
    } finally {
      client.release();
    }
    const before = await snapshot(reader);
    expect(before).toHaveLength(2);
    expect(await store.readLatest(older.senderId, PHONE)).toEqual({
      kind: 'hold',
    });
    expect(await store.record(validRetry)).toEqual({ kind: 'hold' });
    expect(await freshRead()).toEqual({ kind: 'hold' });
    expect(await snapshot(reader)).toEqual(before);
  });

  describe.each(['COMMIT', 'ROLLBACK'] as const)(
    '%s first INSERT',
    (release) => {
      it.each(['replay', 'sender conflict', 'provider conflict'] as const)(
        'resolves a blocked %s using committed evidence only',
        async (mode) => {
          const original = observation();
          const contender = observation({
            observedAt: LATE,
            ...(mode === 'sender conflict' ? { senderId: 'other' } : {}),
            ...(mode === 'provider conflict'
              ? { providerTimestampSeconds: '101' }
              : {}),
          });
          const guard = await control.connect();
          let open = false;
          let settled = false;
          let pending:
            | Promise<{ value: unknown } | { error: unknown }>
            | undefined;
          try {
            const owner = (
              await guard.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0].pid;
            const rival = (
              await writer.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0].pid;
            expect(owner).not.toBe(rival);
            await guard.query('BEGIN');
            open = true;
            await seed(guard, original);
            expect(
              await new Store(reader).readLatest(original.senderId, PHONE),
            ).toEqual({ kind: 'missing' });
            pending = new Store(writer).record(contender).then(
              (value) => {
                settled = true;
                return { value };
              },
              (error: unknown) => {
                settled = true;
                return { error };
              },
            );
            await blocked(reader, owner, rival);
            expect(settled).toBe(false);
            expect(await snapshot(reader)).toEqual([]);
            await guard.query(release);
            open = false;
            const result = await pending;
            if ('error' in result) throw result.error;
            const durable = release === 'COMMIT' ? original : contender;
            expect(result.value).toEqual(
              release === 'COMMIT' && mode !== 'replay'
                ? { kind: 'hold' }
                : {
                    kind: release === 'COMMIT' ? 'replay' : 'recorded',
                    observation: durable,
                  },
            );
            expect(
              await new Store(reader).readLatest(durable.senderId, PHONE),
            ).toEqual(found(durable));
            const before = await snapshot(reader);
            expect(before).toHaveLength(1);
            expect(await new Store(writer).record(durable)).toEqual({
              kind: 'replay',
              observation: durable,
            });
            expect(await snapshot(reader)).toEqual(before);
            expect(await freshRead(durable.senderId)).toEqual(found(durable));
            if (mode === 'sender conflict')
              expect(
                await freshRead(
                  release === 'COMMIT' ? contender.senderId : original.senderId,
                ),
              ).toEqual({ kind: 'missing' });
          } finally {
            try {
              if (open) await guard.query('ROLLBACK');
            } finally {
              guard.release(true);
              await pending;
            }
          }
          const idle = await reader.query(`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
          expect(idle.rows).toEqual([]);
        },
      );
    },
  );
});
