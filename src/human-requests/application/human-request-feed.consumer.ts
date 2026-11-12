import { Logger } from '@nestjs/common';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  FEED_MAX_LIMIT,
  FEED_MAX_WAIT_SECONDS,
  OPEN_REQUESTS_MAX_LIMIT,
  type FeedItem,
  type OpenHumanRequest,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import {
  RETRY_AFTER_MAX_MS,
  senderIdFromRef,
  type FeedConsumerLock,
  type HumanRequestFeedStore,
} from '../domain/human-request-feed';
import type { HumanRequestDeliveryService } from './human-request-delivery.service';
import { describeError } from '../../common/log-safe';

export interface HumanRequestFeedConsumerPorts {
  store: Pick<
    HumanRequestFeedStore,
    | 'readCursor'
    | 'saveCursor'
    | 'readSyncedAt'
    | 'recordOpenRequest'
    | 'closeRequest'
    | 'listOpenRequestIds'
  >;
  client: Pick<HumanRequestsClient, 'readFeed' | 'listOpenRequests'>;
  delivery: Pick<HumanRequestDeliveryService, 'accept' | 'abandon'>;
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
  /** Consecutive failures of one deliveryId before it may be abandoned. */
  poisonItemThreshold?: number;
  /** How long one deliveryId must keep failing before it may be abandoned
   *  (default 10 minutes), so a short dependency outage never gives up a
   *  valid delivery. Both this and `poisonItemThreshold` must be reached. */
  poisonItemMinMs?: number;
  /** Recovery leaves local OPEN rows created this close to the walk start
   *  alone (app/database clock skew; default 60 s). */
  recoveryGraceMs?: number;
  /** Milliseconds since the epoch (default `Date.now`). */
  clock?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type FeedPassResult =
  | { kind: 'page'; items: number }
  | { kind: 'recovered'; requests: number; deliveries: number }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'stopped' };

const STOPPED = Symbol('stopped');

/**
 * S2 feed consumer: one per database, guarded by a session advisory lock on
 * a dedicated connection. Long-polls from the stored cursor, hands every
 * item to the delivery service in order, and saves `nextCursor` only after
 * the whole page was handled locally ("the cursor is for reading; the ACK is
 * for delivering"). A failing page is read again with backoff, never
 * skipped; repeated failures at one cursor are logged as errors. A
 * `410 CURSOR_EXPIRED` runs the 5c recovery walk (`recover`).
 */
export class HumanRequestFeedConsumer {
  private readonly logger = new Logger(HumanRequestFeedConsumer.name);
  private readonly waitSeconds: number;
  private readonly limit: number;
  private readonly lockRetryMs: number;
  private readonly maxBackoffMs: number;
  private readonly stuckPageThreshold: number;
  private readonly poisonItemThreshold: number;
  private readonly poisonItemMinMs: number;
  private readonly recoveryGraceMs: number;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private started = false;
  private stopped = false;
  private loopDone: Promise<void> = Promise.resolve();
  private wake?: () => void;
  /** One listener per pending wait, removed when the wait settles (a single
   *  long-lived promise in Promise.race would retain every page). */
  private readonly stopListeners = new Set<() => void>();
  private lockHeld = false;
  private failures = 0;
  private failedCursor: string | null | undefined;
  private failedCount = 0;
  private lastCursor: string | null = null;
  private failingItem: string | undefined;
  private failingItemCount = 0;
  private failingItemSince = 0;

  constructor(
    private readonly ports: HumanRequestFeedConsumerPorts,
    options: HumanRequestFeedConsumerOptions = {},
  ) {
    this.waitSeconds = options.waitSeconds ?? FEED_MAX_WAIT_SECONDS;
    this.limit = options.limit ?? FEED_MAX_LIMIT;
    this.lockRetryMs = options.lockRetryMs ?? 15_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.stuckPageThreshold = options.stuckPageThreshold ?? 3;
    this.poisonItemThreshold = options.poisonItemThreshold ?? 5;
    this.poisonItemMinMs = options.poisonItemMinMs ?? 10 * 60_000;
    this.recoveryGraceMs = options.recoveryGraceMs ?? 60_000;
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleepFn = options.sleep ?? ((ms) => this.interruptibleSleep(ms));
  }

