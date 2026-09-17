/** WU8B2 lifecycle worker: claims durable eligible receipt-media rows through
 * the WU2B `claimBatch` seam and drives the STORED-1 dispatcher with a per-task
 * abort signal. Nest lifecycle conventions: `onApplicationBootstrap` starts
 * exactly one poll loop (idempotent); `onModuleDestroy` (via
 * `enableShutdownHooks()` in main.ts) marks stopping, wakes the poll wait,
 * aborts active transports, and drains all in-flight work before resolving.
 * Lease safety: the store seam is `claimBatch`-only — the worker never
 * renews, releases, or mutates rows and cannot detect mid-call lease loss.
 * The exact safe contract is WU2B claim/reclaim: an expired lease simply
 * becomes reclaimable by any worker, and the stale caller loses its
 * post-call fenced CAS (`startStorageAttempt`/`transitionStatus`/TX2),
 * receiving safe value outcomes — no heartbeat exists or is faked here.
 *
 * STORED-1: the second constructor argument is the state-aware dispatcher,
 * not the raw processor. The dispatcher routes RESERVED/DOWNLOADED to ingestion,
 * ATTACHING to attachment, and all other statuses to a no-op non-dispatch
 * result. STORED rows are held from automatic claim eligibility and are
 * never dispatched by this worker.
 */
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { ReceiptMediaStorePort } from '../domain/receipt-media-store.port';
import type { ReceiptProcessingDispatcher } from '../application/receipt-processing-dispatcher.service';

/** Wait seams must always resolve (wake/shutdown abort them); never reject. */
export type IngestionWaitPort = (
  ms: number,
  signal: AbortSignal,
) => Promise<void>;

export const waitWithSignal: IngestionWaitPort = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });

export interface IngestionWorkerOptions {
  owner: string;
  pollIntervalMs: number;
  batchSize: number;
  maxConcurrency: number;
}

const bounded = (v: number, lo: number, hi: number): boolean =>
  Number.isInteger(v) && v >= lo && v <= hi;

@Injectable()
export class ReceiptMediaIngestionWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly owner: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxConcurrency: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private stopped: Promise<void> | null = null;
  private wakeRequested = false;
  private waitAbort: AbortController | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly active = new Set<AbortController>();

  constructor(
    private readonly store: Pick<ReceiptMediaStorePort, 'claimBatch'>,
    private readonly dispatcher: Pick<ReceiptProcessingDispatcher, 'dispatch'>,
    options: IngestionWorkerOptions,
    private readonly wait: IngestionWaitPort = waitWithSignal,
  ) {
    const { owner, pollIntervalMs, batchSize, maxConcurrency } = options;
    if (
      owner.length < 1 ||
      owner.length > 100 ||
      !bounded(pollIntervalMs, 50, 3_600_000) ||
      !bounded(batchSize, 1, 20) ||
      !bounded(maxConcurrency, 1, 10)
    )
      throw new Error('receipt-media: invalid worker options');
    this.owner = owner;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.maxConcurrency = maxConcurrency;
  }

  /** Idempotent: exactly one loop per instance; never restarts after stop. */
  onApplicationBootstrap(): void {
    if (this.running || this.stopped !== null) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  /** Coalesced: repeated calls yield at most one immediate re-poll. */
  wake(): void {
    this.wakeRequested = true;
    this.waitAbort?.abort();
    this.waitAbort = null;
  }

  /** Idempotent: stopping is marked before the wake; no claims afterwards. */
  onModuleDestroy(): Promise<void> {
    if (this.stopped !== null) return this.stopped;
    this.running = false;
    this.wake();
    for (const controller of this.active) controller.abort();
    const loop = this.loop;
    this.stopped = Promise.allSettled([...this.inFlight]).then(async () => {
      await loop;
    });
    return this.stopped;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      await this.claimAndDispatch();
      if (!this.running) break;
      if (!this.wakeRequested) await this.waitForPollOrWake();
      this.wakeRequested = false;
    }
  }

  private async waitForPollOrWake(): Promise<void> {
    const abort = new AbortController();
    this.waitAbort = abort;
    try {
      await this.wait(this.pollIntervalMs, abort.signal);
    } finally {
      if (this.waitAbort === abort) this.waitAbort = null;
    }
  }

  private async claimAndDispatch(): Promise<void> {
    const capacity = this.maxConcurrency - this.inFlight.size;
    if (capacity <= 0 || !this.running) return;
    let batch: ReceiptMediaRow[];
    try {
      batch = await this.store.claimBatch(
        Math.min(capacity, this.batchSize),
        this.owner,
      );
    } catch {
      return;
    }
    if (this.running) for (const receipt of batch) this.dispatch(receipt);
  }

  private dispatch(receipt: ReceiptMediaRow): void {
    const controller = new AbortController();
    this.active.add(controller);
    const settled = Promise.resolve()
      .then(() =>
        this.dispatcher.dispatch(receipt, this.owner, controller.signal),
      )
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.active.delete(controller);
        this.inFlight.delete(settled);
        if (this.running) this.wake();
      });
    this.inFlight.add(settled);
  }
}
