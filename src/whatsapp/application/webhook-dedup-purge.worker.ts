import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  WEBHOOK_DEDUP,
  WEBHOOK_DEDUP_CLOCK,
  WEBHOOK_DEDUP_RETENTION_MS,
  type WebhookDedupStore,
} from '../domain/webhook-dedup.store';

export const WEBHOOK_DEDUP_PURGE_OPTIONS = Symbol(
  'WEBHOOK_DEDUP_PURGE_OPTIONS',
);

export interface WebhookDedupPurgeOptions {
  batchSize: number;
  /** Bounds one tick so a large backlog never holds a connection for long. */
  maxBatchesPerTick: number;
  initialDelayMs: number;
  intervalMs: number;
}

export const DEFAULT_WEBHOOK_DEDUP_PURGE_OPTIONS: WebhookDedupPurgeOptions = {
  batchSize: 1000,
  maxBatchesPerTick: 20,
  initialDelayMs: 60_000,
  intervalMs: 60 * 60_000,
};

/**
 * S6 retention: deletes processed_webhook_messages rows (DONE, or abandoned
 * claims) older than 8 days in batches of 1000 on an interval. Meta stops
 * redelivering after 7 days, so a purged id can no longer come back. Timers
 * are unref'd; shutdown stops new ticks and waits for the current batch, so
 * WhatsappModule is destroyed before DatabaseModule ends the pool.
 */
@Injectable()
export class WebhookDedupPurgeWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookDedupPurgeWorker.name);
  private readonly now: () => Date;
  private readonly options: WebhookDedupPurgeOptions;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private tick: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(WEBHOOK_DEDUP)
    private readonly store: WebhookDedupStore,
    @Optional() @Inject(WEBHOOK_DEDUP_CLOCK) now?: () => Date,
    @Optional()
    @Inject(WEBHOOK_DEDUP_PURGE_OPTIONS)
    options?: Partial<WebhookDedupPurgeOptions>,
  ) {
    this.now = now ?? (() => new Date());
    this.options = { ...DEFAULT_WEBHOOK_DEDUP_PURGE_OPTIONS, ...options };
  }

  /** Idempotent; never restarts after stop. */
  onApplicationBootstrap(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.schedule(this.options.initialDelayMs);
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.running = false;
    clearTimeout(this.timer);
    return this.tick.then(() => undefined);
  }

  /** One tick: full batches until one comes back short. Never throws. */
  async purgeOnce(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - WEBHOOK_DEDUP_RETENTION_MS);
    let deleted = 0;
    try {
      for (let batch = 0; batch < this.options.maxBatchesPerTick; batch += 1) {
        const count = await this.store.purgeBefore(
          cutoff,
          this.options.batchSize,
        );
        deleted += count;
        if (count < this.options.batchSize || this.stopped) break;
      }
    } catch (error) {
      this.logger.warn(
        `webhook dedup purge failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (deleted > 0) this.logger.log(`purged ${deleted} webhook dedup rows`);
    return deleted;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick = this.purgeOnce().then(() =>
        this.schedule(this.options.intervalMs),
      );
    }, delayMs);
    this.timer.unref?.();
  }
}
