import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  CONVERSATION_TRANSCRIPT,
  type ConversationTranscriptStore,
} from '../domain/transcript.port';
import { TRANSCRIPT_CLOCK } from './transcript-recorder';
import { describeError } from '../../common/log-safe';

export const TRANSCRIPT_PURGE_OPTIONS = Symbol('TRANSCRIPT_PURGE_OPTIONS');

export interface TranscriptPurgeOptions {
  batchSize: number;
  /** Bounds one tick so a large backlog never holds a connection for long. */
  maxBatchesPerTick: number;
  initialDelayMs: number;
  intervalMs: number;
}

export const DEFAULT_TRANSCRIPT_PURGE_OPTIONS: TranscriptPurgeOptions = {
  batchSize: 1000,
  maxBatchesPerTick: 20,
  initialDelayMs: 60_000,
  intervalMs: 60 * 60_000,
};

/**
 * S1 retention: deletes transcript rows past their purge time in batches of
 * 1000 on an interval. Timers are unref'd so they never keep the process
 * alive; shutdown stops new ticks and waits for the current batch only.
 */
@Injectable()
export class TranscriptPurgeWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TranscriptPurgeWorker.name);
  private readonly now: () => Date;
  private readonly options: TranscriptPurgeOptions;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private tick: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(CONVERSATION_TRANSCRIPT)
    private readonly store: ConversationTranscriptStore,
    @Optional() @Inject(TRANSCRIPT_CLOCK) now?: () => Date,
    @Optional()
    @Inject(TRANSCRIPT_PURGE_OPTIONS)
    options?: Partial<TranscriptPurgeOptions>,
  ) {
    this.now = now ?? (() => new Date());
    this.options = { ...DEFAULT_TRANSCRIPT_PURGE_OPTIONS, ...options };
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
    const now = this.now();
    let deleted = 0;
    try {
      for (let batch = 0; batch < this.options.maxBatchesPerTick; batch += 1) {
        const count = await this.store.purgeExpired(
          now,
          this.options.batchSize,
        );
        deleted += count;
        if (count < this.options.batchSize || this.stopped) break;
      }
    } catch (error) {
      this.logger.warn(`transcript purge failed: ${describeError(error)}`);
    }
    if (deleted > 0) this.logger.log(`purged ${deleted} transcript messages`);
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
