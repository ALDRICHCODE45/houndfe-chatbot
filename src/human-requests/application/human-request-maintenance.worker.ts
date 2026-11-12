import { Logger } from '@nestjs/common';
import type { HumanRequestDeliveryService } from './human-request-delivery.service';
import { describeError } from '../../common/log-safe';

export interface HumanRequestMaintenanceOptions {
  intervalMs?: number;
}

/**
 * Periodic sweeps of the delivery ledger, on every instance (each step is
 * compare-and-set or an exact ACK replay, so concurrent instances are safe):
 * crash-left SENDING rows → DELIVERY_UNKNOWN, due PENDING ACKs retried with
 * the same body, HELD_HUMAN rows re-handled once the conversation is BOT,
 * and the 35-day retention purge of terminal ledger rows.
 */
export class HumanRequestMaintenanceWorker {
  private readonly logger = new Logger(HumanRequestMaintenanceWorker.name);
  private readonly intervalMs: number;
  private started = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;

  constructor(
    private readonly delivery: Pick<
      HumanRequestDeliveryService,
      'sweepAcks' | 'recoverStuckSending' | 'replayHeld' | 'purgeLedger'
    >,
    options: HumanRequestMaintenanceOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 15_000;
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

  async tick(): Promise<void> {
    await this.step('stuck send recovery', () =>
      this.delivery.recoverStuckSending(),
    );
    await this.step('ACK sweep', () => this.delivery.sweepAcks());
    await this.step('held replay', () => this.delivery.replayHeld());
    await this.step('ledger retention purge', () =>
      this.delivery.purgeLedger(),
    );
  }

  private async step(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(`human request ${name} failed: ${describeError(error)}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
        this.schedule(this.intervalMs);
      });
    }, delayMs);
  }
}