  /** Starts the loop once; never restarts after `stop`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.loopDone = this.loop();
  }

  /** Idempotent. Stops the loop without waiting for an open long-poll (its
   *  page is dropped unsaved); an item being handled is finished, the rest of
   *  its page is left unsaved (handled items are in the ledger and replay
   *  without a resend). Resolves after the lock release. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      for (const listener of [...this.stopListeners]) listener();
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
    if (this.stopped) return { kind: 'stopped' };
    const cursor = await this.ports.store.readCursor();
    this.lastCursor = cursor;
    if (this.stopped) return { kind: 'stopped' };
    // Everything committed before this instant is in this page or before.
    const syncedAt = new Date(this.clock()).toISOString();
    const read = this.ports.client.readFeed({
      ...(cursor === null ? {} : { after: cursor }),
      limit: this.limit,
      waitSeconds: this.waitSeconds,
    });
    read.catch(() => undefined); // a dropped poll must not reject unhandled
    const result = await this.untilStopped(read);
    if (result === STOPPED || this.stopped) return { kind: 'stopped' };
    switch (result.kind) {
      case 'CURSOR_EXPIRED':
        this.logger.warn(
          `feed CURSOR_EXPIRED at cursor ${cursor ?? '(start)'}: recovering through the open requests route`,
        );
        return this.recover();
      case 'RATE_LIMITED':
        return {
          kind: 'rate_limited',
          retryAfterMs: Math.min(
            (result.retryAfterSeconds ?? 1) * 1000,
            RETRY_AFTER_MAX_MS,
          ),
        };
      case 'ok':
        for (const item of result.items) {
          if (this.stopped) return { kind: 'stopped' };
          await this.handle(item);
        }
        await this.ports.store.saveCursor(
          result.nextCursor === '' ? cursor : result.nextCursor,
          syncedAt,
        );
        return { kind: 'page', items: result.items.length };
    }
  }

  /**
   * 5c recovery after `410 CURSOR_EXPIRED`
   * (docs/contracts/human-intervention-bot-contract-5b.md, "Slice 5c"): walks
   * every page of the open requests route from the stored synced_at,
   * reconciles the registry, hands every pending delivery to the same path as
   * a feed item, and only then saves the smallest of `nextCursor` and every
   * `undeliveredResumeAfter` (plain fixed-width string comparison) with the
   * walk start as synced_at. Any failure leaves the expired cursor in place,
   * so the next pass gets 410 again and walks from the first page.
   */
  private async recover(): Promise<FeedPassResult> {
    const startedAt = this.clock();
    const updatedSince = await this.ports.store.readSyncedAt();
    const listedOpen = new Set<string>();
    let page: string | undefined;
    let nextCursor: string | undefined;
    let resume: string | undefined;
    let requests = 0;
    let deliveries = 0;
    for (;;) {
      if (this.stopped) return { kind: 'stopped' };
      const list = this.ports.client.listOpenRequests({
        ...(updatedSince === null ? {} : { updatedSince }),
        ...(page === undefined ? {} : { cursor: page }),
        limit: OPEN_REQUESTS_MAX_LIMIT,
      });
      list.catch(() => undefined);
      const result = await this.untilStopped(list);
      if (result === STOPPED || this.stopped) return { kind: 'stopped' };
      if (result.kind === 'RATE_LIMITED') {
        // The same page again after Retry-After.
        await this.sleepFn(
          Math.min((result.retryAfterSeconds ?? 1) * 1000, RETRY_AFTER_MAX_MS),
        );
        continue;
      }
      if (result.kind === 'VALIDATION_ERROR') {
        const reason = `VALIDATION_ERROR ${result.message ?? ''}`.trim();
        this.logger.error(`feed recovery rejected: ${reason}`);
        throw new Error(`feed recovery rejected: ${reason}`);
      }
      nextCursor ??= result.nextCursor;
      for (const request of result.items) {
        requests += 1;
        await this.reconcile(request, listedOpen);
        for (const item of request.pendingDeliveries) {
          if (this.stopped) return { kind: 'stopped' };
          await this.handle(item);
          deliveries += 1;
        }
        const after = request.undeliveredResumeAfter;
        if (after !== null && (resume === undefined || after < resume))
          resume = after;
      }
      if (result.nextPage === null) break;
      page = result.nextPage;
    }
    if (this.stopped) return { kind: 'stopped' };
    // Local OPEN rows the backend no longer lists as open are closed.
    const local = await this.ports.store.listOpenRequestIds(
      new Date(startedAt - this.recoveryGraceMs),
    );
    for (const requestId of local)
      if (!listedOpen.has(requestId))
        await this.ports.store.closeRequest(requestId, 'RESOLVED');
    const position =
      resume !== undefined && resume < nextCursor ? resume : nextCursor;
    await this.ports.store.saveCursor(
      position,
      new Date(startedAt).toISOString(),
    );
    this.logger.warn(
      `feed recovered: ${requests} requests, ${deliveries} pending deliveries; resuming after ${position}`,
    );
    return { kind: 'recovered', requests, deliveries };
  }

