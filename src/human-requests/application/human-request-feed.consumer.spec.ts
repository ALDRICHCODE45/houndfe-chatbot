import { Logger } from '@nestjs/common';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type {
  FeedItem,
  ReadFeedOptions,
  ReadFeedResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { FeedConsumerLock } from '../domain/human-request-feed';
import { cancelledItem } from '../infrastructure/human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestFeedConsumer } from './human-request-feed.consumer';

class ScriptedFeed {
  readonly calls: ReadFeedOptions[] = [];
  constructor(private readonly script: Array<ReadFeedResult | Error>) {}
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

  it('CURSOR_EXPIRED restarts from the oldest item with a warning', async () => {
    const { store, consumer } = build([{ kind: 'CURSOR_EXPIRED' }]);
    await store.saveCursor('000000000009');
    await expect(consumer.runOnce()).resolves.toEqual({ kind: 'restarted' });
    await expect(store.readCursor()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('CURSOR_EXPIRED'),
    );
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
          client: { readFeed: () => never },
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
      abandon: (item: FeedItem) => Promise<void> = () => Promise.resolve(),
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
                return Promise.reject(new Error('handoff mode unreadable'));
              accepted.push(item.deliveryId);
              return Promise.resolve();
            },
            abandon: async (item) => {
              await abandon(item);
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
