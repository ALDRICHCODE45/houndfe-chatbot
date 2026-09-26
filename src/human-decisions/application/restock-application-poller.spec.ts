import { RestockApplicationPoller } from './restock-application-poller';
import type { RestockApplicationCoordinator } from './restock-application-coordinator';

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Result = Awaited<ReturnType<RestockApplicationCoordinator['applyOnce']>>;
const pending: Result = { action: 'pending' };
const ack: Result = { action: 'ack_recorded' };
const advance = (ms = 10) => jest.advanceTimersByTimeAsync(ms);
function fixture(options = {}) {
  const applyOnce = jest.fn<Promise<Result>, [string, string]>();
  applyOnce.mockResolvedValue(pending);
  let now = 100;
  const poller = new RestockApplicationPoller(
    { applyOnce },
    { intervalMs: 10, ...options },
    () => now,
  );
  return { poller, applyOnce, clock: (value: number) => (now = value) };
}

describe('RestockApplicationPoller (unwired)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('is idle until started/admitted, delays calls and automatically pending→ack', async () => {
    const { poller, applyOnce } = fixture();
    expect(poller.enqueue('sender', SOURCE)).toBe(false);
    poller.start();
    poller.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(0);
    await advance(100);
    expect(applyOnce).not.toHaveBeenCalled();
    applyOnce.mockResolvedValueOnce(pending).mockResolvedValueOnce(ack);
    expect(poller.enqueue('sender', SOURCE)).toBe(true);
    expect(poller.enqueue('sender', SOURCE)).toBe(false);
    expect(applyOnce).not.toHaveBeenCalled();
    await advance(9);
    expect(applyOnce).not.toHaveBeenCalled();
    await advance(1);
    await advance();
    expect(applyOnce.mock.calls).toEqual([
      ['sender', SOURCE],
      ['sender', SOURCE],
    ]);
    expect(poller.enqueue('sender', SOURCE)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['hold', 'ack_recorded', 'unexpected', 'throw', 'reject'])(
    'retires %s permanently',
    async (action) => {
      const { poller, applyOnce } = fixture();
      applyOnce.mockImplementation(() => {
        if (action === 'throw') throw new Error('synthetic');
        if (action === 'reject') return Promise.reject(new Error('synthetic'));
        return Promise.resolve({ action } as Result);
      });
      poller.start();
      poller.enqueue('sender', SOURCE);
      await advance(100);
      expect(applyOnce).toHaveBeenCalledTimes(1);
      expect(poller.enqueue('sender', SOURCE)).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('serializes deferred work and rotates pending jobs with positive spacing', async () => {
    const { poller, applyOnce } = fixture();
    let resolve!: (result: Result) => void;
    applyOnce.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    poller.start();
    poller.enqueue('first', SOURCE);
    await advance();
    poller.enqueue('second', OTHER);
    await advance(100);
    expect(applyOnce).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    resolve(pending);
    await advance(0);
    expect(applyOnce).toHaveBeenCalledTimes(1);
    await advance();
    await advance();
    expect(applyOnce.mock.calls).toEqual([
      ['first', SOURCE],
      ['second', OTHER],
      ['first', SOURCE],
    ]);
    await poller.stop();
  });

  it('snapshots poll/capacity bounds and retains exhausted keys', async () => {
    const options = { intervalMs: 10, maxPolls: 2, maxTrackedKeys: 1 };
    const applyOnce = jest.fn().mockResolvedValue(pending);
    const poller = new RestockApplicationPoller({ applyOnce }, options);
    options.maxPolls = 999;
    options.maxTrackedKeys = 999;
    options.intervalMs = 1;
    poller.start();
    expect(poller.enqueue('sender', SOURCE)).toBe(true);
    await advance(9);
    expect(applyOnce).not.toHaveBeenCalled();
    await advance(91);
    expect(applyOnce).toHaveBeenCalledTimes(2);
    expect(poller.enqueue('sender', SOURCE)).toBe(false);
    expect(poller.enqueue('other', OTHER)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([120, 121, 99, NaN, Infinity])(
    'stops at invalid/aged clock %s',
    async (now) => {
      const { poller, applyOnce, clock } = fixture({ maxAgeMs: 20 });
      poller.start();
      poller.enqueue('sender', SOURCE);
      clock(now);
      await advance(100);
      expect(applyOnce).not.toHaveBeenCalled();
      expect(poller.enqueue('sender', SOURCE)).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('detects rollback relative to the previous poll, not just admission', async () => {
    const { poller, applyOnce, clock } = fixture();
    poller.start();
    poller.enqueue('sender', SOURCE);
    clock(110);
    await advance();
    clock(105);
    await advance(100);
    expect(applyOnce).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid identities/clocks without consuming capacity or normalizing', async () => {
    const { poller, applyOnce, clock } = fixture({ maxTrackedKeys: 2 });
    poller.start();
    for (const sender of [
      '',
      ' ',
      ' sender',
      'sender ',
      'x'.repeat(201),
      null,
    ]) {
      expect(poller.enqueue(sender as string, SOURCE)).toBe(false);
    }
    for (const source of ['', 'bad', ` ${SOURCE}`, null]) {
      expect(poller.enqueue('sender', source as string)).toBe(false);
    }
    clock(NaN);
    expect(poller.enqueue('sender', SOURCE)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    clock(100);
    expect(poller.enqueue('sender', SOURCE.toUpperCase())).toBe(true);
    expect(poller.enqueue('sender', SOURCE)).toBe(true);
    applyOnce.mockResolvedValue(ack);
    await advance(20);
    expect(applyOnce.mock.calls).toEqual([
      ['sender', SOURCE.toUpperCase()],
      ['sender', SOURCE],
    ]);
  });

  it.each([false, true])(
    'shutdown latches and cancels waiting work (started=%s)',
    async (started) => {
      const { poller, applyOnce } = fixture();
      if (started) {
        poller.start();
        poller.enqueue('sender', SOURCE);
      }
      await poller.onModuleDestroy();
      poller.start();
      poller.onApplicationBootstrap();
      expect(poller.enqueue('sender', SOURCE)).toBe(false);
      await advance(100);
      expect(applyOnce).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('repeated shutdown awaits the entire in-flight operation and never rearms', async () => {
    const { poller, applyOnce } = fixture();
    let resolve!: (result: Result) => void;
    applyOnce.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    poller.start();
    poller.enqueue('sender', SOURCE);
    poller.enqueue('waiting', OTHER);
    await advance();
    const stop = poller.stop();
    expect(poller.onModuleDestroy()).toBe(stop);
    let settled = false;
    void stop.then(() => (settled = true));
    await advance(100);
    expect(settled).toBe(false);
    expect(poller.enqueue('new', OTHER)).toBe(false);
    resolve(pending);
    await stop;
    poller.start();
    expect(poller.enqueue('new', OTHER)).toBe(false);
    await advance(100);
    expect(applyOnce).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['intervalMs', 'maxPolls', 'maxAgeMs', 'maxTrackedKeys'])(
    'rejects invalid %s before scheduling',
    (key) => {
      for (const value of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '1',
        null,
      ]) {
        expect(() => fixture({ [key]: value })).toThrow();
      }
    },
  );
  it('rejects timer overflow', () => {
    expect(() => fixture({ intervalMs: 2 ** 31 })).toThrow();
  });
});
