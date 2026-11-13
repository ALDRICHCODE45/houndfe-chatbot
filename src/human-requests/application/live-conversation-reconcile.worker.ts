import { Logger } from '@nestjs/common';
import type { LiveConversationClient } from '../../chatbot-api/domain/live-conversation.port';
import type {
  ConversationHandoffState,
  HumanConversationState,
  LiveConversationMode,
} from '../../chatbot-api/domain/dtos/live-conversation.dto';
import type { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import { describeError } from '../../common/log-safe';
import {
  maskConversationRef,
  senderIdFromRef,
  type FeedConsumerLock,
} from '../domain/human-request-feed';
import type { SafetyRunResult } from './live-conversation-safety';

/** Advisory-lock key of the reconcile run (one run at a time per database;
 *  `new PostgresFeedConsumerLock(pool, LIVE_RECONCILE_LOCK_KEY)`). */
export const LIVE_RECONCILE_LOCK_KEY = 'live_conversation:reconcile';

/** The backend's view of one conversation (the part reconcile applies). */
type BackendView = Pick<
  ConversationHandoffState,
  'mode' | 'handoffEpoch' | 'requestId'
>;

export interface LiveReconcilePorts {
  mode: Pick<
    HandoffModeService,
    'getState' | 'applyStarted' | 'applyEnded' | 'listHuman'
  > &
    /** Follow-ups S4: the ENDING marker (see below). Optional: absent → no
     *  marker, the replay goes out right away (hand-built harnesses). */
    Partial<Pick<HandoffModeService, 'markEnding' | 'clearEnding'>>;
  client: Pick<
    LiveConversationClient,
    'listHumanConversations' | 'getConversationState' | 'sessionAck'
  >;
  /** Replays the conversation's held / deferred deliveries once it is BOT
   *  again: `HumanRequestDeliveryService.onCustomerInbound(ref)` (never
   *  throws; a throw is logged and never undoes the durable mode). */
  replay(conversationRef: string): Promise<void>;
  /** Cross-replica single flight (a session advisory lock). */
  lock: FeedConsumerLock;
  /** Rule 8, checked after each run (also when the reconcile failed). */
  safety?: { run(): Promise<SafetyRunResult> };
}

export interface LiveReconcileOptions {
  /** Time between runs (default 5 min). */
  intervalMs?: number;
  /** ± fraction applied to every interval (default 0.2). */
  jitterRatio?: number;
  /** The first run waits a random 0..this (default 5 s) so replicas that
   *  boot together do not hit the backend together. */
  startupJitterMs?: number;
  /** Bulk page size (1..500, default 200). */
  pageLimit?: number;
  /** Bulk pages per run (default 25); a longer list is `truncated`. */
  maxPages?: number;
  /** Confirming single reads per run for local HUMAN conversations the
   *  bulk list does not show (default 50). */
  maxStateReads?: number;
  /** A disagreeing `messages:batch` hint reconciles a conversation at most
   *  once per this window (default 30 s). */
  hintDebounceMs?: number;
  /** Milliseconds since the epoch (default `Date.now`). */
  clock?: () => number;
  random?: () => number;
}

export type ReconcileOneResult = {
  kind: 'started' | 'ended' | 'in_sync' | 'failed' | 'ignored';
};

export type ReconcileAllResult =
  /** Nothing is HUMAN locally and the backend list is empty. */
  | { kind: 'idle' }
  | { kind: 'ok'; started: number; ended: number; truncated: boolean }
  | { kind: 'failed' };

export type ReconcileTickResult =
  | { kind: 'busy' | 'locked_elsewhere' | 'lock_failed' }
  | {
      kind: 'ran';
      reconcile: ReconcileAllResult;
      safety?: SafetyRunResult | { kind: 'failed' };
    };

type Applied = 'started' | 'ended' | 'in_sync';

const LOCAL_HUMAN_LIMIT = 1000;
const HINT_MAP_PRUNE_AT = 2000;

/**
 * Live conversation T7, contract rule 9: the backend always wins.
 *
 * Every run (start-up, then every ~5 min with jitter) reads the backend's
 * bulk `?mode=HUMAN` list ONE call per page and compares it with the local
 * HUMAN conversations:
 *
 *   - backend HUMAN with a higher epoch than ours → a missed `started`:
 *     durable HUMAN (compare-and-set), then session-ack STARTED; no greeting;
 *   - local HUMAN that the backend shows as BOT, or does not show at all
 *     (confirmed by one single read, bounded) → a missed `ended` with
 *     farewell=false: durable BOT keeping the (higher) epoch, then the replay
 *     of the held deliveries; no farewell and no ack (a backend BOT means the
 *     session is already ENDED there). The `conversation.ended` item may
 *     still be on its way (its farewell must come first), so the revert sets
 *     a short ENDING marker (bounded, 2 min) that the replay paths honour: it
 *     is cleared by that item's handling or released by its bound.
 *
 * The compare-and-set is epoch-monotonic, so a stale read can never move the
 * state backwards, and every step is idempotent. No phone reaches a log.
 */
export class LiveConversationReconcileWorker {
  private readonly logger = new Logger(LiveConversationReconcileWorker.name);
  private readonly intervalMs: number;
  private readonly jitterRatio: number;
  private readonly startupJitterMs: number;
  private readonly pageLimit: number;
  private readonly maxPages: number;
  private readonly maxStateReads: number;
  private readonly hintDebounceMs: number;
  private readonly clock: () => number;
  private readonly random: () => number;
  private started = false;
  private stopped = false;
  private running = false;
  private runs = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<unknown>;
  private readonly oneInFlight = new Map<string, Promise<ReconcileOneResult>>();
  private readonly hintUntil = new Map<string, number>();
  private readonly hints = new Set<Promise<void>>();

  constructor(
    private readonly ports: LiveReconcilePorts,
    options: LiveReconcileOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 300_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.startupJitterMs = options.startupJitterMs ?? 5_000;
    this.pageLimit = options.pageLimit ?? 200;
    this.maxPages = options.maxPages ?? 25;
    this.maxStateReads = options.maxStateReads ?? 50;
    this.hintDebounceMs = options.hintDebounceMs ?? 30_000;
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  // ------------------------------------------------------------- timer

  /** The first run follows a short random delay; never restarts after
   *  `stop`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(Math.floor(this.random() * this.startupJitterMs));
  }

  /** Stops scheduling and waits for the run in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    await this.idle();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(this.nextDelayMs());
        });
    }, delayMs);
  }

  private nextDelayMs(): number {
    const spread = this.jitterRatio * (2 * this.random() - 1);
    return Math.max(1_000, Math.round(this.intervalMs * (1 + spread)));
  }

  // --------------------------------------------------------------- run

  /**
   * One run, never concurrent: in this process (`busy`) or across replicas
   * (the advisory lock). The safety notice check (rule 8) follows every run
   * after the first, whether or not the backend answered (a feed outage is
   * usually a backend outage); the first run skips it because the feed
   * consumer may not have synced yet after a restart.
   */
  async tick(): Promise<ReconcileTickResult> {
    if (this.running) return { kind: 'busy' };
    this.running = true;
    try {
      let acquired: boolean;
      try {
        acquired = await this.ports.lock.tryAcquire();
      } catch (error) {
        this.logger.warn(`live reconcile lock failed: ${describeError(error)}`);
        return { kind: 'lock_failed' };
      }
      if (!acquired) return { kind: 'locked_elsewhere' };
      try {
        let reconcile: ReconcileAllResult;
        try {
          reconcile = await this.reconcileAll();
        } catch (error) {
          this.logger.warn(
            `live reconcile run failed: ${describeError(error)}`,
          );
          reconcile = { kind: 'failed' };
        }
        let safety: SafetyRunResult | { kind: 'failed' } | undefined;
        if (this.runs > 0 && this.ports.safety !== undefined) {
          try {
            safety = await this.ports.safety.run();
          } catch (error) {
            this.logger.warn(
              `live safety notice check failed: ${describeError(error)}`,
            );
            safety = { kind: 'failed' };
          }
        }
        this.runs += 1;
        return {
          kind: 'ran',
          reconcile,
          ...(safety === undefined ? {} : { safety }),
        };
      } finally {
        try {
          await this.ports.lock.release();
        } catch (error) {
          this.logger.warn(
            `live reconcile lock release failed: ${describeError(error)}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ----------------------------------------------------- bulk reconcile

  /** The bulk pass of rule 9 (see the class comment). Throws only when the
   *  local store cannot be read. */
  async reconcileAll(): Promise<ReconcileAllResult> {
    const locals = await this.ports.mode.listHuman(LOCAL_HUMAN_LIMIT);
    const localBySender = new Map(
      locals.map((l) => [
        l.senderId,
        { mode: 'HUMAN' as const, epoch: l.epoch },
      ]),
    );

    const items: HumanConversationState[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let complete = false;
    let failed = false;
    while (pages < this.maxPages) {
      pages += 1;
      const page = await this.ports.client.listHumanConversations({
        limit: this.pageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.kind !== 'ok') {
        this.logger.warn(
          `live reconcile bulk read failed (${page.kind}); local state kept`,
        );
        failed = true;
        break;
      }
      items.push(...page.items);
      if (page.nextCursor === null) {
        complete = true;
        break;
      }
      cursor = page.nextCursor;
    }
    const truncated = !failed && !complete;
    if (truncated)
      this.logger.warn(
        `live reconcile bulk list cut after ${this.maxPages} pages; missed ended is not inferred this run`,
      );
    if (!failed && locals.length === 0 && items.length === 0 && complete)
      return { kind: 'idle' };

    let started = 0;
    let ended = 0;
    const tally = (applied: Applied) => {
      if (applied === 'started') started += 1;
      else if (applied === 'ended') ended += 1;
    };

    const seen = new Set<string>();
    for (const item of items) {
      const senderId = senderIdFromRef(item.conversationRef);
      if (senderId === null) continue;
      seen.add(senderId);
      try {
        const local = localBySender.get(senderId) ?? {
          ...(await this.ports.mode.getState(senderId)),
        };
        tally(
          await this.applyBackend(item.conversationRef, senderId, item, local),
        );
      } catch (error) {
        this.logger.warn(
          `live reconcile of ${maskConversationRef(item.conversationRef)} failed: ${describeError(error)}`,
        );
      }
    }

    // Local HUMAN the backend does not list: only with a complete list, and
    // each one is confirmed by a single read first (the list is a live read
    // and may miss a conversation that changed while paging).
    if (complete) {
      let reads = 0;
      for (const local of locals) {
        if (seen.has(local.senderId)) continue;
        if (reads >= this.maxStateReads) break;
        reads += 1;
        const ref = `wa:${local.senderId}`;
        try {
          const state = await this.ports.client.getConversationState(ref);
          if (state.kind !== 'ok') {
            this.logger.warn(
              `live reconcile confirming read failed (${state.kind}); stopping confirmations`,
            );
            break;
          }
          tally(
            await this.applyBackend(ref, local.senderId, state, {
              mode: 'HUMAN',
              epoch: local.epoch,
            }),
          );
        } catch (error) {
          this.logger.warn(
            `live reconcile of ${maskConversationRef(ref)} failed: ${describeError(error)}`,
          );
          break;
        }
      }
    }

    if (started > 0 || ended > 0)
      this.logger.log(
        `live reconcile applied ${started} missed started and ${ended} missed ended`,
      );
    return failed
      ? { kind: 'failed' }
      : { kind: 'ok', started, ended, truncated };
  }

  // ------------------------------------------------- single conversation

  /**
   * Reconciles ONE conversation with a single GET state. Call it right after
   * a refused session-ack STARTED (NOT_FOUND / STALE_EPOCH /
   * SESSION_NOT_ENDING) so a mute the backend does not know is repaired at
   * once. Concurrent calls for a conversation share one read. Never throws.
   */
  reconcileOne(conversationRef: string): Promise<ReconcileOneResult> {
    const senderId = senderIdFromRef(conversationRef);
    if (senderId === null) return Promise.resolve({ kind: 'ignored' });
    const existing = this.oneInFlight.get(conversationRef);
    if (existing !== undefined) return existing;
    const work = this.doReconcileOne(conversationRef, senderId).finally(() => {
      this.oneInFlight.delete(conversationRef);
    });
    this.oneInFlight.set(conversationRef, work);
    return work;
  }

  private async doReconcileOne(
    ref: string,
    senderId: string,
  ): Promise<ReconcileOneResult> {
    try {
      const state = await this.ports.client.getConversationState(ref);
      if (state.kind !== 'ok') {
        this.logger.warn(
          `live reconcile read of ${maskConversationRef(ref)} failed (${state.kind}); local state kept`,
        );
        return { kind: 'failed' };
      }
      const local = await this.ports.mode.getState(senderId);
      return { kind: await this.applyBackend(ref, senderId, state, local) };
    } catch (error) {
      this.logger.warn(
        `live reconcile of ${maskConversationRef(ref)} failed: ${describeError(error)}`,
      );
      return { kind: 'failed' };
    }
  }

  // ------------------------------------------------------- batch hint

  /**
   * The `{mode, handoffEpoch}` a `messages:batch` answered. A hint that
   * disagrees with the local state schedules one single-conversation
   * reconcile, at most once per conversation per `hintDebounceMs`; an
   * agreeing hint costs one local read and nothing else. Synchronous and
   * never throws.
   */
  hint(
    conversationRef: string,
    hint: { mode: LiveConversationMode; handoffEpoch: number },
  ): void {
    const senderId = senderIdFromRef(conversationRef);
    if (senderId === null) return;
    const task = this.evaluateHint(conversationRef, senderId, hint)
      .catch((error) => {
        this.logger.warn(
          `live reconcile hint check failed: ${describeError(error)}`,
        );
      })
      .finally(() => {
        this.hints.delete(task);
      });
    this.hints.add(task);
  }

  /** Resolves when every scheduled hint reconcile has finished (tests and
   *  shutdown). */
  async idle(): Promise<void> {
    while (this.hints.size > 0) await Promise.all([...this.hints]);
  }

  private async evaluateHint(
    ref: string,
    senderId: string,
    hint: { mode: LiveConversationMode; handoffEpoch: number },
  ): Promise<void> {
    const local = await this.ports.mode.getState(senderId);
    if (local.mode === hint.mode && local.epoch === hint.handoffEpoch) return;
    // Check and set in one synchronous section: a burst schedules one read.
    const now = this.clock();
    const until = this.hintUntil.get(ref);
    if (until !== undefined && now < until) return;
    if (this.hintUntil.size >= HINT_MAP_PRUNE_AT)
      for (const [key, expires] of this.hintUntil)
        if (expires <= now) this.hintUntil.delete(key);
    this.hintUntil.set(ref, now + this.hintDebounceMs);
    await this.reconcileOne(ref);
  }

  // ------------------------------------------------------------ apply

  private async applyBackend(
    ref: string,
    senderId: string,
    backend: BackendView,
    local: { mode: LiveConversationMode; epoch: number },
  ): Promise<Applied> {
    const masked = maskConversationRef(ref);
    if (backend.mode === 'HUMAN') {
      if (backend.requestId === null) {
        this.logger.warn(
          `backend lists ${masked} as HUMAN without a requestId: ignored`,
        );
        return 'in_sync';
      }
      if (backend.handoffEpoch <= local.epoch) return 'in_sync';
      // Missed `started` (rule 9): mute first (durable), then ack; never a
      // greeting.
      const applied = await this.ports.mode.applyStarted(
        senderId,
        backend.handoffEpoch,
        backend.requestId,
        { silent: true },
      );
      if (!applied.applied) return 'in_sync';
      this.logger.log(
        `missed conversation.started epoch ${backend.handoffEpoch} applied for ${masked}: muted, no greeting`,
      );
      await this.ackStarted(ref, backend.handoffEpoch);
      return 'started';
    }

    // Backend BOT.
    if (local.mode === 'HUMAN') {
      // Missed `ended` with farewell=false: keep the higher epoch (the CAS
      // is monotonic, so a lower backend epoch must not lose the local one).
      const epoch = Math.max(local.epoch, backend.handoffEpoch);
      // ENDING marker BEFORE the durable BOT (it survives that write), so no
      // window exists where the conversation is BOT without it. Only when a
      // `conversation.ended` item can still come: a backend that does not
      // know the conversation (404 → BOT/0, epoch 0 never had a session)
      // sends none, so a marker would silence the customer for its full
      // bound. When the item will carry a LOWER epoch than the one marked,
      // the marker records it (`coversEpoch`) so that item can clear it.
      const marked =
        backend.handoffEpoch > 0 &&
        (await this.markEnding(
          senderId,
          epoch,
          backend.handoffEpoch < epoch ? backend.handoffEpoch : undefined,
        ));
      const applied = await this.ports.mode.applyEnded(senderId, epoch);
      if (!applied.applied) {
        if (marked) await this.clearEnding(senderId, epoch);
        return 'in_sync';
      }
      this.logger.log(
        `missed conversation.ended applied for ${masked}: back to BOT at epoch ${epoch}, no farewell`,
      );
      try {
        await this.ports.replay(ref);
      } catch (error) {
        this.logger.warn(
          `held deliveries replay for ${masked} failed: ${describeError(error)}`,
        );
      }
      return 'ended';
    }
    // Both BOT: only an older local epoch is raised, so a late `started` of
    // an epoch that already ended can never mute the conversation again.
    if (backend.handoffEpoch > local.epoch) {
      await this.ports.mode.applyEnded(senderId, backend.handoffEpoch);
    }
    return 'in_sync';
  }

  /** Best effort: a failure is logged and the revert goes on without the
   *  marker (the order of a late farewell is not worth losing the revert). */
  private async markEnding(
    senderId: string,
    epoch: number,
    coversEpoch?: number,
  ): Promise<boolean> {
    if (this.ports.mode.markEnding === undefined) return false;
    try {
      return await this.ports.mode.markEnding(
        senderId,
        epoch,
        undefined,
        coversEpoch,
      );
    } catch (error) {
      this.logger.warn(
        `ENDING marker not set for ${maskConversationRef(senderId)}: ${describeError(error)}`,
      );
      return false;
    }
  }

  private async clearEnding(senderId: string, epoch: number): Promise<void> {
    try {
      await this.ports.mode.clearEnding?.(senderId, epoch);
    } catch (error) {
      this.logger.warn(
        `ENDING marker not cleared for ${maskConversationRef(senderId)}, its bound releases it: ${describeError(error)}`,
      );
    }
  }

  /** session-ack STARTED, best effort: a refusal is logged (the next run
   *  reconciles again), never retried, and never fails the pass. */
  private async ackStarted(ref: string, epoch: number): Promise<void> {
    try {
      const result = await this.ports.client.sessionAck(ref, {
        epoch,
        state: 'STARTED',
      });
      if (result.kind !== 'ok')
        this.logger.warn(
          `session-ack STARTED epoch ${epoch} for ${maskConversationRef(ref)} answered ${result.kind}; not retried`,
        );
    } catch (error) {
      this.logger.warn(
        `session-ack STARTED epoch ${epoch} for ${maskConversationRef(ref)} failed: ${describeError(error)}`,
      );
    }
  }
}