  /** NEW/IN_PROGRESS → an OPEN registry row; RESOLVED/CANCELLED → closed. */
  private async reconcile(
    request: OpenHumanRequest,
    listedOpen: Set<string>,
  ): Promise<void> {
    if (request.status === 'RESOLVED' || request.status === 'CANCELLED') {
      listedOpen.delete(request.id);
      await this.ports.store.closeRequest(request.id, request.status);
      return;
    }
    listedOpen.add(request.id);
    // The registry only keeps requests tied to a WhatsApp conversation.
    if (
      request.conversationRef === null ||
      senderIdFromRef(request.conversationRef) === null
    )
      return;
    await this.ports.store.recordOpenRequest({
      requestId: request.id,
      conversationRef: request.conversationRef,
      subtype: request.subtype,
      legacyId: request.legacyId,
    });
  }

  /** One item; a deliveryId that keeps failing for `poisonItemMinMs` and
   *  `poisonItemThreshold` attempts is abandoned (recorded for staff to
   *  reconcile, never resent) so it cannot block the feed. */
  private async handle(item: FeedItem): Promise<void> {
    try {
      await this.ports.delivery.accept(item);
    } catch (error) {
      const now = this.clock();
      if (this.failingItem === item.deliveryId) this.failingItemCount += 1;
      else {
        this.failingItem = item.deliveryId;
        this.failingItemCount = 1;
        this.failingItemSince = now;
      }
      const failingMs = now - this.failingItemSince;
      if (
        this.failingItemCount < this.poisonItemThreshold ||
        failingMs < this.poisonItemMinMs
      )
        throw error;
      // Throws when the ledger is unreadable: the page stays stuck.
      await this.ports.delivery.abandon(item, describeError(error));
      this.logger.error(
        `feed item ${item.deliveryId} abandoned after ${this.failingItemCount} consecutive failures over ${Math.round(failingMs / 1000)} s: ${describeError(error)}`,
      );
    }
    if (this.failingItem === item.deliveryId) {
      this.failingItem = undefined;
      this.failingItemCount = 0;
    }
  }

  /** Resolves with the work's result, or STOPPED as soon as stop is called. */
  private untilStopped<T>(work: Promise<T>): Promise<T | typeof STOPPED> {
    if (this.stopped) return Promise.resolve(STOPPED);
    let listener!: () => void;
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      listener = () => resolve(STOPPED);
      this.stopListeners.add(listener);
    });
    return Promise.race([work, stopped]).finally(() => {
      this.stopListeners.delete(listener);
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (!(await this.ensureLock())) {
        if (!this.stopped) await this.sleepFn(this.lockRetryMs);
        continue;
      }
      if (this.stopped) break;
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
      this.logger.warn(`feed lock release failed: ${describeError(error)}`);
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
      this.logger.warn(`feed advisory lock failed: ${describeError(error)}`);
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
        `feed page at cursor ${at} stuck: ${this.failedCount} consecutive failures (${describeError(error)})`,
      );
    else
      this.logger.warn(
        `feed page at cursor ${at} failed, retrying: ${describeError(error)}`,
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
