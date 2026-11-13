import { Logger } from '@nestjs/common';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';
import {
  RETRY_AFTER_MAX_MS,
  backoffDelayMs,
  isBatchDelivery,
  type BackendOutboxBatchDeliveryPort,
  type BackendOutboxCompletion,
  type BackendOutboxDeliveryPort,
  type BackendOutboxDeliveryResult,
  type BackendOutboxStore,
  type ClaimedBackendOutboxEntry,
} from '../domain/backend-outbox';
import { describeError, sanitizeErrorText } from '../../common/log-safe';

export interface BackendOutboxDrainOptions {
  /** Stable per-process lease owner. */
  owner: string;
  /** Conversation heads claimed (and delivered concurrently) per tick. */
  batchSize?: number;
  leaseMs?: number;
  /**
   * Upper bound for one delivery call; must stay below `leaseMs` so a hung
   * call is rescheduled before its lease can be reclaimed. Default: 3/4 of
   * the lease (45 s for the default 60 s).
   */
  deliveryTimeoutMs?: number;
  /** Delay before the next tick when the last one claimed less than a batch. */
  idleDelayMs?: number;
  purgeIntervalMs?: number;
  /** DONE rows older than this are purged. */
  retentionMs?: number;
  purgeBatchSize?: number;
  /** Batches per purge run (bounds one tick's purge work). */
  maxPurgeBatches?: number;
  random?: () => number;
  clock?: () => number;
}

const DAY_MS = 24 * 3_600_000;

/**
 * Drains `backend_outbox` (S2): each tick claims up to `batchSize`
 * lane heads under a lease and delivers them concurrently (they belong to
 * different (conversation, lane) pairs, so order is preserved). DELIVERED →
 * DONE; RETRY or a thrown error → PENDING again with capped exponential
 * backoff and jitter (or the backend's Retry-After), retried forever;
 * PERMANENT → DEAD with an error log, which unblocks the next seq. DONE rows
 * older than the retention are purged in bounded batches.
 *
 * Batches (backend unit 9): when the delivery port offers `deliverBatch` and
 * `batchLimit(kind) > 1` for a claimed head, the contiguous same-kind run
 * behind it (one conversation lane, leased together) is delivered in ONE
 * call and each row ends DONE / DEAD / RETRY atomically. Other kinds and
 * plain ports keep the single-row path.
 */
export class BackendOutboxDrainWorker {
  private readonly logger = new Logger(BackendOutboxDrainWorker.name);
  private readonly batchSize: number;
  private readonly leaseMs: number;
  readonly deliveryTimeoutMs: number;
  private readonly idleDelayMs: number;
  private readonly purgeIntervalMs: number;
  private readonly retentionMs: number;
  private readonly purgeBatchSize: number;
  private readonly maxPurgeBatches: number;
  private readonly random: () => number;
  private readonly clock: () => number;
  private lastPurgeAt: number | undefined;
  private started = false;
  private stopped = false;
  /** A batch filled its limit in the last tick: more rows likely wait. */
  private fullBatch = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** Delay the pending timer was armed with (undefined: none pending). */
  private timerDelayMs?: number;
  private inFlight?: Promise<void>;
  /** `wake()` arrived while a tick was running: go again right after it. */
  private wakePending = false;

