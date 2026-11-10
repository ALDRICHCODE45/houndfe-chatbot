import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  CONVERSATION_GATE_STORE,
  type ConversationGateStore,
} from '../domain/conversation-gate.store';

export const CONVERSATION_GATE_PURGE_OPTIONS = Symbol(
  'CONVERSATION_GATE_PURGE_OPTIONS',
);

export interface ConversationGatePurgeOptions {
  batchSize: number;
  /** Bounds one tick so a large backlog never holds a connection for long. */
  maxBatchesPerTick: number;
  initialDelayMs: number;
  intervalMs: number;
}

export const DEFAULT_CONVERSATION_GATE_PURGE_OPTIONS: ConversationGatePurgeOptions =
  {
    batchSize: 500,
    maxBatchesPerTick: 20,
    initialDelayMs: 60_000,
    intervalMs: 5 * 60_000,
  };

/**
 * S4: deletes expired conversation gates in bounded batches. Expiry is
 * already enforced on read, so this only reclaims space. Timers are unref'd;
 * shutdown stops new ticks and waits for the current batch, and runs before
 * the pool closes because this module depends on `DatabaseModule`.
 */
@Injectable()
export class ConversationGatePurgeWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ConversationGatePurgeWorker.name);
  private readonly options: ConversationGatePurgeOptions;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private tick: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(CONVERSATION_GATE_STORE)
    private readonly store: ConversationGateStore,
    @Optional()
    @Inject(CONVERSATION_GATE_PURGE_OPTIONS)
    options?: Partial<ConversationGatePurgeOptions>,
  ) {
    this.options = { ...DEFAULT_CONVERSATION_GATE_PURGE_OPTIONS, ...options };
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
    let deleted = 0;
    try {
      for (let batch = 0; batch < this.options.maxBatchesPerTick; batch += 1) {
        const count = await this.store.purgeExpired(this.options.batchSize);
        deleted += count;
        if (count < this.options.batchSize || this.stopped) break;
      }
    } catch (error) {
      this.logger.warn(
        `conversation gate purge failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (deleted > 0) this.logger.log(`purged ${deleted} conversation gates`);
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
