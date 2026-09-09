/** WU8B2 worker core: idempotent bootstrap loop, coalesced wakes,
 * capacity-bounded claiming, and idempotent draining shutdown. Lease
 * safety: the store seam is claimBatch-only — reclaim happens through
 * WU2B claim/reclaim and the processor's fenced CAS; this worker never
 * renews leases and cannot detect mid-call loss (documented, not faked). */
import type { ReceiptIngestionOutcome } from '../application/receipt-ingestion.processor';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import {
  ReceiptMediaIngestionWorker,
  waitWithSignal,
} from './receipt-media-ingestion.worker';

const flush = () => new Promise<void>((r) => setImmediate(r));
const row = (id: string): ReceiptMediaRow => ({ id }) as ReceiptMediaRow;

const downloaded: ReceiptIngestionOutcome = { kind: 'downloaded' };

const settleOnAbort = (
  signal?: AbortSignal,
): Promise<ReceiptIngestionOutcome> =>
  new Promise((resolve) => {
    if (signal === undefined || signal.aborted) return resolve(downloaded);
    signal.addEventListener('abort', () => resolve(downloaded), {
      once: true,
    });
  });

type Opts = ConstructorParameters<typeof ReceiptMediaIngestionWorker>[2];

const live = new Set<ReceiptMediaIngestionWorker>();

const harness = (over: Partial<Opts> = {}) => {
  const process = jest.fn<
    Promise<ReceiptIngestionOutcome>,
    [ReceiptMediaRow, string, AbortSignal?]
  >((_r, _o, signal) => settleOnAbort(signal));
  const claimBatch = jest.fn<Promise<ReceiptMediaRow[]>, [number, string]>(() =>
    Promise.resolve([]),
  );
  const worker = new ReceiptMediaIngestionWorker(
    { claimBatch },
    { process },
    {
      owner: 'worker-a',
      pollIntervalMs: 1_000,
      batchSize: 5,
      maxConcurrency: 2,
      ...over,
    },
    waitWithSignal,
  );
  live.add(worker);
  return { worker, process, claimBatch };
};

afterEach(async () => {
  for (const worker of live) await worker.onModuleDestroy();
  live.clear();
});