  constructor(
    private readonly store: BackendOutboxStore,
    private readonly delivery: BackendOutboxDeliveryPort,
    private readonly options: BackendOutboxDrainOptions,
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.deliveryTimeoutMs =
      options.deliveryTimeoutMs ?? Math.floor((this.leaseMs * 3) / 4);
    this.idleDelayMs = options.idleDelayMs ?? 1_000;
    this.purgeIntervalMs = options.purgeIntervalMs ?? 3_600_000;
    this.retentionMs = options.retentionMs ?? 7 * DAY_MS;
    this.purgeBatchSize = options.purgeBatchSize ?? 500;
    this.maxPurgeBatches = options.maxPurgeBatches ?? 20;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? (() => Date.now());
    if (!options.owner || options.owner.length > 100)
      throw new RangeError('backend outbox: invalid lease owner');
    for (const value of [
      this.batchSize,
      this.leaseMs,
      this.deliveryTimeoutMs,
      this.idleDelayMs,
      this.purgeIntervalMs,
      this.retentionMs,
      this.purgeBatchSize,
      this.maxPurgeBatches,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('backend outbox: bounds must be positive');
    if (this.deliveryTimeoutMs >= this.leaseMs)
      throw new RangeError(
        'backend outbox: delivery timeout must be below the lease',
      );
  }

  /** The first tick runs immediately; never restarts after `stop`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  /** Stops scheduling and waits for the in-flight tick. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDelayMs = undefined;
    this.wakePending = false;
    return this.inFlight ?? Promise.resolve();
  }

  /**
   * Drains as soon as possible instead of waiting for the next tick (a bot
   * live notice was just mirrored into the outbox and must reach the backend
   * before any later staff message). While a tick runs it marks "run again
   * right after it"; otherwise the pending timer is brought forward to 0 ms.
   * Bursts coalesce into at most one extra tick; a no-op before `start` and
   * after `stop`; never throws. Backoff (row `next_attempt_at`) and the
   * full-batch loop are untouched.
   */
  wake(): void {
    try {
      if (!this.started || this.stopped) return;
      if (this.inFlight !== undefined) {
        this.wakePending = true;
        return;
      }
      if (this.timer === undefined || this.timerDelayMs === 0) return;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.schedule(0);
    } catch {
      // A wake is only an optimisation: the regular tick still runs.
    }
  }

  /** One drain pass; resolves to the number of claimed rows. */
  async tick(): Promise<number> {
    await this.purgeIfDue();
    let claimed: ClaimedBackendOutboxEntry[];
    try {
      claimed = await this.store.claimHeads(
        this.batchSize,
        this.options.owner,
        this.leaseMs,
      );
    } catch (error) {
      this.logger.warn(`backend outbox claim failed: ${describeError(error)}`);
      return 0;
    }
    this.fullBatch = false;
    await Promise.all(claimed.map((entry) => this.processHead(entry)));
    return claimed.length;
  }

  private async processHead(head: ClaimedBackendOutboxEntry): Promise<void> {
    const limit = isBatchDelivery(this.delivery)
      ? this.delivery.batchLimit(head.kind)
      : 1;
    if (!isBatchDelivery(this.delivery) || limit <= 1)
      return this.process(head);
    let run: ClaimedBackendOutboxEntry[];
    try {
      run = await this.store.claimRun(
        head,
        this.options.owner,
        this.leaseMs,
        limit,
      );
    } catch (error) {
      // Deliver the head alone rather than leave it leased until expiry.
      this.logger.warn(
        `backend outbox run claim failed: ${describeError(error)}`,
      );
      return this.process(head);
    }
    if (run.length === 0) {
      this.logger.warn(
        `backend outbox lease lost for ${head.kind} ${maskConversationRef(head.conversationRef)}#${head.seq}`,
      );
      return;
    }
    if (run.length >= limit) this.fullBatch = true;
    await this.processBatch(this.delivery, run);
  }

  private async processBatch(
    delivery: BackendOutboxBatchDeliveryPort,
    run: ClaimedBackendOutboxEntry[],
  ): Promise<void> {
    let results: BackendOutboxDeliveryResult[];
    try {
      results = await this.deliverBatchWithTimeout(delivery, run);
      if (!Array.isArray(results) || results.length !== run.length)
        throw new Error('backend outbox batch result does not match the rows');
    } catch (error) {
      const failure: BackendOutboxDeliveryResult = {
        outcome: 'RETRY',
        error: describe(error),
      };
      results = run.map(() => failure);
    }
    const items = run.map((entry, index) =>
      this.completionFor(entry, results[index]),
    );
    try {
      const applied = await this.store.completeMany(items);
      applied.forEach((ok, index) => {
        if (!ok)
          // Lease lost (expired and reclaimed): the new owner redelivers.
          this.logger.warn(
            `backend outbox lease lost for ${run[index].kind} ${maskConversationRef(run[index].conversationRef)}#${run[index].seq}`,
          );
      });
    } catch (error) {
      // The leases expire and the rows are reclaimed; delivery is idempotent.
      this.logger.warn(
        `backend outbox completion failed: ${describeError(error)}`,
      );
    }
  }

  /** The signal fires at 80% of the budget so the adapter can return the
   *  unfinished rows as RETRY before the hard timeout discards its result. */
  private async deliverBatchWithTimeout(
    delivery: BackendOutboxBatchDeliveryPort,
    run: ClaimedBackendOutboxEntry[],
  ): Promise<BackendOutboxDeliveryResult[]> {
    const controller = new AbortController();
    const softTimer = setTimeout(
      () => controller.abort(),
      Math.floor(this.deliveryTimeoutMs * 0.8),
    );
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => {
        controller.abort();
        reject(
          new DeliveryTimeoutError(
            `backend outbox delivery timed out after ${this.deliveryTimeoutMs} ms`,
          ),
        );
      }, this.deliveryTimeoutMs);
    });
    try {
      return await Promise.race([
        delivery.deliverBatch(run, { signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    }
  }

  private completionFor(
    entry: ClaimedBackendOutboxEntry,
    result: BackendOutboxDeliveryResult,
  ): BackendOutboxCompletion {
    switch (result.outcome) {
      case 'DELIVERED':
        return { entry, outcome: 'DONE' };
      case 'PERMANENT':
        this.logger.error(
          `backend outbox row DEAD: ${entry.kind} ${maskConversationRef(entry.conversationRef)}#${entry.seq} (id ${entry.id}): ${sanitizeErrorText(result.error)}`,
        );
        return { entry, outcome: 'DEAD', error: result.error };
      case 'RETRY':
        return {
          entry,
          outcome: 'RETRY',
          delayMs: this.retryDelayMs(entry, result),
          error: result.error,
        };
    }
  }

  private retryDelayMs(
    entry: ClaimedBackendOutboxEntry,
    result: Extract<BackendOutboxDeliveryResult, { outcome: 'RETRY' }>,
  ): number {
    return result.retryAfterMs !== undefined
      ? Math.min(Math.max(result.retryAfterMs, 0), RETRY_AFTER_MAX_MS)
      : backoffDelayMs(entry.attempts + 1, this.random);
  }

  private async process(entry: ClaimedBackendOutboxEntry): Promise<void> {
    let result: BackendOutboxDeliveryResult;
    try {
      result = await this.deliverWithTimeout(entry);
    } catch (error) {
      result = { outcome: 'RETRY', error: describe(error) };
    }
    try {
      const applied = await this.apply(entry, result);
      if (!applied)
        // Lease lost (expired and reclaimed): the new owner redelivers.
        this.logger.warn(
          `backend outbox lease lost for ${entry.kind} ${maskConversationRef(entry.conversationRef)}#${entry.seq}`,
        );
    } catch (error) {
      // The lease expires and the row is reclaimed; delivery is idempotent.
      this.logger.warn(
        `backend outbox completion failed: ${describeError(error)}`,
      );
    }
  }

  /** A timeout rejects (→ RETRY); the late result of the call is ignored. */
  private async deliverWithTimeout(
    entry: ClaimedBackendOutboxEntry,
  ): Promise<BackendOutboxDeliveryResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new DeliveryTimeoutError(
              `backend outbox delivery timed out after ${this.deliveryTimeoutMs} ms`,
            ),
          ),
        this.deliveryTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.delivery.deliver(entry), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private apply(
    entry: ClaimedBackendOutboxEntry,
    result: BackendOutboxDeliveryResult,
  ): Promise<boolean> {
    switch (result.outcome) {
      case 'DELIVERED':
        return this.store.markDone(entry);
      case 'PERMANENT':
        this.logger.error(
          `backend outbox row DEAD: ${entry.kind} ${maskConversationRef(entry.conversationRef)}#${entry.seq} (id ${entry.id}): ${sanitizeErrorText(result.error)}`,
        );
        return this.store.markDead(entry, result.error);
      case 'RETRY':
        return this.store.reschedule(
          entry,
          this.retryDelayMs(entry, result),
          result.error,
        );
    }
  }

  private async purgeIfDue(): Promise<void> {
    const now = this.clock();
    if (
      this.lastPurgeAt !== undefined &&
      now - this.lastPurgeAt < this.purgeIntervalMs
    )
      return;
    this.lastPurgeAt = now;
    try {
      for (let batch = 0; batch < this.maxPurgeBatches; batch++) {
        const deleted = await this.store.purgeDone(
          this.retentionMs,
          this.purgeBatchSize,
        );
        if (deleted < this.purgeBatchSize || this.stopped) return;
      }
    } catch (error) {
      this.logger.warn(`backend outbox purge failed: ${describeError(error)}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timerDelayMs = delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDelayMs = undefined;
      this.wakePending = false;
      let claimed = 0;
      this.inFlight = this.tick()
        .then((count) => {
          claimed = count;
        })
        .catch((error) => {
          this.logger.warn(
            `backend outbox tick failed: ${describeError(error)}`,
          );
        })
        .finally(() => {
          this.inFlight = undefined;
          // A full batch means more work is likely waiting: go again now.
          // So does a wake that arrived while this tick was running.
          const again = this.wakePending;
          this.wakePending = false;
          this.schedule(
            again || claimed >= this.batchSize || this.fullBatch
              ? 0
              : this.idleDelayMs,
          );
        });
    }, delayMs);
  }
}

class DeliveryTimeoutError extends Error {}

const describe = (error: unknown): string =>
  error instanceof DeliveryTimeoutError
    ? error.message
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : 'unknown error';
