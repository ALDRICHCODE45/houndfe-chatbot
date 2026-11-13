import { Logger } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type {
  ReadFeedOptions,
  ReadFeedResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import { HumanRequestDeliveryService } from '../application/human-request-delivery.service';
import { HumanRequestFeedConsumer } from '../application/human-request-feed.consumer';
import {
  LIVE_DECISIONS,
  REF,
  SCHEDULE_DECISIONS,
  cancelledItem,
  overdueItem,
  reminderItem,
  rescheduledItem,
  runHumanRequestFeedStoreContract,
  staffMessageItem,
  templateItem,
} from './human-request-feed-store.contract';
import { PostgresFeedConsumerLock } from './postgres-feed-consumer.lock';
import { PostgresHumanRequestFeedStore } from './postgres-human-request-feed.store';

describe('PostgresHumanRequestFeedStore.insertDelivery fallbacks (stubbed pool)', () => {
  const storedRow = {
    delivery_id: 'c1',
    cursor: cancelledItem('c1').cursor,
    type: 'request.cancelled',
    request_id: 'req-c1',
    conversation_ref: REF,
    payload: cancelledItem('c1'),
    local_state: 'STALE',
    decision: 'DUPLICATE',
    attempt_id: null,
    provider_message_id: null,
    attempted_at: null,
    ack_state: null,
    ack_outcome: null,
    ack_attempts: 0,
    next_ack_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const stub = (second: unknown[]) => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: second });
    return {
      query,
      store: new PostgresHumanRequestFeedStore({ query } as unknown as Pool),
    };
  };

  it('a concurrent insert outside the statement snapshot is read back as not inserted', async () => {
    const { store, query } = stub([storedRow]);
    await expect(
      store.insertDelivery(cancelledItem('c1')),
    ).resolves.toMatchObject({
      row: { deliveryId: 'c1', localState: 'STALE' },
      inserted: false,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toEqual([
      expect.stringMatching(/SELECT/),
      ['c1'],
    ]);
  });

  it('throws when the row vanished between the insert and the read-back', async () => {
    const { store } = stub([]);
    await expect(store.insertDelivery(cancelledItem('c1'))).rejects.toThrow(
      'delivery c1 vanished after insert',
    );
  });
});

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const TRUNCATE_SQL =
  'TRUNCATE TABLE human_request_feed_cursor, human_request_deliveries, human_request_registry';

ddescribe('human request feed migration 4300 + store (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool;
  let uri: string;
  const migrate = (direction: 'up' | 'down', ...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        BIN,
        '-f',
        'package.json',
        '--config-value',
        'pg-migrate',
        // migrations/tsconfig.json (d6ba09b) is not a migration.
        '--ignore-pattern',
        '(\\..*|tsconfig\\.json)',
        direction,
        ...args,
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: uri },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
  const truncate = () => pool.query(TRUNCATE_SQL);
  /** A ledger row written without the store: the store's INSERT names
   *  columns of the latest migration, so it cannot run on a rolled-back
   *  schema. */
  const rawInsert = (id: string) =>
    pool.query(
      `INSERT INTO human_request_deliveries
         (delivery_id, cursor, type, payload, local_state)
       VALUES ($1, '1', 'request.cancelled', '{}'::jsonb, 'RECEIVED')`,
      [id],
    );
  /** How many migrations to roll back to undo `prefix` (and every later
   *  one), so the counts never go stale when a migration is added. */
  const since = async (prefix: string) =>
    (
      await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pgmigrations WHERE name >= $1`,
        [prefix],
      )
    ).rows[0].n;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    migrate('up');
    pool = new Pool({ connectionString: uri });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates the ledger with its checks and indexes', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'human_request_deliveries' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'ack_attempts',
      'ack_error',
      'ack_outcome',
      'ack_state',
      'attempt_id',
      'attempted_at',
      'conversation_ref',
      'created_at',
      'cursor',
      'decision',
      'delivery_id',
      'local_state',
      'message_id',
      'next_ack_at',
      'payload',
      'provider_message_id',
      'request_id',
      'type',
      'updated_at',
    ]);
    const insert = (patch: Record<string, string | null>) => {
      const row = {
        delivery_id: `d-${Math.random()}`,
        local_state: 'RECEIVED',
        ack_state: null,
        ...patch,
      };
      return pool.query(
        `INSERT INTO human_request_deliveries
           (delivery_id, cursor, type, payload, local_state, ack_state)
         VALUES ($1, '1', 'request.cancelled', '{}'::jsonb, $2, $3)`,
        [row.delivery_id, row.local_state, row.ack_state],
      );
    };
    await expect(insert({ local_state: 'LOST' })).rejects.toMatchObject({
      code: '23514',
    });
    // A PENDING ACK needs an outcome, an attempt and a due time.
    await expect(insert({ ack_state: 'PENDING' })).rejects.toMatchObject({
      code: '23514',
    });
    // SENDING needs the attempt evidence.
    await expect(insert({ local_state: 'SENDING' })).rejects.toMatchObject({
      code: '23514',
    });
    await insert({ delivery_id: 'dup' });
    await expect(insert({ delivery_id: 'dup' })).rejects.toMatchObject({
      code: '23505',
    });
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'human_request_deliveries'`,
    );
    const defs = indexes.rows.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/\(next_ack_at\) WHERE \(ack_state = 'PENDING'/);
    expect(defs).toMatch(/\(conversation_ref, local_state\)/);
    await truncate();
  });

  it('down refuses while a delivery still owes work, then rolls back and re-applies', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    await store.insertDelivery(cancelledItem('g1'));
    await store.transition(
      'g1',
      { localState: 'RECEIVED', attemptId: null },
      {
        localState: 'STALE',
        decision: 'DUPLICATE',
        attemptId: '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10',
        attemptedAt: '2026-11-10T16:20:00.000Z',
        providerMessageId: null,
        ack: 'STALE',
      },
    );
    const applied = async () =>
      (
        await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM pgmigrations
            WHERE name >= '4300000000000_human_request_feed'`,
        )
      ).rows[0].n;
    // Rolled back by count (later migrations first); 4300 refuses.
    const n = await applied();
    expect(() => migrate('down', n)).toThrow();
    await truncate();
    migrate('down', await applied());
    const gone = await pool.query(
      "SELECT to_regclass('human_request_deliveries') AS t",
    );
    expect(gone.rows[0]).toEqual({ t: null });
    migrate('up');
  });

  it('a concurrent insert committed while the statement waited is returned as not inserted', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        `INSERT INTO human_request_deliveries
           (delivery_id, cursor, type, payload, local_state)
         VALUES ('race1', '5', 'request.cancelled', $1::jsonb, 'RECEIVED')`,
        [JSON.stringify(cancelledItem('race1'))],
      );
      const pending = store.insertDelivery(cancelledItem('race1'));
      // Let the INSERT block on the uncommitted key, then commit.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await other.query('COMMIT');
      await expect(pending).resolves.toMatchObject({
        inserted: false,
        row: { deliveryId: 'race1', cursor: '5' },
      });
    } finally {
      other.release();
    }
    await truncate();
  });

  it('migration 4500: purge index and the LOCAL_FAILURE decision', async () => {
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'human_request_deliveries_purge_idx'`,
    );
    expect(indexes.rows[0]?.indexdef).toMatch(/\(updated_at\) WHERE/);
    const store = new PostgresHumanRequestFeedStore(pool);
    await store.insertDelivery(cancelledItem('lf1'));
    await expect(
      store.transition(
        'lf1',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'STALE',
          decision: 'LOCAL_FAILURE',
          attemptId: '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10',
          attemptedAt: '2026-11-10T16:20:00.000Z',
          providerMessageId: null,
          ack: null,
        },
      ),
    ).resolves.toMatchObject({ decision: 'LOCAL_FAILURE' });
    // down (every later migration, then 4500) refuses while a LOCAL_FAILURE row exists.
    const count4500 = await since('4500000000000');
    expect(() => migrate('down', count4500)).toThrow();
    await truncate();
    migrate('down', count4500);
    const gone = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'human_request_deliveries_purge_idx'`,
    );
    expect(gone.rowCount).toBe(0);
    migrate('up');
  });

  it('migration 4600: OVERDUE_NOTICE and HUMAN_SESSION decisions', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    for (const decision of ['OVERDUE_NOTICE', 'HUMAN_SESSION'] as const) {
      await store.insertDelivery(overdueItem(`ov-${decision}`));
      await expect(
        store.transition(
          `ov-${decision}`,
          { localState: 'RECEIVED', attemptId: null },
          {
            localState: 'STALE',
            decision,
            attemptId: '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10',
            attemptedAt: '2026-11-10T16:20:00.000Z',
            providerMessageId: null,
            ack: 'STALE',
          },
        ),
      ).resolves.toMatchObject({ decision });
    }
    // down refuses while a row uses a new decision.
    const count4600 = await since('4600000000000');
    expect(() => migrate('down', count4600)).toThrow();
    await truncate();
    migrate('down', count4600);
    await rawInsert('ov-old');
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'OVERDUE_NOTICE'
          WHERE delivery_id = 'ov-old'`,
      ),
    ).rejects.toThrow(/decision_check/);
    // The previous decisions still pass the restored CHECK.
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'LOCAL_FAILURE'
          WHERE delivery_id = 'ov-old'`,
      ),
    ).resolves.toBeDefined();
    await truncate();
    migrate('up');
  });

  it('migration 4700: REQUEST_CLOSED decision', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    await store.insertDelivery(overdueItem('rc-1'));
    await expect(
      store.transition(
        'rc-1',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'STALE',
          decision: 'REQUEST_CLOSED',
          attemptId: '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10',
          attemptedAt: '2026-11-10T16:20:00.000Z',
          providerMessageId: null,
          ack: 'STALE',
        },
      ),
    ).resolves.toMatchObject({ decision: 'REQUEST_CLOSED' });
    // down refuses while a row uses the new decision.
    const count4700 = await since('4700000000000');
    expect(() => migrate('down', count4700)).toThrow();
    await truncate();
    migrate('down', count4700);
    await rawInsert('rc-old');
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'REQUEST_CLOSED'
          WHERE delivery_id = 'rc-old'`,
      ),
    ).rejects.toThrow(/decision_check/);
    // The 4600 decisions still pass the restored CHECK.
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'HUMAN_SESSION'
          WHERE delivery_id = 'rc-old'`,
      ),
    ).resolves.toBeDefined();
    await truncate();
    migrate('up');
  });

  it('migration 4900: live conversation decisions, message_id key and guarded down', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    const columns = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'human_request_deliveries' AND column_name = 'message_id'`,
    );
    expect(columns.rows[0]).toEqual({ is_nullable: 'YES' });
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'human_request_deliveries_message_id_uidx'`,
    );
    expect(indexes.rows[0]?.indexdef).toMatch(
      /UNIQUE INDEX .*\(message_id\) WHERE \(message_id IS NOT NULL\)/,
    );
    // The CHECKs: every new decision is accepted, an unknown one is not, and
    // an empty message_id is refused.
    await store.insertDelivery(cancelledItem('m-1'));
    for (const decision of LIVE_DECISIONS)
      await expect(
        pool.query(
          `UPDATE human_request_deliveries SET decision = $1 WHERE delivery_id = 'm-1'`,
          [decision],
        ),
      ).resolves.toBeDefined();
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'NOPE' WHERE delivery_id = 'm-1'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET message_id = '' WHERE delivery_id = 'm-1'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // The unique index is the dedupe: a second row cannot take the key, and
    // NULL keys never collide.
    await store.insertDelivery(staffMessageItem('m-2', 'same-key'));
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET message_id = 'same-key' WHERE delivery_id = 'm-1'`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // Staff message and template of the same messageId collide too.
    await expect(
      store.insertDelivery(templateItem('m-3', 'same-key')),
    ).resolves.toMatchObject({
      inserted: true,
      duplicateOf: 'm-2',
      row: { messageId: null },
    });
    await expect(
      store.insertDelivery(cancelledItem('m-4')),
    ).resolves.toMatchObject({
      inserted: true,
    });
    await truncate();

    // down refuses while a row has a message_id or a live decision (every
    // later migration is rolled back first, in one transaction).
    const count4900 = await since('4900000000000');
    await store.insertDelivery(staffMessageItem('m-5', 'key-5'));
    expect(() => migrate('down', count4900)).toThrow(/refusing to roll back/);
    await truncate();
    await store.insertDelivery(cancelledItem('m-6'));
    await pool.query(
      `UPDATE human_request_deliveries SET decision = 'FAREWELL' WHERE delivery_id = 'm-6'`,
    );
    expect(() => migrate('down', count4900)).toThrow(/refusing to roll back/);
    await truncate();

    // Empty ledger: down restores the old CHECK and drops the column.
    migrate('down', count4900);
    const gone = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'human_request_deliveries' AND column_name = 'message_id'`,
    );
    expect(gone.rowCount).toBe(0);
    await rawInsert('m-7');
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'FAREWELL' WHERE delivery_id = 'm-7'`,
      ),
    ).rejects.toThrow(/decision_check/);
    // The 4700 decisions still pass the restored CHECK.
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'REQUEST_CLOSED' WHERE delivery_id = 'm-7'`,
      ),
    ).resolves.toBeDefined();
    await truncate();
    migrate('up');
    expect(Number(await since('4900000000000'))).toBeGreaterThanOrEqual(1);
  });

  it('migration 5000: scheduling decisions, every older one kept, guarded down', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    await store.insertDelivery(reminderItem('sc-1'));
    // Every new decision is accepted, and the old ones (4900's included)
    // still are; an unknown one is not.
    for (const decision of [
      ...SCHEDULE_DECISIONS,
      ...LIVE_DECISIONS,
      'HUMAN_SESSION',
      'REQUEST_CLOSED',
      'WINDOW_CLOSED',
      'LOCAL_FAILURE',
    ])
      await expect(
        pool.query(
          `UPDATE human_request_deliveries SET decision = $1 WHERE delivery_id = 'sc-1'`,
          [decision],
        ),
      ).resolves.toBeDefined();
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'NOPE' WHERE delivery_id = 'sc-1'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // A scheduled item goes through the store like any other.
    await store.insertDelivery(rescheduledItem('sc-2'));
    await expect(store.getDelivery('sc-2')).resolves.toMatchObject({
      type: 'conversation.rescheduled',
      requestId: 'req-sc-2',
      item: { type: 'conversation.rescheduled' },
    });
    await truncate();

    // down refuses while a row uses a scheduling decision (and leaves the
    // schema as it was: one transaction).
    const count5000 = await since('5000000000000');
    for (const decision of SCHEDULE_DECISIONS) {
      await store.insertDelivery(reminderItem('sc-3'));
      await pool.query(
        `UPDATE human_request_deliveries SET decision = $1 WHERE delivery_id = 'sc-3'`,
        [decision],
      );
      expect(() => migrate('down', count5000)).toThrow(/refusing to roll back/);
      await expect(since('5000000000000')).resolves.toBe(count5000);
      await truncate();
    }

    // A row with an older decision does not block it; the old CHECK is back.
    await store.insertDelivery(reminderItem('sc-4'));
    await pool.query(
      `UPDATE human_request_deliveries SET decision = 'FAREWELL' WHERE delivery_id = 'sc-4'`,
    );
    migrate('down', count5000);
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'REMINDER_SENT' WHERE delivery_id = 'sc-4'`,
      ),
    ).rejects.toThrow(/decision_check/);
    // 4900's decisions still pass the restored CHECK.
    await expect(
      pool.query(
        `UPDATE human_request_deliveries SET decision = 'SEND_REFUSED' WHERE delivery_id = 'sc-4'`,
      ),
    ).resolves.toBeDefined();
    await truncate();
    migrate('up');
    await expect(since('5000000000000')).resolves.toBe('1');
  });

  runHumanRequestFeedStoreContract('postgres', () =>
    Promise.resolve({
      store: new PostgresHumanRequestFeedStore(pool),
      cleanup: async () => {
        await truncate();
      },
    }),
  );

  it('the advisory lock admits one holder at a time', async () => {
    const a = new PostgresFeedConsumerLock(pool);
    const b = new PostgresFeedConsumerLock(pool);
    await expect(a.tryAcquire()).resolves.toBe(true);
    await expect(a.isHeld()).resolves.toBe(true);
    await expect(b.tryAcquire()).resolves.toBe(false);
    await a.release();
    await expect(a.isHeld()).resolves.toBe(false);
    await expect(b.tryAcquire()).resolves.toBe(true);
    await b.release();
  });

  it('two consumer instances: only the lock holder reads the feed', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    const reads = { a: 0, b: 0 };
    const make = (name: 'a' | 'b') =>
      new HumanRequestFeedConsumer(
        {
          store,
          client: {
            readFeed: async (options: ReadFeedOptions = {}) => {
              reads[name] += 1;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return {
                kind: 'ok',
                items: [],
                nextCursor: options.after ?? '',
              } satisfies ReadFeedResult;
            },
            listOpenRequests: () => Promise.reject(new Error('unused')),
          },
          delivery: {
            accept: () => Promise.resolve(),
            abandon: () => Promise.resolve(),
          },
          lock: new PostgresFeedConsumerLock(pool),
        },
        { lockRetryMs: 25 },
      );
    const a = make('a');
    const b = make('b');
    a.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    b.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads.a).toBeGreaterThan(0);
    expect(reads.b).toBe(0);
    // The holder stops: the other instance takes over.
    await a.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads.b).toBeGreaterThan(0);
    await b.stop();
  });

  it('crash after the send, before the ACK: the replay ACKs the stored evidence, no second send', async () => {
    const store = new PostgresHumanRequestFeedStore(pool);
    const sent: string[] = [];
    const acks: unknown[] = [];
    let ackFails = true;
    const service = () =>
      new HumanRequestDeliveryService({
        store,
        client: {
          recordDeliveryOutcome: (deliveryId, body) => {
            acks.push(body);
            if (ackFails) return Promise.reject(new Error('socket hang up'));
            return Promise.resolve({
              kind: 'ok',
              response: {
                deliveryId,
                outcome: body.outcome,
                attemptId: body.attemptId,
                ackReceivedAt: null,
              },
            });
          },
          listPendingDeliveries: () =>
            Promise.resolve({ kind: 'ok', items: [] }),
        },
        sender: {
          sendText: ({ text }) => {
            sent.push(text);
            return Promise.resolve({ providerMessageId: 'wamid.pg' });
          },
        },
        handoff: { isHumanMode: () => Promise.resolve(false) },
        isWindowOpen: () => Promise.resolve(true),
      });
    await service().accept(cancelledItem('x1'));
    expect(sent).toHaveLength(1);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      localState: 'SENT',
      providerMessageId: 'wamid.pg',
      ackState: 'PENDING',
      conversationRef: REF,
    });
    // "Restart": a new service instance re-reads the same page.
    ackFails = false;
    await service().accept(cancelledItem('x1'));
    expect(sent).toHaveLength(1);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual(acks[0]);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      ackState: 'ACKED',
    });
    await truncate();
  });
});
