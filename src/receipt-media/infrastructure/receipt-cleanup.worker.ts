/** ODD-3B cleanup lifecycle worker: a sequential poll loop around the
 * existing `ReceiptCleanupService.runBatch` (ODD-2D2b). Unlike the ingestion
 * worker there is no dispatcher and no max-concurrency pool: exactly one
 * bounded cleanup batch is active at a time, and the configured worker
 * concurrency is used as the cleanup batch size. A non-empty claimed batch
 * re-drains immediately with no poll wait so the durable cleanup backlog is
 * drained without idle polling; an empty batch reaches the shared signal
 * wait and polls. Claim and disposition store failures are contained and the
 * loop continues later rather than terminating.
 *
 * Nest lifecycle conventions mirror the ingestion/notification workers:
 * `onApplicationBootstrap` starts exactly one loop (idempotent, never after
 * stop); `onModuleDestroy` marks stopping, wakes the poll wait, aborts the
 * active batch signal, and drains the COMPLETE active batch (external delete
 * plus its disposition) and the loop before resolving, so no cleanup
 * transaction can run after the pool closes. Lease safety is unchanged: the
 * store's cleanup claim owns the lease and the service never renews,
 * releases, or mutates rows outside the exact disposition fence. */
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { ReceiptCleanupService } from '../application/receipt-cleanup.service';
import {
  waitWithSignal,
  type IngestionWaitPort,
} from './receipt-media-ingestion.worker';

export interface CleanupWorkerOptions {
  owner: string;
  pollIntervalMs: number;
  batchSize: number;
}

const bounded = (v: number, lo: number, hi: number): boolean =>
  Number.isInteger(v) && v >= lo && v <= hi;

@Injectable()
export class ReceiptCleanupWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly owner: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private stopped: Promise<void> | null = null;
  private wakeRequested = false;
  private waitAbort: AbortController | null = null;
  private active: AbortController | null = null;
  private batch: Promise<number> | null = null;

  constructor(
    private readonly cleanup: Pick<ReceiptCleanupService, 'runBatch'>,
    options: CleanupWorkerOptions,
    /** Shared wait seam (the ingestion worker's `waitWithSignal` by
     * default): always resolves, never rejects; wake/shutdown abort it. */
    private readonly wait: IngestionWaitPort = waitWithSignal,
  ) {
    const { owner, pollIntervalMs, batchSize } = options;
    if (
      owner.length < 1 ||
      owner.length > 100 ||
      !bounded(pollIntervalMs, 50, 3_600_000) ||
      !bounded(batchSize, 1, 20)
    )
      throw new Error('receipt-media: invalid cleanup worker options');
    this.owner = owner;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
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

  /** Idempotent: stopping is marked before the wake/abort; no claims
   * afterwards. Awaits the complete active batch and the loop. */
  onModuleDestroy(): Promise<void> {
    if (this.stopped !== null) return this.stopped;
    this.running = false;
    this.wake();
    this.active?.abort();
    const loop = this.loop;
    const batch = this.batch;
    this.stopped = Promise.allSettled([batch, loop]).then(() => undefined);
    return this.stopped;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const claimed = await this.runBatchOnce();
      if (!this.running) break;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        continue;
      }
      // Non-empty batch: drain the backlog immediately without a poll wait.
      if (claimed > 0) continue;
      await this.waitForPollOrWake();
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

  /** Claims/dispositions one bounded batch sequentially and returns its
   * claimed count; a claim or disposition failure is contained as 0 so the
   * loop continues later instead of terminating. */
  private runBatchOnce(): Promise<number> {
    if (!this.running) return Promise.resolve(0);
    const controller = new AbortController();
    this.active = controller;
    const completion = Promise.resolve()
      .then(() =>
        this.cleanup.runBatch(this.batchSize, this.owner, controller.signal),
      )
      .then(
        (report) => report.claimed,
        () => 0,
      )
      .then((claimed) => {
        if (this.active === controller) this.active = null;
        this.batch = null;
        return claimed;
      });
    this.batch = completion;
    return completion;
  }
}
