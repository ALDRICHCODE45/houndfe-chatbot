import { Logger } from '@nestjs/common';
import {
  DEFAULT_DELIVERY_ZONE_POLL_POLICY,
  type DeliveryZonePollPolicy,
  type DeliveryZoneRequesterStore,
} from '../domain/delivery-zone-requester';
import type { DeliveryZoneNotifier } from './delivery-zone-notifier';

export interface DeliveryZonePollerOptions {
  /** Tick period; also the base gap between polls of one requester. */
  intervalMs?: number;
  /** Rows per tick (bounds backend calls per interval). */
  batchSize?: number;
  /** Age after which a requester is polled every `slowIntervalMs`. */
  slowAfterMs?: number;
  slowIntervalMs?: number;
}

/**
 * Durable DELIVERY_ZONE loop: on boot and every `intervalMs` it reads a
 * bounded batch of due requesters from the store and advances each one. No
 * in-memory queue or horizon: a validation may stay PENDING for days and a
 * restart simply resumes from the table.
 */
export class DeliveryZonePoller {
  private readonly logger = new Logger(DeliveryZonePoller.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly policy: DeliveryZonePollPolicy;
  private started = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;

  constructor(
    private readonly store: Pick<DeliveryZoneRequesterStore, 'listDue'>,
    private readonly notifier: Pick<DeliveryZoneNotifier, 'process'>,
    options: DeliveryZonePollerOptions = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.intervalMs =
      options.intervalMs ?? DEFAULT_DELIVERY_ZONE_POLL_POLICY.intervalMs;
    this.batchSize = options.batchSize ?? 20;
    this.policy = {
      intervalMs: this.intervalMs,
      slowAfterMs:
        options.slowAfterMs ?? DEFAULT_DELIVERY_ZONE_POLL_POLICY.slowAfterMs,
      slowIntervalMs:
        options.slowIntervalMs ??
        DEFAULT_DELIVERY_ZONE_POLL_POLICY.slowIntervalMs,
    };
    for (const value of [
      this.intervalMs,
      this.batchSize,
      this.policy.slowAfterMs,
      this.policy.slowIntervalMs,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('Poller bounds must be positive safe integers');
    if (this.intervalMs > 2 ** 31 - 1)
      throw new RangeError('Poller interval exceeds timer range');
  }

  /** First tick runs immediately (boot), then every `intervalMs`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return this.inFlight ?? Promise.resolve();
  }

  /** One bounded batch; a failing row never stops the others. */
  async tick(): Promise<void> {
    let rows;
    try {
      rows = await this.store.listDue(
        this.clock().toISOString(),
        this.batchSize,
        this.policy,
      );
    } catch {
      this.logger.warn('DELIVERY_ZONE due-requester read failed');
      return;
    }
    for (const row of rows) {
      if (this.stopped) return;
      try {
        await this.notifier.process(row);
      } catch {
        // The notifier already logs; continue with the next requester.
      }
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = Promise.resolve()
        .then(() => this.tick())
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(this.intervalMs);
        });
    }, delayMs);
  }
}
