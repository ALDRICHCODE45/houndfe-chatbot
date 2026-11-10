import type { ConversationGateStore } from '../domain/conversation-gate.store';
import { ConversationGatePurgeWorker } from './conversation-gate-purge.worker';

function storeWith(counts: Array<number | Error>) {
  const calls: number[] = [];
  const store = {
    purgeExpired: (batchSize: number) => {
      calls.push(batchSize);
      const next = counts.shift() ?? 0;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  } as unknown as ConversationGateStore;
  return { store, calls };
}

describe('ConversationGatePurgeWorker (S4)', () => {
  afterEach(() => jest.useRealTimers());

  it('deletes full batches until one comes back short', async () => {
    const { store, calls } = storeWith([500, 500, 7]);
    const worker = new ConversationGatePurgeWorker(store);
    await expect(worker.purgeOnce()).resolves.toBe(1007);
    expect(calls).toEqual([500, 500, 500]);
  });

  it('caps the batches per tick', async () => {
    const { store, calls } = storeWith(Array<number>(50).fill(500));
    const worker = new ConversationGatePurgeWorker(store, {
      maxBatchesPerTick: 3,
    });
    await expect(worker.purgeOnce()).resolves.toBe(1500);
    expect(calls).toHaveLength(3);
  });

  it('a failing purge only warns and keeps what it deleted', async () => {
    const { store } = storeWith([500, new Error('db down')]);
    const worker = new ConversationGatePurgeWorker(store);
    const warn = jest
      .spyOn(worker['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(worker.purgeOnce()).resolves.toBe(500);
    expect(String(warn.mock.calls[0][0])).toContain('db down');
  });

  it('runs on its interval after boot and stops for good on destroy', async () => {
    jest.useFakeTimers();
    const { store, calls } = storeWith([]);
    const worker = new ConversationGatePurgeWorker(store, {
      initialDelayMs: 1_000,
      intervalMs: 10_000,
    });
    worker.onApplicationBootstrap();
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    await worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
  });

  it('shutdown waits for an in-flight purge', async () => {
    jest.useFakeTimers();
    let release: (count: number) => void = () => undefined;
    const store = {
      purgeExpired: () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    } as unknown as ConversationGateStore;
    const worker = new ConversationGatePurgeWorker(store, {
      initialDelayMs: 0,
    });
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(0);
    await stopping;
    expect(stopped).toBe(true);
  });
});
