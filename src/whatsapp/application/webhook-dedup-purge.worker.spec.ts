import {
  WEBHOOK_DEDUP_RETENTION_MS,
  type WebhookDedupStore,
} from '../domain/webhook-dedup.store';
import { WebhookDedupPurgeWorker } from './webhook-dedup-purge.worker';

const NOW = new Date('2026-11-17T16:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - WEBHOOK_DEDUP_RETENTION_MS);

function storeWith(counts: Array<number | Error>) {
  const calls: Array<{ cutoff: Date; limit: number }> = [];
  const store: WebhookDedupStore = {
    claim: () => Promise.resolve('claim-token'),
    markSeen: () => Promise.resolve(),
    release: () => Promise.resolve(),
    purgeBefore: (cutoff, limit) => {
      calls.push({ cutoff, limit });
      const next = counts.shift() ?? 0;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  return { store, calls };
}

describe('WebhookDedupPurgeWorker', () => {
  afterEach(() => jest.useRealTimers());

  it('purges rows older than 8 days in batches of 1000 until one is short', async () => {
    const { store, calls } = storeWith([1000, 1000, 3]);
    const worker = new WebhookDedupPurgeWorker(store, () => NOW);
    await expect(worker.purgeOnce()).resolves.toBe(2003);
    expect(calls).toEqual([
      { cutoff: CUTOFF, limit: 1000 },
      { cutoff: CUTOFF, limit: 1000 },
      { cutoff: CUTOFF, limit: 1000 },
    ]);
    expect(CUTOFF.toISOString()).toBe('2026-11-09T16:00:00.000Z');
  });

  it('caps the batches per tick', async () => {
    const { store, calls } = storeWith(Array<number>(50).fill(1000));
    const worker = new WebhookDedupPurgeWorker(store, () => NOW, {
      maxBatchesPerTick: 4,
    });
    await expect(worker.purgeOnce()).resolves.toBe(4000);
    expect(calls).toHaveLength(4);
  });

  it('a failing purge only warns and keeps what it deleted', async () => {
    const { store } = storeWith([1000, new Error('db down')]);
    const worker = new WebhookDedupPurgeWorker(store, () => NOW);
    const warn = jest
      .spyOn(worker['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(worker.purgeOnce()).resolves.toBe(1000);
    expect(String(warn.mock.calls[0][0])).toContain('db down');
  });

  it('runs on its interval after boot and stops on destroy', async () => {
    jest.useFakeTimers();
    const { store, calls } = storeWith([]);
    const worker = new WebhookDedupPurgeWorker(store, () => NOW, {
      initialDelayMs: 1_000,
      intervalMs: 10_000,
    });
    worker.onApplicationBootstrap();
    worker.onApplicationBootstrap(); // idempotent
    await jest.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
    await worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    worker.onApplicationBootstrap(); // never restarts after stop
    await jest.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
  });

  it('shutdown waits for an in-flight purge so the pool closes after it', async () => {
    jest.useFakeTimers();
    let finish: (count: number) => void = () => undefined;
    const { store } = storeWith([]);
    store.purgeBefore = () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      });
    const worker = new WebhookDedupPurgeWorker(store, () => NOW, {
      initialDelayMs: 0,
      intervalMs: 10_000,
    });
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = worker.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(1000); // full batch, but the worker is stopping: no next batch
    await stopping;
    expect(stopped).toBe(true);
  });
});
