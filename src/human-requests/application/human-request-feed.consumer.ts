import { Logger } from '@nestjs/common';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  FEED_MAX_LIMIT,
  FEED_MAX_WAIT_SECONDS,
  type ReadFeedResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import {
  RETRY_AFTER_MAX_MS,
  type FeedConsumerLock,
  type HumanRequestFeedStore,
} from '../domain/human-request-feed';
import type { HumanRequestDeliveryService } from './human-request-delivery.service';

export interface HumanRequestFeedConsumerPorts {
  store: Pick<HumanRequestFeedStore, 'readCursor' | 'saveCursor'>;
  client: Pick<HumanRequestsClient, 'readFeed'>;
  delivery: Pick<HumanRequestDeliveryService, 'accept'>;
  lock: FeedConsumerLock;
}

export interface HumanRequestFeedConsumerOptions {
  waitSeconds?: number;
  limit?: number;
  /** Delay before trying the advisory lock again. */
  lockRetryMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failures at one cursor before an error log. */
  stuckPageThreshold?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type FeedPassResult =
  | { kind: 'page'; items: number }
  | { kind: 'restarted' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'stopped' };

const STOPPED = Symbol('stopped');

/**
 * S2 feed consumer: one per database, guarded by a session advisory lock on
 * a dedicated connection. Long-polls from the stored cursor, hands every
 * item to the delivery service in order, and saves `nextCursor` only after
 * the whole page was handled locally ("the cursor is for reading; the ACK is
 * for delivering"). A failing page is read again with backoff, never
 * skipped; repeated failures at one cursor are logged as errors.
 */
export class HumanRequestFeedConsumer {
  private readonly logger = new Logger(HumanRequestFeedConsumer.name);
  private readonly waitSeconds: number;
  private readonly limit: number;
  private readonly lockRetryMs: number;
  private readonly maxBackoffMs: number;
  private readonly stuckPageThreshold: number;
  private readonly random: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private started = false;
  private stopped = false;
  private loopDone: Promise<void> = Promise.resolve();
  private wake?: () => void;
  private readonly stopSignal: Promise<typeof STOPPED>;
  private signalStop!: () => void;
  private lockHeld = false;
  private failures = 0;
  private failedCursor: string | null | undefined;
  private failedCount = 0;
  private lastCursor: string | null = null;

  constructor(
    private readonly ports: HumanRequestFeedConsumerPorts,
    options: HumanRequestFeedConsumerOptions = {},
  ) {
    this.waitSeconds = options.waitSeconds ?? FEED_MAX_WAIT_SECONDS;
    this.limit = options.limit ?? FEED_MAX_LIMIT;
    this.lockRetryMs = options.lockRetryMs ?? 15_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.stuckPageThreshold = options.stuckPageThreshold ?? 3;
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleep ?? ((ms) => this.interruptibleSleep(ms));
    this.stopSignal = new Promise((resolve) => {
      this.signalStop = () => resolve(STOPPED);
    });
  }

  /** Starts the loop once; never restarts after `stop`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.loopDone = this.loop();
  }

  /** Stops the loop without waiting for an open long-poll (its page is
   *  dropped unsaved); resolves after the page being handled and the lock
   *  release. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.signalStop();
      this.wake?.();
    }
    await this.loopDone;
  }

  /** Resolves once the loop has exited and released the lock. */
  whenStopped(): Promise<void> {
    return this.loopDone;
  }

  /** One long-poll and its page. Throws when the page could not be handled
   *  (the cursor is left where it was). */
  async runOnce(): Promise<FeedPassResult> {
    const cursor = await this.ports.store.readCursor();
    this.lastCursor = cursor;
    const read = this.ports.client.readFeed({
      ...(cursor === null ? {} : { after: cursor }),
      limit: this.limit,
      waitSeconds: this.waitSeconds,
    });
    read.catch(() => undefined); // a dropped poll must not reject unhandled
    const result: ReadFeedResult | typeof STOPPED = await Promise.race([
      read,
      this.stopSignal,
    ]);
    if (result === STOPPED || this.stopped) return { kind: 'stopped' };
    switch (result.kind) {
      case 'CURSOR_EXPIRED':
        this.logger.warn(
          'feed CURSOR_EXPIRED: restarting from the oldest retained item (deduplicated by deliveryId)',
        );
        await this.ports.store.saveCursor(null);
        return { kind: 'restarted' };
      case 'RATE_LIMITED':
        return {
          kind: 'rate_limited',
          retryAfterMs: Math.min(
            (result.retryAfterSeconds ?? 1) * 1000,
            RETRY_AFTER_MAX_MS,
          ),
        };
      case 'ok':
        for (const item of result.items) await this.ports.delivery.accept(item);
        if (result.nextCursor !== '' && result.nextCursor !== cursor)
          await this.ports.store.saveCursor(result.nextCursor);
        return { kind: 'page', items: result.items.length };
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (!(await this.ensureLock())) {
        if (!this.stopped) await this.sleepFn(this.lockRetryMs);
        continue;
      }
      let result: FeedPassResult;
      try {
        result = await this.runOnce();
      } catch (error) {
        this.onFailure(error);
        if (!this.stopped) await this.sleepFn(this.backoffMs());
        continue;
      }
      this.failures = 0;
      this.failedCount = 0;
      this.failedCursor = undefined;
      if (result.kind === 'rate_limited' && !this.stopped)
        await this.sleepFn(result.retryAfterMs);
    }
    await this.releaseLock();
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    try {
      await this.ports.lock.release();
    } catch (error) {
      this.logger.warn(`feed lock release failed: ${describe(error)}`);
    }
  }

  private async ensureLock(): Promise<boolean> {
    try {
      if (this.lockHeld) {
        if (await this.ports.lock.isHeld()) return true;
        this.lockHeld = false;
        this.logger.warn('feed advisory lock lost: reacquiring');
      }
      this.lockHeld = await this.ports.lock.tryAcquire();
    } catch (error) {
      this.lockHeld = false;
      this.logger.warn(`feed advisory lock failed: ${describe(error)}`);
    }
    return this.lockHeld;
  }

  private onFailure(error: unknown): void {
    this.failures += 1;
    if (this.failedCursor === this.lastCursor) this.failedCount += 1;
    else {
      this.failedCursor = this.lastCursor;
      this.failedCount = 1;
    }
    const at = this.lastCursor ?? '(start)';
    if (this.failedCount >= this.stuckPageThreshold)
      this.logger.error(
        `feed page at cursor ${at} stuck: ${this.failedCount} consecutive failures (${describe(error)})`,
      );
    else
      this.logger.warn(
        `feed page at cursor ${at} failed, retrying: ${describe(error)}`,
      );
  }

  private backoffMs(): number {
    const ceiling = Math.min(
      this.maxBackoffMs,
      1_000 * 2 ** Math.max(0, this.failures - 1),
    );
    return Math.floor(ceiling / 2 + (ceiling / 2) * this.random());
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wake = undefined;
    });
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
