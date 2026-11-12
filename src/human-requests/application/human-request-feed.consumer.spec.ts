import { Logger } from '@nestjs/common';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type {
  FeedItem,
  ListOpenRequestsOptions,
  ListOpenRequestsResult,
  OpenHumanRequest,
  ReadFeedOptions,
  ReadFeedResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { FeedConsumerLock } from '../domain/human-request-feed';
import {
  REF,
  cancelledItem,
} from '../infrastructure/human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestFeedConsumer } from './human-request-feed.consumer';

type OpenStep =
  | ListOpenRequestsResult
  | Error
  | (() => Promise<ListOpenRequestsResult>);

class ScriptedFeed {
  readonly calls: ReadFeedOptions[] = [];
  readonly openCalls: ListOpenRequestsOptions[] = [];
  openScript: OpenStep[] = [];
  constructor(private readonly script: Array<ReadFeedResult | Error>) {}
  listOpenRequests(
    options: ListOpenRequestsOptions = {},
  ): Promise<ListOpenRequestsResult> {
    this.openCalls.push(options);
    const next = this.openScript.shift();
    if (next === undefined)
      return Promise.reject(new Error('unexpected listOpenRequests'));
    if (typeof next === 'function') return next();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
  readFeed(options: ReadFeedOptions = {}): Promise<ReadFeedResult> {
    this.calls.push(options);
    const next = this.script.shift();
    if (next === undefined)
      return Promise.resolve({
        kind: 'ok',
        items: [],
        nextCursor: options.after ?? '',
      });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

class FakeLock implements FeedConsumerLock {
  held = false;
  released = 0;
  constructor(private readonly grants: boolean[] = []) {}
  tryAcquire(): Promise<boolean> {
    this.held = this.grants.shift() ?? true;
    return Promise.resolve(this.held);
  }
  isHeld(): Promise<boolean> {
    return Promise.resolve(this.held);
  }
  release(): Promise<void> {
    this.held = false;
    this.released += 1;
    return Promise.resolve();
  }
}

const page = (items: FeedItem[], nextCursor: string): ReadFeedResult => ({
  kind: 'ok',
  items,
  nextCursor,
});

const openRequest = (
  id: string,
  patch: Partial<OpenHumanRequest> = {},
): OpenHumanRequest => ({
  id,
  folio: `S-${id}`,
  kind: 'DIRECT',
  subtype: 'UNKNOWN_QUESTION',
  status: 'NEW',
  conversationRef: REF,
  legacyId: null,
  whatsappWindowClosesAt: null,
  cancelReason: null,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T16:00:00.000Z',
  closedAt: null,
  pendingDeliveries: [],
  undeliveredTruncated: false,
  undeliveredResumeAfter: null,
  ...patch,
});

const openPage = (
  items: OpenHumanRequest[],
  nextCursor: string,
  nextPage: string | null,
): ListOpenRequestsResult => ({ kind: 'ok', items, nextCursor, nextPage });

describe('HumanRequestFeedConsumer', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const build = (
    script: Array<ReadFeedResult | Error>,
    accept: (item: FeedItem) => Promise<void> = () => Promise.resolve(),
    lock = new FakeLock(),
  ) => {
    const store = new InMemoryHumanRequestFeedStore();
    const feed = new ScriptedFeed(script);
    const accepted: string[] = [];
    const sleeps: number[] = [];
    const consumer = new HumanRequestFeedConsumer(
      {
        store,
        client: feed,
        delivery: {
          accept: async (item) => {
            await accept(item);
            accepted.push(item.deliveryId);
          },
          abandon: () => Promise.resolve(),
        },
        lock,
      },
      {
        random: () => 1,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    return { store, feed, accepted, sleeps, consumer, lock };
  };

  it('long-polls from the stored cursor and saves nextCursor after the page', async () => {
    const { store, feed, accepted, consumer } = build([
      page([cancelledItem('a'), cancelledItem('b')], '000000000002'),
    ]);
    await store.saveCursor('000000000000');
    await expect(consumer.runOnce()).resolves.toEqual({
      kind: 'page',
      items: 2,
    });
    expect(feed.calls).toEqual([
      { after: '000000000000', limit: 50, waitSeconds: 25 },
    ]);
    expect(accepted).toEqual(['a', 'b']);
    await expect(store.readCursor()).resolves.toBe('000000000002');
  });

  it('starts from the oldest item with no stored cursor', async () => {
    const { feed, consumer } = build([page([], '')]);
    await consumer.runOnce();
    expect(feed.calls[0]).toEqual({ limit: 50, waitSeconds: 25 });
  });

  it('a failing item leaves the cursor where it was (the page is re-read)', async () => {
    let fail = true;
    const { store, accepted, consumer } = build(
      [
        page([cancelledItem('a'), cancelledItem('b')], '000000000002'),
        page([cancelledItem('a'), cancelledItem('b')], '000000000002'),
      ],
      (item) =>
        item.deliveryId === 'b' && fail
          ? Promise.reject(new Error('db'))
          : Promise.resolve(),
    );
    await store.saveCursor('000000000000');
    await expect(consumer.runOnce()).rejects.toThrow('db');
    await expect(store.readCursor()).resolves.toBe('000000000000');
    fail = false;
    await consumer.runOnce();
    expect(accepted).toEqual(['a', 'a', 'b']);
    await expect(store.readCursor()).resolves.toBe('000000000002');
  });

  it('a handled page saves the instant read began as synced_at, also when empty', async () => {
    const clock = { now: Date.parse('2026-11-11T10:00:00.000Z') };
    const store = new InMemoryHumanRequestFeedStore();
    const feed = new ScriptedFeed([
      page([cancelledItem('a')], '000000000002'),
      page([], '000000000002'),
    ]);
    const consumer = new HumanRequestFeedConsumer(
      {
        store,
        client: feed,
        delivery: {
          accept: () => {
            clock.now += 60_000; // handling takes time
            return Promise.resolve();
          },
          abandon: () => Promise.resolve(),
        },
        lock: new FakeLock(),
      },
      { clock: () => clock.now },
    );
    await consumer.runOnce();
    await expect(store.readSyncedAt()).resolves.toBe(
      '2026-11-11T10:00:00.000Z',
    );
    clock.now = Date.parse('2026-11-11T11:00:00.000Z');
    await consumer.runOnce();
    await expect(store.readCursor()).resolves.toBe('000000000002');
    await expect(store.readSyncedAt()).resolves.toBe(
      '2026-11-11T11:00:00.000Z',
    );
  });

  it('a failed page does not move synced_at', async () => {
    const { store, consumer } = build(
      [page([cancelledItem('a')], '000000000002')],
      () => Promise.reject(new Error('db')),
    );
    await store.saveCursor('000000000000', '2026-11-01T00:00:00.000Z');
    await expect(consumer.runOnce()).rejects.toThrow('db');
    await expect(store.readSyncedAt()).resolves.toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  describe('CURSOR_EXPIRED recovery (5c)', () => {
    const SYNCED = '2026-11-01T00:00:00.000Z';
    /** The walk starts 2 minutes after the local rows were written, so
     *  they are older than the recovery grace. */
    const later = () => Date.now() + 120_000;
    const buildRecovery = (
      accept: (item: FeedItem) => Promise<void> = () => Promise.resolve(),
      clock: () => number = later,
    ) => {
      const store = new InMemoryHumanRequestFeedStore();
      const feed = new ScriptedFeed([{ kind: 'CURSOR_EXPIRED' }]);
      const accepted: string[] = [];
      const sleeps: number[] = [];
      const consumer = new HumanRequestFeedConsumer(
        {
          store,
          client: feed,
          delivery: {
            accept: async (item) => {
              await accept(item);
              accepted.push(item.deliveryId);
            },
            abandon: () => Promise.resolve(),
          },
          lock: new FakeLock(),
        },
        {
          clock,
          random: () => 1,
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
      );
      return { store, feed, accepted, sleeps, consumer };
    };

    it('walks every page, reconciles the registry, handles pending deliveries and resumes from nextCursor', async () => {
      const { store, feed, accepted, consumer } = buildRecovery();
      await store.saveCursor('000000000009', SYNCED);
      await store.recordOpenRequest({
        requestId: 'resolved',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      await store.recordOpenRequest({
        requestId: 'cancelled',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      await store.recordOpenRequest({
        requestId: 'gone',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      await store.recordOpenRequest({
        requestId: 'still-open',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      feed.openScript = [
        openPage(
          [
            openRequest('new', {
              subtype: 'RESTOCK',
              legacyId: 'legacy-new',
              pendingDeliveries: [cancelledItem('p1')],
            }),
            openRequest('still-open', { status: 'IN_PROGRESS' }),
            openRequest('no-conversation', { conversationRef: null }),
          ],
          '000000001900',
          'page-2',
        ),
        openPage(
          [
            openRequest('resolved', {
              status: 'RESOLVED',
              pendingDeliveries: [cancelledItem('p2'), cancelledItem('p3')],
            }),
            openRequest('cancelled', {
              status: 'CANCELLED',
              cancelReason: 'DUPLICATE',
            }),
          ],
          // Every page of one walk carries the first page's position.
          '000000001950',
          null,
        ),
      ];

      await expect(consumer.runOnce()).resolves.toEqual({
        kind: 'recovered',
        requests: 5,
        deliveries: 3,
      });
      expect(feed.openCalls).toEqual([
        { updatedSince: SYNCED, limit: 50 },
        { updatedSince: SYNCED, cursor: 'page-2', limit: 50 },
      ]);
      expect(accepted).toEqual(['p1', 'p2', 'p3']);
      await expect(store.getRequest('new')).resolves.toMatchObject({
        status: 'OPEN',
        subtype: 'RESTOCK',
        legacyId: 'legacy-new',
        conversationRef: REF,
      });
      await expect(store.getRequest('no-conversation')).resolves.toBeNull();
      for (const [id, status] of [
        ['still-open', 'OPEN'],
        ['resolved', 'RESOLVED'],
        ['cancelled', 'CANCELLED'],
        ['gone', 'RESOLVED'],
      ] as const)
        await expect(store.getRequest(id)).resolves.toMatchObject({ status });
      await expect(store.readCursor()).resolves.toBe('000000001900');
      // The feed resumes from the recovered position.
      await consumer.runOnce();
      expect(feed.calls.at(-1)).toEqual({
        after: '000000001900',
        limit: 50,
        waitSeconds: 25,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('CURSOR_EXPIRED'),
      );
    });

    it('saves the walk start as synced_at and omits updatedSince when unknown', async () => {
      const start = Date.parse('2026-11-11T12:00:00.000Z');
      let now = start;
      const { store, feed, consumer } = buildRecovery(
        () => {
          now += 1_000;
          return Promise.resolve();
        },
        () => now,
      );
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage(
          [openRequest('r', { pendingDeliveries: [cancelledItem('p1')] })],
          '000000000100',
          null,
        ),
      ];
      await consumer.runOnce();
      expect(feed.openCalls).toEqual([{ limit: 50 }]);
      await expect(store.readSyncedAt()).resolves.toBe(
        new Date(start).toISOString(),
      );
    });

    it('truncated: resumes from the smallest undeliveredResumeAfter (string comparison)', async () => {
      const { store, feed, consumer } = buildRecovery();
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage(
          [
            openRequest('a', {
              undeliveredTruncated: true,
              undeliveredResumeAfter: '000000001700',
            }),
          ],
          '000000001900',
          'p2',
        ),
        openPage(
          [
            openRequest('b', {
              undeliveredTruncated: true,
              undeliveredResumeAfter: '000000000980',
            }),
            openRequest('c', {
              undeliveredTruncated: true,
              undeliveredResumeAfter: '000000001200',
            }),
          ],
          '000000001900',
          null,
        ),
      ];
      await consumer.runOnce();
      await expect(store.readCursor()).resolves.toBe('000000000980');
    });

    it('nextCursor is kept when it is the smallest', async () => {
      const { store, feed, consumer } = buildRecovery();
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage(
          [
            openRequest('a', {
              undeliveredTruncated: true,
              undeliveredResumeAfter: '000000002000',
            }),
          ],
          '000000001900',
          null,
        ),
      ];
      await consumer.runOnce();
      await expect(store.readCursor()).resolves.toBe('000000001900');
    });

    it('a page failing mid-walk never moves the cursor, synced_at or the registry; the next pass walks again', async () => {
      const { store, feed, accepted, consumer } = buildRecovery();
      await store.saveCursor('000000000009', SYNCED);
      await store.recordOpenRequest({
        requestId: 'gone',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      const first = openPage(
        [openRequest('a', { pendingDeliveries: [cancelledItem('p1')] })],
        '000000001900',
        'p2',
      );
      feed.openScript = [first, new Error('502')];
      await expect(consumer.runOnce()).rejects.toThrow('502');
      await expect(store.readCursor()).resolves.toBe('000000000009');
      await expect(store.readSyncedAt()).resolves.toBe(SYNCED);
      await expect(store.getRequest('gone')).resolves.toMatchObject({
        status: 'OPEN',
      });

      // The expired cursor answers 410 again: the walk restarts at page 1.
      feed.calls.length = 0;
      (feed as unknown as { script: ReadFeedResult[] }).script.push({
        kind: 'CURSOR_EXPIRED',
      });
      feed.openScript = [
        first,
        openPage([openRequest('b')], '000000001900', null),
      ];
      await expect(consumer.runOnce()).resolves.toMatchObject({
        kind: 'recovered',
      });
      expect(feed.calls[0]).toEqual({
        after: '000000000009',
        limit: 50,
        waitSeconds: 25,
      });
      expect(feed.openCalls.at(-2)).toEqual({
        updatedSince: SYNCED,
        limit: 50,
      });
      expect(accepted).toEqual(['p1', 'p1']);
      await expect(store.readCursor()).resolves.toBe('000000001900');
      await expect(store.getRequest('gone')).resolves.toMatchObject({
        status: 'RESOLVED',
      });
    });

    it('a pending delivery failing mid-walk leaves the cursor on the expired value', async () => {
      const { store, feed, consumer } = buildRecovery((item) =>
        item.deliveryId === 'p2'
          ? Promise.reject(new Error('handoff mode unreadable'))
          : Promise.resolve(),
      );
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage(
          [
            openRequest('a', {
              pendingDeliveries: [cancelledItem('p1'), cancelledItem('p2')],
            }),
          ],
          '000000001900',
          null,
        ),
      ];
      await expect(consumer.runOnce()).rejects.toThrow('unreadable');
      await expect(store.readCursor()).resolves.toBe('000000000009');
    });

    it('RATE_LIMITED mid-walk waits Retry-After and asks for the same page again', async () => {
      const { store, feed, sleeps, consumer } = buildRecovery();
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage([openRequest('a')], '000000001900', 'p2'),
        { kind: 'RATE_LIMITED', retryAfterSeconds: 4 },
        openPage([openRequest('b')], '000000001900', null),
      ];
      await expect(consumer.runOnce()).resolves.toMatchObject({
        kind: 'recovered',
        requests: 2,
      });
      expect(sleeps).toEqual([4_000]);
      expect(feed.openCalls.map((call) => call.cursor)).toEqual([
        undefined,
        'p2',
        'p2',
      ]);
      await expect(store.readCursor()).resolves.toBe('000000001900');
    });

    it('VALIDATION_ERROR fails the pass with an error log; the cursor stays', async () => {
      const { store, feed, consumer } = buildRecovery();
      await store.saveCursor('000000000009', SYNCED);
      feed.openScript = [{ kind: 'VALIDATION_ERROR', message: 'updatedSince' }];
      await expect(consumer.runOnce()).rejects.toThrow('VALIDATION_ERROR');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('VALIDATION_ERROR'),
      );
      await expect(store.readCursor()).resolves.toBe('000000000009');
    });

    it('a local request recorded during the walk is not closed as "not listed"', async () => {
      const { store, feed, consumer } = buildRecovery(
        () => Promise.resolve(),
        Date.now,
      );
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage([], '000000001900', 'p2'),
        async () => {
          await store.recordOpenRequest({
            requestId: 'fresh',
            conversationRef: REF,
            subtype: 'UNKNOWN_QUESTION',
          });
          return openPage([], '000000001900', null);
        },
      ];
      await consumer.runOnce();
      await expect(store.getRequest('fresh')).resolves.toMatchObject({
        status: 'OPEN',
      });
    });

    it('stop during the walk saves nothing', async () => {
      const { store, feed, consumer } = buildRecovery();
      await store.saveCursor('000000000009');
      feed.openScript = [
        async () => {
          void consumer.stop();
          return openPage([openRequest('a')], '000000001900', null);
        },
      ];
      await expect(consumer.runOnce()).resolves.toEqual({ kind: 'stopped' });
      await expect(store.readCursor()).resolves.toBe('000000000009');
    });

    it('never logs a conversationRef unmasked', async () => {
      const { store, feed, consumer } = buildRecovery();
      await store.saveCursor('000000000009');
      feed.openScript = [
        openPage(
          [openRequest('a', { pendingDeliveries: [cancelledItem('p1')] })],
          '000000001900',
          null,
        ),
      ];
      await consumer.runOnce();
      const calls: unknown[][] = [
        ...(warn.mock.calls as unknown[][]),
        ...(error.mock.calls as unknown[][]),
      ];
      const logged = calls.flat().map(String).join('\n');
      expect(logged).not.toContain('5215550001111');
    });
  });

  it('RATE_LIMITED reports the Retry-After delay', async () => {
    const { consumer } = build([
      { kind: 'RATE_LIMITED', retryAfterSeconds: 3 },
    ]);
    await expect(consumer.runOnce()).resolves.toEqual({
      kind: 'rate_limited',
      retryAfterMs: 3000,
    });
  });

  describe('loop', () => {
    it('consumes only while it holds the advisory lock; releases it on stop', async () => {
      const lock = new FakeLock([false, true]);
      const { feed, consumer, sleeps } = build(
        [page([cancelledItem('a')], '1')],
        undefined,
        lock,
      );
      let ticks = 0;
      // Stop after a few loop iterations.
      const origRun = consumer.runOnce.bind(consumer);
      jest.spyOn(consumer, 'runOnce').mockImplementation(async () => {
        ticks += 1;
        const result = await origRun();
        if (ticks >= 2) void consumer.stop();
        return result;
      });
      consumer.start();
      await consumer.whenStopped();
      // First acquisition failed: slept the lock retry, no read meanwhile.
      expect(sleeps[0]).toBe(15_000);
      expect(feed.calls.length).toBeGreaterThanOrEqual(1);
      expect(lock.released).toBe(1);
    });

    it('backs off on throws and logs an error with the count for a stuck page', async () => {
      const { consumer, sleeps } = build([
        new Error('502'),
        new Error('502'),
        new Error('502'),
        new Error('502'),
      ]);
      let ticks = 0;
      const origRun = consumer.runOnce.bind(consumer);
      jest.spyOn(consumer, 'runOnce').mockImplementation(async () => {
        ticks += 1;
        if (ticks >= 4) void consumer.stop();
        return origRun();
      });
      consumer.start();
      await consumer.whenStopped();
      expect(sleeps.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/stuck.*3 consecutive failures/),
      );
    });

    it('honors Retry-After on RATE_LIMITED', async () => {
      const { consumer, sleeps } = build([
        { kind: 'RATE_LIMITED', retryAfterSeconds: 7 },
      ]);
      let ticks = 0;
      const origRun = consumer.runOnce.bind(consumer);
      jest.spyOn(consumer, 'runOnce').mockImplementation(async () => {
        ticks += 1;
        if (ticks >= 2) void consumer.stop();
        return origRun();
      });
      consumer.start();
      await consumer.whenStopped();
      expect(sleeps).toEqual([7_000]);
    });

    it('reacquires when the lock is lost', async () => {
      const lock = new FakeLock([true, true]);
      const { consumer } = build([page([], '')], undefined, lock);
      let ticks = 0;
      const origRun = consumer.runOnce.bind(consumer);
      const acquire = jest.spyOn(lock, 'tryAcquire');
      jest.spyOn(consumer, 'runOnce').mockImplementation(async () => {
        ticks += 1;
        lock.held = false; // the lock connection dropped
        if (ticks >= 2) void consumer.stop();
        return origRun();
      });
      consumer.start();
      await consumer.whenStopped();
      expect(acquire).toHaveBeenCalledTimes(2);
    });

    it('stop does not wait for an open long-poll', async () => {
      const store = new InMemoryHumanRequestFeedStore();
      const never = new Promise<ReadFeedResult>(() => undefined);
      const lock = new FakeLock();
      const consumer = new HumanRequestFeedConsumer(
        {
          store,
          client: {
            readFeed: () => never,
            listOpenRequests: () => Promise.reject(new Error('unused')),
          },
          delivery: {
            accept: () => Promise.resolve(),
            abandon: () => Promise.resolve(),
          },
          lock,
        },
        { sleep: () => Promise.resolve() },
      );
      consumer.start();
      await new Promise((resolve) => setImmediate(resolve));
      await consumer.stop();
      expect(lock.released).toBe(1);
    });

    it('stop during an in-flight lock acquisition never opens a long-poll', async () => {
      let grant!: (held: boolean) => void;
      const lock = new FakeLock();
      jest.spyOn(lock, 'tryAcquire').mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            grant = (held) => {
              lock.held = held;
              resolve(held);
            };
          }),
      );
      const { feed, consumer } = build([], undefined, lock);
      consumer.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stopping = consumer.stop();
      grant(true);
      await stopping;
      expect(feed.calls).toEqual([]);
      expect(lock.released).toBe(1);
    });
  });

  describe('stop mid-page', () => {
    it('finishes only the item in progress and keeps the cursor of the last whole page', async () => {
      let release!: () => void;
      const { store, accepted, consumer } = build(
        [
          page(
            [cancelledItem('a'), cancelledItem('b'), cancelledItem('c')],
            '3',
          ),
        ],
        (item) =>
          item.deliveryId === 'a'
            ? new Promise<void>((resolve) => {
                release = resolve;
              })
            : Promise.resolve(),
      );
      await store.saveCursor('0');
      consumer.start();
      while (release === undefined)
        await new Promise((resolve) => setImmediate(resolve));
      const stopping = consumer.stop();
      release();
      await stopping;
      expect(accepted).toEqual(['a']);
      await expect(store.readCursor()).resolves.toBe('0');
    });
  });

  describe('Promise.race leak', () => {
    it('a handled page is not retained by the stop signal', async () => {
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      let ref: WeakRef<object> | undefined;
      const store = new InMemoryHumanRequestFeedStore();
      const consumer = new HumanRequestFeedConsumer(
        {
          store,
          client: {
            readFeed: () => {
              const result: ReadFeedResult = page([], '1');
              ref = new WeakRef(result);
              return Promise.resolve(result);
            },
            listOpenRequests: () => Promise.reject(new Error('unused')),
          },
          delivery: {
            accept: () => Promise.resolve(),
            abandon: () => Promise.resolve(),
          },
          lock: new FakeLock(),
        },
        { sleep: () => Promise.resolve() },
      );
      await consumer.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
      expect(ref?.deref()).toBeUndefined();
      await consumer.stop();
    });
  });

  describe('poison item', () => {
    const MINUTE = 60_000;
    const buildPoison = (
      items: FeedItem[],
      failing: () => string,
      abandon: (item: FeedItem, reason: string) => Promise<void> = () =>
        Promise.resolve(),
      failureMessage = 'handoff mode unreadable',
    ) => {
      const abandoned: string[] = [];
      const accepted: string[] = [];
      const store = new InMemoryHumanRequestFeedStore();
      const clock = { now: 0 };
      const consumer = new HumanRequestFeedConsumer(
        {
          store,
          client: new ScriptedFeed(
            Array.from({ length: 20 }, () => page(items, '9')),
          ),
          delivery: {
            accept: (item) => {
              if (item.deliveryId === failing())
                return Promise.reject(new Error(failureMessage));
              accepted.push(item.deliveryId);
              return Promise.resolve();
            },
            abandon: async (item, reason) => {
              await abandon(item, reason);
              abandoned.push(item.deliveryId);
            },
          },
          lock: new FakeLock(),
        },
        { sleep: () => Promise.resolve(), clock: () => clock.now },
      );
      return { store, consumer, clock, abandoned, accepted };
    };

    it('5 fast failures within 10 minutes do not abandon the item', async () => {
      const { store, consumer, clock, abandoned } = buildPoison(
        [cancelledItem('bad')],
        () => 'bad',
      );
      for (let i = 0; i < 8; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow('unreadable');
      }
      expect(abandoned).toEqual([]);
      await expect(store.readCursor()).resolves.toBeNull();
    });

    it('failures spanning 10 minutes and 5 attempts abandon the item and the page moves on', async () => {
      const { store, consumer, clock, abandoned, accepted } = buildPoison(
        [cancelledItem('ok1'), cancelledItem('bad'), cancelledItem('ok2')],
        () => 'bad',
      );
      for (let i = 0; i < 4; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow('unreadable');
      }
      clock.now = 10 * MINUTE;
      await expect(consumer.runOnce()).resolves.toEqual({
        kind: 'page',
        items: 3,
      });
      expect(abandoned).toEqual(['bad']);
      expect(accepted.at(-1)).toBe('ok2');
      await expect(store.readCursor()).resolves.toBe('9');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('bad'));
    });

    it('persists the RAW failure reason on abandon while the log line is sanitized', async () => {
      const phone = '5215550001111';
      const reasons: string[] = [];
      const { consumer, clock } = buildPoison(
        [cancelledItem('bad')],
        () => 'bad',
        (_item, reason) => {
          reasons.push(reason);
          return Promise.resolve();
        },
        `recipient ${phone} unreadable`,
      );
      for (let i = 0; i < 4; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow('unreadable');
      }
      clock.now = 10 * MINUTE;
      await consumer.runOnce();
      expect(reasons).toEqual([`Error: recipient ${phone} unreadable`]);
      const logged = (error.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain('abandoned');
      expect(logged).not.toContain(phone);
      expect(logged).toContain('[number]');
    });

    it('10 minutes of failures with fewer than 5 attempts do not abandon', async () => {
      const { consumer, clock, abandoned } = buildPoison(
        [cancelledItem('bad')],
        () => 'bad',
      );
      for (const at of [0, 5, 10, 20]) {
        clock.now = at * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow();
      }
      expect(abandoned).toEqual([]);
    });

    it('a different failing item restarts the count and the first-failure time', async () => {
      let failing = 'x';
      const { consumer, clock, abandoned } = buildPoison(
        [cancelledItem('x'), cancelledItem('y')],
        () => failing,
      );
      for (let i = 0; i < 6; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow();
      }
      failing = 'y';
      for (let i = 6; i < 15; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow();
      }
      expect(abandoned).toEqual([]);
      clock.now = 16 * MINUTE;
      await consumer.runOnce();
      expect(abandoned).toEqual(['y']);
    });

    it('a success resets the count and the first-failure time', async () => {
      let failing = 'x';
      const { consumer, clock, abandoned } = buildPoison(
        [cancelledItem('x')],
        () => failing,
      );
      for (let i = 0; i < 6; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow();
      }
      failing = '';
      clock.now = 7 * MINUTE;
      await consumer.runOnce();
      failing = 'x';
      for (let i = 8; i < 17; i += 1) {
        clock.now = i * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow();
      }
      expect(abandoned).toEqual([]);
    });

    it('a failing abandon keeps the page stuck (the cursor stays)', async () => {
      const { store, consumer, clock } = buildPoison(
        [cancelledItem('p')],
        () => 'p',
        () => Promise.reject(new Error('db down')),
      );
      for (let i = 0; i < 6; i += 1) {
        clock.now = i * 3 * MINUTE;
        await expect(consumer.runOnce()).rejects.toThrow();
      }
      await expect(store.readCursor()).resolves.toBeNull();
    });
  });
});
