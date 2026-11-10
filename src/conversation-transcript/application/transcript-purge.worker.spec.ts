import type { ConversationTranscriptStore } from '../domain/transcript.port';
import { TranscriptPurgeWorker } from './transcript-purge.worker';

const NOW = new Date('2027-11-09T16:00:00.000Z');

function storeWith(counts: Array<number | Error>) {
  const calls: Array<{ now: Date; batchSize: number }> = [];
  const store: ConversationTranscriptStore = {
    append: () => Promise.resolve(true),
    listRecent: () => Promise.resolve([]),
    purgeExpired: (now, batchSize) => {
      calls.push({ now, batchSize });
      const next = counts.shift() ?? 0;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  return { store, calls };
}

describe('TranscriptPurgeWorker', () => {
  afterEach(() => jest.useRealTimers());

  it('deletes full batches of 1000 until one comes back short', async () => {
    const { store, calls } = storeWith([1000, 1000, 3]);
    const worker = new TranscriptPurgeWorker(store, () => NOW);
    await expect(worker.purgeOnce()).resolves.toBe(2003);
    expect(calls).toEqual([
      { now: NOW, batchSize: 1000 },
      { now: NOW, batchSize: 1000 },
      { now: NOW, batchSize: 1000 },
    ]);
  });

  it('caps the batches per tick', async () => {
    const { store, calls } = storeWith(Array<number>(50).fill(1000));
    const worker = new TranscriptPurgeWorker(store, () => NOW, {
      maxBatchesPerTick: 4,
    });
    await expect(worker.purgeOnce()).resolves.toBe(4000);
    expect(calls).toHaveLength(4);
  });

  it('a failing purge only warns and keeps what it deleted', async () => {
    const { store } = storeWith([1000, new Error('db down')]);
    const worker = new TranscriptPurgeWorker(store, () => NOW);
    const warn = jest
      .spyOn(worker['logger'], 'warn')
      .mockImplementation(() => undefined);
    await expect(worker.purgeOnce()).resolves.toBe(1000);
    expect(String(warn.mock.calls[0][0])).toContain('db down');
  });

  it('runs on its interval after boot and stops on destroy', async () => {
    jest.useFakeTimers();
    const { store, calls } = storeWith([]);
    const worker = new TranscriptPurgeWorker(store, () => NOW, {
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

  it('shutdown waits for an in-flight purge instead of cutting it', async () => {
    jest.useFakeTimers();
    let release: (count: number) => void = () => undefined;
    const store: ConversationTranscriptStore = {
      append: () => Promise.resolve(true),
      listRecent: () => Promise.resolve([]),
      purgeExpired: () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    };
    const worker = new TranscriptPurgeWorker(store, () => NOW, {
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
    release(1000); // full batch, but the worker is stopping: no next batch
    await stopping;
    expect(stopped).toBe(true);
  });
});
