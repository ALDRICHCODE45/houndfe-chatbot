/** ODD-3B cleanup worker core: a sequential, single-active-batch poll loop
 * around the existing `ReceiptCleanupService.runBatch`. It claims one bounded
 * batch at a time, re-drains immediately while the batch was non-empty,
 * waits/polls on an empty batch, contains claim/store failures instead of
 * terminating, and on shutdown idempotently stops, wakes the poll wait,
 * aborts the active batch signal, and drains the complete delete-plus-
 * disposition batch before resolving. No dispatcher, no max-concurrency
 * pool, and no second lease knob exist here. */
import {
  ReceiptCleanupWorker,
  type CleanupWorkerOptions,
} from './receipt-cleanup.worker';
import type { CleanupBatchReport } from '../application/receipt-cleanup.service';

/** Minimal bounded report with a concrete claimed count. */
const report = (claimed: number): CleanupBatchReport => ({
  claimed,
  cleaned: claimed,
  retryScheduled: 0,
  manualHold: 0,
  fenced: 0,
});

type WaitCall = { ms: number; signal: AbortSignal; release: () => void };

/** Deferred wait seam: records each poll wait and resolves it only when the
 * test releases it or the worker aborts it (wake/shutdown). */
const gatedWait = (): {
  wait: jest.Mock<Promise<void>, [number, AbortSignal]>;
  calls: WaitCall[];
} => {
  const calls: WaitCall[] = [];
  const wait = jest.fn<Promise<void>, [number, AbortSignal]>(
    (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = (): void => resolve();
        calls.push({ ms, signal, release: done });
        signal.addEventListener('abort', done, { once: true });
      }),
  );
  return { wait, calls };
};

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

const live = new Set<ReceiptCleanupWorker>();

const harness = (over: Partial<CleanupWorkerOptions> = {}) => {
  const cleanup = {
    runBatch: jest.fn<
      Promise<CleanupBatchReport>,
      [number, string, AbortSignal?]
    >(() => Promise.resolve(report(0))),
  };
  const { wait, calls } = gatedWait();
  const worker = new ReceiptCleanupWorker(
    cleanup,
    {
      owner: 'cleanup-owner',
      pollIntervalMs: 1_000,
      batchSize: 4,
      ...over,
    },
    wait,
  );
  live.add(worker);
  return { worker, cleanup, wait, calls };
};

afterEach(async () => {
  for (const worker of live) await worker.onModuleDestroy();
  live.clear();
});

describe('ReceiptCleanupWorker core (ODD-3B)', () => {
  it('rejects unsafe options synchronously', () => {
    for (const bad of [
      { owner: '' },
      { pollIntervalMs: 49 },
      { batchSize: 0 },
      { batchSize: 21 },
    ])
      expect(() => harness(bad)).toThrow('invalid cleanup worker options');
    expect(() => harness({ owner: 'o'.repeat(101) })).toThrow(
      'invalid cleanup worker options',
    );
  });

  it('bootstraps exactly one loop and ignores repeated bootstrap', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
  });

  it('claims one bounded batch with the exact batch size, owner, and signal', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
    expect(h.cleanup.runBatch).toHaveBeenCalledWith(
      4,
      'cleanup-owner',
      expect.any(AbortSignal),
    );
  });

  it('re-drains immediately while a claimed batch was non-empty and waits only on empty', async () => {
    const h = harness();
    h.cleanup.runBatch
      .mockResolvedValueOnce(report(2))
      .mockResolvedValueOnce(report(1))
      .mockResolvedValue(report(0));
    h.worker.onApplicationBootstrap();
    await flush();
    // Two non-empty batches drain back-to-back with NO poll wait between
    // them; only the third (empty) batch reaches the wait seam.
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(3);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.ms).toBe(1_000);
  });

  it('polls again only after the wait resolves', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.release();
    await flush();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(2);
  });

  it('wakes a sleeping poll on demand', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
    h.worker.wake();
    await flush();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(2);
  });

  it('contains a claim or store failure and keeps polling instead of terminating', async () => {
    const h = harness();
    h.cleanup.runBatch
      .mockRejectedValueOnce(new Error('claim unavailable'))
      .mockResolvedValueOnce(report(0))
      .mockResolvedValue(report(0));
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
    // The rejection is contained: the loop waits rather than exits.
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.release();
    await flush();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(2);
  });

  it('stops idempotently, aborts the active batch signal, and drains it completely', async () => {
    const h = harness();
    let releaseBatch!: () => void;
    const gate = new Promise<void>((r) => (releaseBatch = r));
    const signals: AbortSignal[] = [];
    h.cleanup.runBatch.mockImplementation(
      async (_limit, _owner, signal): Promise<CleanupBatchReport> => {
        if (signal) signals.push(signal);
        await gate;
        return report(1);
      },
    );
    h.worker.onApplicationBootstrap();
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    const stop = h.worker.onModuleDestroy();
    // Stop marks the run stopped, wakes the wait, and aborts the active
    // batch before awaiting it.
    expect(signals[0]?.aborted).toBe(true);
    let settled = false;
    void stop.then(() => {
      settled = true;
    });
    await flush();
    // Still draining: the batch (delete plus disposition) is not complete.
    expect(settled).toBe(false);
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
    releaseBatch();
    await stop;
    await flush();
    // Idempotent: a repeated stop resolves to the same drain and never
    // claims again.
    await h.worker.onModuleDestroy();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
  });

  it('never rearms after stop, including a bootstrap after shutdown', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
    await h.worker.onModuleDestroy();
    h.worker.onApplicationBootstrap();
    await flush();
    await flush();
    expect(h.cleanup.runBatch).toHaveBeenCalledTimes(1);
  });

  it('latches destruction before bootstrap so a later bootstrap cannot start a worker', async () => {
    const h = harness();
    await h.worker.onModuleDestroy();
    // Safe repeated destroy before any bootstrap.
    await h.worker.onModuleDestroy();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.cleanup.runBatch).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });
});
