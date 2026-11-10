import { Logger } from '@nestjs/common';
import {
  RETRY_AFTER_MAX_MS,
  backoffDelayMs,
  type BackendOutboxDeliveryPort,
  type BackendOutboxDeliveryResult,
  type BackendOutboxStore,
  type ClaimedBackendOutboxEntry,
} from '../domain/backend-outbox';

export interface BackendOutboxDrainOptions {
  /** Stable per-process lease owner. */
  owner: string;
  /** Conversation heads claimed (and delivered concurrently) per tick. */
  batchSize?: number;
  leaseMs?: number;
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
 * conversation heads under a lease and delivers them concurrently (they
 * belong to different conversations, so order is preserved). DELIVERED →
 * DONE; RETRY or a thrown error → PENDING again with capped exponential
 * backoff and jitter (or the backend's Retry-After), retried forever;
 * PERMANENT → DEAD with an error log, which unblocks the next seq. DONE rows
 * older than the retention are purged in bounded batches.
 */
export class BackendOutboxDrainWorker {
  private readonly logger = new Logger(BackendOutboxDrainWorker.name);
  private readonly batchSize: number;
  private readonly leaseMs: number;
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
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;

  constructor(
    private readonly store: BackendOutboxStore,
    private readonly delivery: BackendOutboxDeliveryPort,
    private readonly options: BackendOutboxDrainOptions,
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.leaseMs = options.leaseMs ?? 60_000;
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
      this.idleDelayMs,
      this.purgeIntervalMs,
      this.retentionMs,
      this.purgeBatchSize,
      this.maxPurgeBatches,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('backend outbox: bounds must be positive');
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
    return this.inFlight ?? Promise.resolve();
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
      this.logger.warn(`backend outbox claim failed: ${describe(error)}`);
      return 0;
    }
    await Promise.all(claimed.map((entry) => this.process(entry)));
    return claimed.length;
  }

  private async process(entry: ClaimedBackendOutboxEntry): Promise<void> {
    let result: BackendOutboxDeliveryResult;
    try {
      result = await this.delivery.deliver(entry);
    } catch (error) {
      result = { outcome: 'RETRY', error: describe(error) };
    }
    try {
      const applied = await this.apply(entry, result);
      if (!applied)
        // Lease lost (expired and reclaimed): the new owner redelivers.
        this.logger.warn(
          `backend outbox lease lost for ${entry.kind} ${entry.conversationRef}#${entry.seq}`,
        );
    } catch (error) {
      // The lease expires and the row is reclaimed; delivery is idempotent.
      this.logger.warn(`backend outbox completion failed: ${describe(error)}`);
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
          `backend outbox row DEAD: ${entry.kind} ${entry.conversationRef}#${entry.seq} (id ${entry.id}): ${result.error}`,
        );
        return this.store.markDead(entry, result.error);
      case 'RETRY': {
        const delayMs =
          result.retryAfterMs !== undefined
            ? Math.min(Math.max(result.retryAfterMs, 0), RETRY_AFTER_MAX_MS)
            : backoffDelayMs(entry.attempts + 1, this.random);
        return this.store.reschedule(entry, delayMs, result.error);
      }
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
      this.logger.warn(`backend outbox purge failed: ${describe(error)}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let claimed = 0;
      this.inFlight = this.tick()
        .then((count) => {
          claimed = count;
        })
        .catch((error) => {
          this.logger.warn(`backend outbox tick failed: ${describe(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
          // A full batch means more work is likely waiting: go again now.
          this.schedule(claimed >= this.batchSize ? 0 : this.idleDelayMs);
        });
    }, delayMs);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