describe('ReceiptMediaIngestionWorker core (WU8B2)', () => {
  it('rejects unsafe options synchronously', () => {
    for (const bad of [
      { owner: '' },
      { pollIntervalMs: 49 },
      { batchSize: 0 },
      { batchSize: 21 },
      { maxConcurrency: 0 },
      { maxConcurrency: 11 },
    ])
      expect(() => harness(bad)).toThrow('invalid worker options');
  });

  it('bootstraps exactly one loop and coalesces wakes into one claim turn', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.claimBatch).toHaveBeenCalledTimes(1);
    expect(h.claimBatch).toHaveBeenCalledWith(2, 'worker-a');
    h.worker.wake();
    h.worker.wake();
    h.worker.wake();
    await flush();
    await flush();
    expect(h.claimBatch).toHaveBeenCalledTimes(2);
    await h.worker.onModuleDestroy();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.claimBatch).toHaveBeenCalledTimes(2);
  });

  it('shutdown aborts active tasks, drains, and is idempotent', async () => {
    const h = harness();
    const signals: AbortSignal[] = [];
    h.process.mockImplementation((_r, _o, signal) => {
      signals.push(signal as AbortSignal);
      return settleOnAbort(signal);
    });
    h.claimBatch.mockResolvedValueOnce([row('r1')]);
    h.worker.onApplicationBootstrap();
    await flush();
    const stop = h.worker.onModuleDestroy();
    expect(signals[0]?.aborted).toBe(true);
    await Promise.all([stop, h.worker.onModuleDestroy()]);
    expect(h.claimBatch).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.claimBatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches no processor work when a claim resolves after shutdown', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.claimBatch.mockImplementation(() => gate.then(() => [row('r1')]));
    h.worker.onApplicationBootstrap();
    await flush();
    const stop = h.worker.onModuleDestroy();
    release();
    await stop;
    expect(h.process).not.toHaveBeenCalled();
  });

  // WU8B3 triangulation (additive; production behavior already in place).
  it('never exceeds maxConcurrency and fills only freed slots', async () => {
    const h = harness({ batchSize: 5, maxConcurrency: 2 });
    const gates: Array<() => void> = [];
    let concurrent = 0;
    let peak = 0;
    h.process.mockImplementation(
      (_r, _o, signal) =>
        new Promise<ReceiptIngestionOutcome>((resolve) => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          const done = () => {
            concurrent -= 1;
            resolve(downloaded);
          };
          gates.push(done);
          signal?.addEventListener('abort', done, { once: true });
        }),
    );
    h.claimBatch
      .mockResolvedValueOnce([row('r1'), row('r2')])
      .mockResolvedValueOnce([row('r3')]);
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.process).toHaveBeenCalledTimes(2);
    expect(h.claimBatch).toHaveBeenCalledTimes(1);
    gates[0]();
    await flush();
    await flush();
    expect(h.process).toHaveBeenCalledTimes(3);
    expect(h.claimBatch).toHaveBeenLastCalledWith(1, 'worker-a');
    gates[1]();
    gates[2]();
    await flush();
    expect(peak).toBe(2);
  });

  it('observes rejections, frees the slot, and continues via later claims', async () => {
    const h = harness();
    h.process.mockRejectedValueOnce(new Error('boom'));
    h.claimBatch
      .mockResolvedValueOnce([row('r1')])
      .mockResolvedValueOnce([row('r2')]);
    h.worker.onApplicationBootstrap();
    await flush();
    await flush();
    expect(h.claimBatch).toHaveBeenCalledTimes(2);
    expect(h.process).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'r2' }),
      'worker-a',
      expect.any(AbortSignal),
    );
  });

  it('gives competing owners disjoint claims; restart trusts only the store', async () => {
    const queue = [row('r1'), row('r2'), row('r3'), row('r4')];
    // SKIP LOCKED simulated at the seam; real arbitration is WU2B authority.
    const claim = jest.fn<Promise<ReceiptMediaRow[]>, [number, string]>(
      (limit) => Promise.resolve(queue.splice(0, limit)),
    );
    const spawned: Array<{
      worker: ReceiptMediaIngestionWorker;
      process: jest.Mock<
        Promise<ReceiptIngestionOutcome>,
        [ReceiptMediaRow, string, AbortSignal?]
      >;
    }> = [];
    const spawn = (owner: string) => {
      const process = jest.fn<
        Promise<ReceiptIngestionOutcome>,
        [ReceiptMediaRow, string, AbortSignal?]
      >((_r, _o, signal) => settleOnAbort(signal));
      const worker = new ReceiptMediaIngestionWorker(
        { claimBatch: claim },
        { process },
        { owner, pollIntervalMs: 1_000, batchSize: 2, maxConcurrency: 2 },
        waitWithSignal,
      );
      worker.onApplicationBootstrap();
      live.add(worker);
      spawned.push({ worker, process });
      return process;
    };
    const a = spawn('worker-a');
    await flush();
    const b = spawn('worker-b');
    await flush();
    const ids = (p: typeof a) => p.mock.calls.map(([r]) => r.id);
    expect([...ids(a), ...ids(b)].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    await spawned[0].worker.onModuleDestroy();
    queue.push(row('r5'));
    const c = spawn('worker-c');
    await flush();
    expect(ids(c)).toEqual(['r5']);
    expect(claim.mock.calls.map(([, owner]) => owner)).toEqual([
      'worker-a',
      'worker-b',
      'worker-c',
    ]);
    for (const { worker } of spawned) await worker.onModuleDestroy();
  });

  it('drains in-flight work on stop and never re-arms the poll wait', async () => {
    const h = harness({ pollIntervalMs: 60 });
    h.claimBatch.mockResolvedValueOnce([row('r1')]);
    h.worker.onApplicationBootstrap();
    await flush();
    await h.worker.onModuleDestroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.claimBatch).toHaveBeenCalledTimes(1);
    expect(h.process).toHaveBeenCalledTimes(1);
  });
});
