import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  isLiveConversationItem,
  isScheduledConversationItem,
  normalizeDeliveryOutcome,
  type FeedItem,
  type RecordDeliveryOutcomeResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import {
  checkHandoffSendHold,
  type HandoffModeReader,
} from '../../conversation/application/handoff-send-hold';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import type {
  LiveConversationHandler,
  LivePlan,
  LiveSendResult,
} from './live-conversation.service';
import type { SendResult } from '../../whatsapp/domain/whatsapp-sender.port';
import type { ScheduledConversationHandler } from './scheduled-conversation.service';
import {
  CANCEL_NOTICE,
  LEDGER_RETENTION_MS,
  OVERDUE_NOTICE,
  RETRY_AFTER_MAX_MS,
  ackBackoffMs,
  ackBodyFor,
  canonicalNow,
  classifyRelaySendError,
  isWindowClosedSendError,
  maskConversationRef,
  senderIdFromRef,
  styleFixedCopy,
  withTeamPrefix,
  type AckCompletion,
  type DeliveryDecision,
  type DeliveryExpectation,
  type DeliveryRow,
  type HumanRequestFeedStore,
} from '../domain/human-request-feed';
import {
  describeError,
  fingerprintMessageId,
  sanitizeErrorText,
} from '../../common/log-safe';

export interface HumanRequestDeliveryPorts {
  store: HumanRequestFeedStore;
  client: Pick<
    HumanRequestsClient,
    'recordDeliveryOutcome' | 'listPendingDeliveries'
  >;
  sender: Pick<WhatsappSenderPort, 'sendText'>;
  /** S4: required, so a missing reader can never skip the hold. */
  handoff: HandoffModeReader;
  /** 24 h window from the customer inbound observations; rejects when the
   *  read fails (transient, not a closed window). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
  /** Live conversation (T4/T5): started / reassigned / ended and the staff
   *  message / template relays. Without it those items stay the safe STALE
   *  of T1 (a claim reverts after its start timeout), so hand-built
   *  harnesses keep working. */
  live?: LiveConversationHandler;
  /** Scheduled conversations (unit 14): `conversation.scheduled_reminder`
   *  and `conversation.rescheduled`. Without it those items stay the safe
   *  STALE / UNKNOWN_TYPE (nothing is sent). */
  scheduled?: ScheduledConversationHandler;
}

export interface HumanRequestDeliveryOptions {
  clock?: () => Date;
  random?: () => number;
  newAttemptId?: () => string;
  /** A SENDING attempt older than this is a crash leftover (sweep only). */
  stuckSendingMs?: number;
  batchSize?: number;
  /** Terminal ledger rows older than this are purged (default 35 days). */
  retentionMs?: number;
  /** A `conversation.ended` still RECEIVED/SENDING for longer than this no
   *  longer holds the replays (a poison or crash-stuck item must not block
   *  a conversation forever). Default 10 min (the backend's ENDING timeout). */
  unfinishedEndMaxMs?: number;
  /** While HUMAN, at most one pending-deliveries read per conversation in
   *  this window (default 10 s): a customer typing several messages in a row
   *  costs one backend call. */
  humanLookupMinIntervalMs?: number;
}

/** Live conversation hooks of a plan: see `LivePlan`. */
interface LiveHooks {
  after?: LivePlan['after'];
  replay?: boolean;
  guard?: LivePlan['guard'];
}

type Plan =
  | ({ action: 'stale'; decision: DeliveryDecision } & LiveHooks)
  | ({
      action: 'send';
      decision: DeliveryDecision;
      senderId: string;
      text: string;
      /** Unit 10: clarification reply id, recorded with the sent message. */
      staffReplyId?: string;
      /** request.cancelled / request.overdue_notice: never a deferral (422
       *  OUTCOME_NOT_ALLOWED); a closed window is STALE. */
      cancellation: boolean;
      /** request.overdue_notice: a HUMAN-mode hold is an immediate STALE
       *  (HUMAN_SESSION), never a local hold. */
      overdue?: boolean;
      /** Live notice (greeting, reassignment, farewell, resume): sent while
       *  the mode is HUMAN, so the HUMAN hold does not apply. */
      live?: boolean;
    } & LiveHooks)
  | ({
      /** Staff message / template: sent by `deliver` (never mirrored), never
       *  held by HUMAN mode; see `LivePlan`. */
      action: 'relay';
      decision: DeliveryDecision;
      senderId: string;
      deliver: () => Promise<SendResult>;
      dispose?: () => Promise<void>;
      deferrable: boolean;
    } & LiveHooks);

/**
 * Handles one feed item locally and owns its outcome ACK (S2–S5,
 * docs/human-request-feed.md). The ledger row is written before Meta is
 * called; every state change is a compare-and-set on (state, attempt), so a
 * delivery is sent at most once even when the consumer, a replay and the
 * sweeper meet on the same row. ACKs are durable: a PENDING ACK is replayed
 * with the same body until the backend answers.
 */
export class HumanRequestDeliveryService {
  private readonly logger = new Logger(HumanRequestDeliveryService.name);
  private readonly clock: () => Date;
  private readonly random: () => number;
  private readonly newAttemptId: () => string;
  private readonly stuckSendingMs: number;
  private readonly batchSize: number;
  private readonly retentionMs: number;
  private readonly unfinishedEndMaxMs: number;
  private readonly humanLookupMinIntervalMs: number;
  /** conversationRef → earliest time of the next HUMAN-mode backend read. */
  private readonly humanLookupAfter = new Map<string, number>();
  /** Conversations whose unfinished-end hold was already logged (once). */
  private readonly endHoldLogged = new Set<string>();
  private readonly endHoldExpiredLogged = new Set<string>();

  constructor(
    private readonly ports: HumanRequestDeliveryPorts,
    options: HumanRequestDeliveryOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.newAttemptId = options.newAttemptId ?? randomUUID;
    this.stuckSendingMs = options.stuckSendingMs ?? 10 * 60_000;
    this.batchSize = options.batchSize ?? 50;
    this.retentionMs = options.retentionMs ?? LEDGER_RETENTION_MS;
    this.unfinishedEndMaxMs = options.unfinishedEndMaxMs ?? 10 * 60_000;
    this.humanLookupMinIntervalMs = options.humanLookupMinIntervalMs ?? 10_000;
  }

  /** Feed consumer entry: records the item (or finds it) and handles it.
   *  Throws on a transient local failure so the page is read again. */
  async accept(item: FeedItem): Promise<void> {
    const { row } = await this.ports.store.insertDelivery(item);
    await this.process(row, 'feed');
  }

  /**
   * S5 window replay, called when the customer writes again: delivers the
   * backend's deferred deliveries for the conversation, then this
   * conversation's local DEFERRED_WINDOW rows (also those whose deferral the
   * backend never recorded) and HELD_HUMAN rows if it is BOT again; each
   * deliveryId at most once per call, with a new attemptId. Never throws.
   */
  async onCustomerInbound(conversationRef: string): Promise<void> {
    if (senderIdFromRef(conversationRef) === null) return;
    const masked = maskConversationRef(conversationRef);
    const handled = new Set<string>();
    const replay = async (row: DeliveryRow) => {
      if (handled.has(row.deliveryId)) return;
      handled.add(row.deliveryId);
      await this.safely(row.deliveryId, () => this.process(row, 'replay'));
    };
    try {
      const lookupStartedAt = this.clock();
      const pending = await this.ports.client.listPendingDeliveries({
        conversationRef,
      });
      if (pending.kind === 'ok') {
        for (const item of pending.items)
          await this.safely(item.deliveryId, async () => {
            const { row } = await this.ports.store.insertDelivery(item);
            await replay(await this.reopenDeferred(row, item, lookupStartedAt));
          });
      } else {
        this.logger.warn(`pending deliveries rate limited for ${masked}`);
      }
    } catch (error) {
      this.logger.warn(
        `pending deliveries read failed for ${masked}: ${describeError(error)}`,
      );
    }
    const filter = { conversationRef, limit: this.batchSize };
    for (const [name, list] of [
      ['deferred', () => this.ports.store.listDeferredWindow(filter)],
      ['held', () => this.ports.store.listHeld(filter)],
    ] as const) {
      try {
        for (const row of await list()) await replay(row);
      } catch (error) {
        this.logger.warn(
          `${name} deliveries read failed for ${masked}: ${describeError(error)}`,
        );
      }
    }
  }

  /**
   * Live conversation (rule 4, contract "Deferred staff messages"): the
   * customer wrote while the conversation is HUMAN. The bot says nothing and
   * releases no held `request.*` row, but a staff message deferred because
   * the 24 h window was closed is resent now (the customer just reopened
   * it): the backend's `WINDOW_CLOSED` deferrals (also a message Meta
   * accepted and later failed with 131047, whose local row is SENT) plus the
   * local DEFERRED_WINDOW staff messages, in `seq` order, each with a new
   * attemptId. Cost (S1): one local read, and at most one pending-deliveries
   * call per conversation per `humanLookupMinIntervalMs`. Never throws.
   */
  async onHumanCustomerInbound(conversationRef: string): Promise<void> {
    if (senderIdFromRef(conversationRef) === null) return;
    const masked = maskConversationRef(conversationRef);
    const rows = new Map<string, DeliveryRow>();
    try {
      const local = await this.ports.store.listDeferredWindow({
        conversationRef,
        limit: this.batchSize,
      });
      for (const row of local)
        if (row.item.type === 'conversation.staff_message')
          rows.set(row.deliveryId, row);
    } catch (error) {
      this.logger.warn(
        `deferred deliveries read failed for ${masked}: ${describeError(error)}`,
      );
    }
    if (this.humanLookupDue(conversationRef)) {
      try {
        const lookupStartedAt = this.clock();
        const pending = await this.ports.client.listPendingDeliveries({
          conversationRef,
        });
        if (pending.kind === 'ok') {
          for (const item of pending.items) {
            if (
              item.type !== 'conversation.staff_message' ||
              item.deferredReason !== 'WINDOW_CLOSED'
            )
              continue;
            await this.safely(item.deliveryId, async () => {
              const { row } = await this.ports.store.insertDelivery(item);
              rows.set(
                row.deliveryId,
                await this.reopenDeferred(row, item, lookupStartedAt),
              );
            });
          }
        } else {
          // Not answered: the next inbound asks again.
          this.humanLookupAfter.delete(conversationRef);
          this.logger.warn(`pending deliveries rate limited for ${masked}`);
        }
      } catch (error) {
        this.humanLookupAfter.delete(conversationRef);
        this.logger.warn(
          `pending deliveries read failed for ${masked}: ${describeError(error)}`,
        );
      }
    }
    const ordered = [...rows.values()].sort(
      (a, b) => seqOf(a.item) - seqOf(b.item),
    );
    for (const row of ordered)
      await this.safely(row.deliveryId, () => this.process(row, 'replay'));
  }

  /** `true` (and arms the throttle) when this conversation's pending
   *  deliveries may be read now while HUMAN. */
  private humanLookupDue(conversationRef: string): boolean {
    const now = this.clock().getTime();
    const after = this.humanLookupAfter.get(conversationRef);
    if (after !== undefined && now < after) return false;
    if (this.humanLookupAfter.size >= 500)
      for (const [ref, until] of this.humanLookupAfter)
        if (until <= now) this.humanLookupAfter.delete(ref);
    this.humanLookupAfter.set(
      conversationRef,
      now + this.humanLookupMinIntervalMs,
    );
    return true;
  }

  /**
   * B2: the backend lists a live staff message as deferred (WINDOW_CLOSED)
   * although the local row is SENT/UNKNOWN: Meta accepted it and later
   * failed it with 131047, which the backend turned into a deferral again.
   * The row moves to DEFERRED_WINDOW (compare-and-set, no ACK owed: the
   * backend already knows) so the next replay resends it with a new
   * attemptId. Only a settled ACK counts: a PENDING ACK means the backend
   * has not heard of the outcome yet (resending would duplicate the message),
   * and a FAILED_PERMANENT one (409 OUTCOME_ALREADY_RECORDED: "not coming")
   * stops it for good. Anything else is returned untouched.
   *
   * Stale listing guard: the listed item carries no attempt evidence (no
   * attemptId / attemptedAt), so a listing fetched before another replayer
   * resent the row and ACKed it would reopen a message that was just resent
   * (a double send). The row is only reopened when it was last written
   * strictly before the lookup started: a write at or after that instant
   * (the resend, its ACK) may already answer the listed deferral, so the
   * row is left alone and the next lookup, which proves the deferral again
   * if it still stands, decides.
   */
  private async reopenDeferred(
    row: DeliveryRow,
    listed: FeedItem,
    lookupStartedAt: Date,
  ): Promise<DeliveryRow> {
    if (
      listed.type !== 'conversation.staff_message' ||
      listed.deferredReason !== 'WINDOW_CLOSED' ||
      (row.localState !== 'SENT' && row.localState !== 'UNKNOWN') ||
      row.ackState !== 'ACKED'
    )
      return row;
    if (row.updatedAt.getTime() >= lookupStartedAt.getTime()) return row;
    const next = await this.ports.store.transition(
      row.deliveryId,
      { localState: row.localState, attemptId: row.attemptId },
      {
        localState: 'DEFERRED_WINDOW',
        decision: row.decision,
        attemptId: this.newAttemptId(),
        attemptedAt: canonicalNow(this.clock),
        providerMessageId: null,
        ack: null,
      },
    );
    if (next === null) return row;
    this.logger.log(
      `staff message ${row.deliveryId} failed after Meta accepted it (window closed): deferred again`,
    );
    return next;
  }

  /**
   * A feed item whose handling keeps failing (poison item): records a
   * terminal local failure so the feed can move on, never resending. A
   * RECEIVED row (nothing sent, but a delivery may still be owed) becomes
   * UNKNOWN / LOCAL_FAILURE with an ACK DELIVERY_UNKNOWN, so staff sees it
   * "to reconcile" (STALE would mean nothing needs to be sent); a SENDING row is left to `recoverStuckSending` (DELIVERY_UNKNOWN);
   * an already decided row keeps its state. With no ledger row at all (the
   * insert itself fails) nothing can have been sent: one inline ACK STALE.
   * Rejects when the ledger cannot be read, so the page stays stuck.
   */
  async abandon(item: FeedItem, reason: string): Promise<void> {
    const row = await this.ports.store.getDelivery(item.deliveryId);
    const attemptedAt = canonicalNow(this.clock);
    if (row === null) {
      this.logger.error(
        `feed item ${item.deliveryId} abandoned with no ledger row after repeated failures (${reason}): ACK STALE`,
      );
      const body = {
        outcome: 'STALE' as const,
        attemptId: this.newAttemptId(),
        attemptedAt,
      };
      try {
        await this.ports.client.recordDeliveryOutcome(item.deliveryId, body);
      } catch (error) {
        this.logger.warn(
          `delivery ${item.deliveryId} abandon ACK failed: ${describeError(error)}`,
        );
      }
      return;
    }
    if (row.localState !== 'RECEIVED') {
      this.logger.error(
        `feed item ${item.deliveryId} abandoned after repeated failures (${reason}); its ${row.localState} row is left as is`,
      );
      return;
    }
    const next = await this.ports.store.transition(
      row.deliveryId,
      { localState: 'RECEIVED', attemptId: row.attemptId },
      {
        localState: 'UNKNOWN',
        decision: 'LOCAL_FAILURE',
        attemptId: this.newAttemptId(),
        attemptedAt,
        providerMessageId: null,
        ack: 'DELIVERY_UNKNOWN',
      },
    );
    this.logger.error(
      `feed item ${item.deliveryId} abandoned after repeated failures (${reason}): nothing sent, DELIVERY_UNKNOWN / LOCAL_FAILURE for staff to reconcile`,
    );
    if (next !== null) await this.flushAck(next);
  }

  /** Retention: purges terminal ledger rows older than the retention. */
  purgeLedger(): Promise<{ deleted: number; scrubbed: number }> {
    return this.ports.store.purgeTerminal(
      new Date(this.clock().getTime() - this.retentionMs),
      this.batchSize * 10,
    );
  }

  /** Retries due PENDING ACKs with their stored body; returns how many. */
  async sweepAcks(): Promise<number> {
    const due = await this.ports.store.listDueAcks(
      this.clock(),
      this.batchSize,
    );
    for (const row of due) await this.flushAck(row);
    return due.length;
  }

  /** Re-handles HELD_HUMAN rows whose conversation is BOT again; returns
   *  how many left the hold. */
  async replayHeld(): Promise<number> {
    const held = await this.ports.store.listHeld({ limit: this.batchSize });
    let released = 0;
    for (const row of held) {
      let left = false;
      await this.safely(row.deliveryId, async () => {
        left = await this.process(row, 'replay');
      });
      if (left) released += 1;
      // Still held (or failed): move it behind the others, so held rows of
      // conversations that stay HUMAN never starve the rest.
      else
        await this.safely(row.deliveryId, () =>
          this.ports.store.touchHeld(row.deliveryId, row.attemptId),
        );
    }
    return released;
  }

  /** A SENDING row left by a crash is uncertain: DELIVERY_UNKNOWN with the
   *  same attempt, never a resend. */
  async recoverStuckSending(): Promise<number> {
    const before = new Date(this.clock().getTime() - this.stuckSendingMs);
    const stuck = await this.ports.store.listStuckSending(
      before,
      this.batchSize,
    );
    let recovered = 0;
    for (const row of stuck) {
      const next = await this.ports.store.transition(
        row.deliveryId,
        { localState: 'SENDING', attemptId: row.attemptId },
        {
          localState: 'UNKNOWN',
          decision: row.decision,
          attemptId: row.attemptId ?? this.newAttemptId(),
          attemptedAt: row.attemptedAt ?? canonicalNow(this.clock),
          providerMessageId: null,
          ack: 'DELIVERY_UNKNOWN',
        },
      );
      if (next === null) continue;
      recovered += 1;
      this.logger.warn(
        `delivery ${row.deliveryId} interrupted while sending: DELIVERY_UNKNOWN`,
      );
      await this.flushAck(next);
    }
    return recovered;
  }

  /**
   * Rule 6 hold with a bound (L13 a): `true` while a `conversation.ended` of
   * the conversation is still RECEIVED/SENDING and was written less than
   * `unfinishedEndMaxMs` ago. An older one (a poison item, a crash leftover)
   * stops holding, so the conversation's held and deferred rows are never
   * blocked forever. Applying and expiring the hold are each logged once per
   * conversation (no phone: masked ref).
   */
  private async endHolds(conversationRef: string): Promise<boolean> {
    const newest =
      await this.ports.store.newestUnfinishedEndAt(conversationRef);
    if (newest === null) {
      this.endHoldLogged.delete(conversationRef);
      return false;
    }
    const masked = maskConversationRef(conversationRef);
    const minutes = Math.round(this.unfinishedEndMaxMs / 60_000);
    if (newest.getTime() >= this.clock().getTime() - this.unfinishedEndMaxMs) {
      if (this.rememberOnce(this.endHoldLogged, conversationRef))
        this.logger.log(
          `deliveries of ${masked} wait: a conversation.ended is still being handled (held for at most ${minutes} min)`,
        );
      return true;
    }
    this.endHoldLogged.delete(conversationRef);
    if (this.rememberOnce(this.endHoldExpiredLogged, conversationRef))
      this.logger.warn(
        `a conversation.ended of ${masked} has been unfinished for over ${minutes} min: it no longer holds the replays`,
      );
    return false;
  }

  /** Adds to a bounded set; `true` when it was not there yet. */
  private rememberOnce(set: Set<string>, key: string): boolean {
    if (set.has(key)) return false;
    if (set.size >= 1000) set.clear();
    set.add(key);
    return true;
  }

  /** `true` when the row was (re)decided. */
  private async process(
    row: DeliveryRow,
    mode: 'feed' | 'replay',
  ): Promise<boolean> {
    switch (row.localState) {
      case 'RECEIVED':
        return this.run(row, mode === 'replay');
      case 'HELD_HUMAN':
      case 'DEFERRED_WINDOW':
        if (mode === 'replay') return this.run(row, true);
        break;
      // SENDING: in flight elsewhere or a crash leftover (the sweep decides).
      default:
        break;
    }
    if (row.ackState === 'PENDING') await this.flushAck(row);
    return false;
  }

  private async run(row: DeliveryRow, replay: boolean): Promise<boolean> {
    const plan = await this.plan(row);
    try {
      return await this.execute(row, plan, replay);
    } finally {
      if (plan.action === 'relay' && plan.dispose !== undefined) {
        try {
          await plan.dispose();
        } catch (error) {
          this.logger.warn(
            `delivery ${row.deliveryId} cleanup failed: ${describeError(error)}`,
          );
        }
      }
    }
  }

  private async execute(
    row: DeliveryRow,
    plan: Plan,
    replay: boolean,
  ): Promise<boolean> {
    const expected = { localState: row.localState, attemptId: row.attemptId };
    const attemptedAt = canonicalNow(this.clock);

    if (plan.action === 'stale') {
      const next = await this.ports.store.transition(row.deliveryId, expected, {
        localState: 'STALE',
        decision: plan.decision,
        attemptId: this.newAttemptId(),
        attemptedAt,
        providerMessageId: null,
        ack: 'STALE',
      });
      if (next !== null) {
        await this.flushAck(next);
        await this.finishLive(plan, row, {
          kind: 'NOT_SENT',
          providerMessageId: null,
        });
      }
      return next !== null;
    }

    const hold =
      plan.action === 'relay' || plan.live === true
        ? ({ hold: false } as const)
        : await checkHandoffSendHold(this.ports.handoff, plan.senderId);
    if (hold.hold && hold.reason === 'MODE_UNREADABLE')
      throw new Error(`handoff mode unreadable: ${hold.error}`);
    // Rule 2: a delivery that may not wait (a cancellation notice, an overdue
    // notice) is never held: the backend refuses its deferral (422) and a
    // closure notice hours later only annoys, so it is STALE right away.
    if (
      hold.hold &&
      plan.action === 'send' &&
      (plan.overdue === true || plan.cancellation)
    ) {
      const next = await this.ports.store.transition(row.deliveryId, expected, {
        localState: 'STALE',
        decision: 'HUMAN_SESSION',
        attemptId: this.newAttemptId(),
        attemptedAt,
        providerMessageId: null,
        ack: 'STALE',
      });
      if (next !== null) await this.flushAck(next);
      return next !== null;
    }
    if (hold.hold) {
      if (row.localState === 'HELD_HUMAN') return false;
      const next = await this.ports.store.transition(row.deliveryId, expected, {
        localState: 'HELD_HUMAN',
        decision: plan.decision,
        attemptId: this.newAttemptId(),
        attemptedAt,
        providerMessageId: null,
        ack: 'DEFERRED_HUMAN_SESSION',
      });
      if (next?.ackState === 'PENDING') await this.flushAck(next);
      return false;
    }

    // Rule 6 order: a conversation whose `ended` is still being handled is
    // already BOT, but its farewell may not be out. A replay (the maintenance
    // sweep, the customer's next message) waits: the row stays as it is and
    // the ended item's own replay releases it after the farewell.
    if (
      replay &&
      plan.action === 'send' &&
      plan.live !== true &&
      row.conversationRef !== null &&
      (await this.endHolds(row.conversationRef))
    )
      return false;

    // T6 (L10 a): live sends re-read the mode/epoch right before the
    // sender, one local read. The read sits just before the SENDING claim
    // (a failed read throws with nothing claimed, so the item is retried).
    // Scheduled notices carry a guard too (window and schedule re-read), but
    // are not live: the HUMAN hold above already ran for them.
    if (plan.guard !== undefined) {
      const changed = await plan.guard();
      if (changed !== null) {
        const next = await this.ports.store.transition(
          row.deliveryId,
          expected,
          {
            localState: 'STALE',
            decision: changed,
            attemptId: this.newAttemptId(),
            attemptedAt,
            providerMessageId: null,
            ack: 'STALE',
          },
        );
        this.logger.log(
          `delivery ${row.deliveryId} ${row.type} not sent: the conversation changed after planning (${changed})`,
        );
        if (next !== null) {
          await this.flushAck(next);
          await this.finishLive(plan, row, {
            kind: 'NOT_SENT',
            providerMessageId: null,
          });
        }
        return next !== null;
      }
    }

    const attemptId = this.newAttemptId();
    const sending = await this.ports.store.transition(
      row.deliveryId,
      expected,
      {
        localState: 'SENDING',
        decision: plan.decision,
        attemptId,
        attemptedAt,
        providerMessageId: null,
        ack: null,
      },
    );
    if (sending === null) return false;
    const claimed = { localState: 'SENDING' as const, attemptId };
    const base = { decision: plan.decision, attemptId, attemptedAt };

    let providerMessageId: string;
    try {
      ({ providerMessageId } =
        plan.action === 'relay'
          ? await plan.deliver()
          : await this.ports.sender.sendText({
              to: plan.senderId,
              text: plan.text,
              ...(plan.staffReplyId === undefined
                ? {}
                : { staffReplyId: plan.staffReplyId }),
            }));
    } catch (error) {
      if (plan.action === 'relay')
        return this.relayFailed(row, plan, claimed, base, error);
      const windowClosed = isWindowClosedSendError(error);
      if (!windowClosed)
        this.logger.warn(
          `delivery ${row.deliveryId} send uncertain: ${describeError(error)}`,
        );
      const next = await this.ports.store.transition(row.deliveryId, claimed, {
        ...base,
        providerMessageId: null,
        ...(!windowClosed
          ? { localState: 'UNKNOWN', ack: 'DELIVERY_UNKNOWN' }
          : plan.cancellation
            ? {
                localState: 'STALE',
                decision: 'WINDOW_CLOSED',
                ack: 'STALE',
              }
            : { localState: 'DEFERRED_WINDOW', ack: 'DEFERRED_WINDOW_CLOSED' }),
      });
      if (next !== null) await this.flushAck(next);
      await this.finishLive(plan, row, {
        kind: windowClosed ? 'NOT_SENT' : 'UNKNOWN',
        providerMessageId: null,
      });
      return true;
    }
    const sent = await this.ports.store.transition(row.deliveryId, claimed, {
      ...base,
      localState: 'SENT',
      providerMessageId,
      ack: 'PROVIDER_ACCEPTED',
    });
    if (sent === null)
      this.logger.error(
        `delivery ${row.deliveryId} sent (${fingerprintMessageId(providerMessageId)}) but its row moved on`,
      );
    else await this.flushAck(sent);
    await this.finishLive(plan, row, { kind: 'ACCEPTED', providerMessageId });
    return true;
  }

  /** A relay (staff message / template) whose send failed: a closed window
   *  defers a staff message (never a template); a definite non-send (upload
   *  failure, Meta's synchronous refusal) is STALE / SEND_REFUSED so the
   *  attendee sees "No enviado"; anything else is DELIVERY_UNKNOWN. Never
   *  resent by the bot. */
  private async relayFailed(
    row: DeliveryRow,
    plan: Extract<Plan, { action: 'relay' }>,
    claimed: DeliveryExpectation,
    base: {
      decision: DeliveryDecision;
      attemptId: string;
      attemptedAt: string;
    },
    error: unknown,
  ): Promise<boolean> {
    const failure = classifyRelaySendError(error);
    const deferred = failure === 'WINDOW_CLOSED' && plan.deferrable;
    const outcome = deferred
      ? ({
          localState: 'DEFERRED_WINDOW',
          ack: 'DEFERRED_WINDOW_CLOSED',
        } as const)
      : failure === 'UNCERTAIN'
        ? ({ localState: 'UNKNOWN', ack: 'DELIVERY_UNKNOWN' } as const)
        : ({
            localState: 'STALE',
            decision: 'SEND_REFUSED',
            ack: 'STALE',
          } as const);
    this.logger.warn(
      `delivery ${row.deliveryId} ${row.type} send ${deferred ? 'deferred (window closed)' : failure === 'UNCERTAIN' ? 'uncertain' : 'refused'}: ${describeError(error)}`,
    );
    const next = await this.ports.store.transition(row.deliveryId, claimed, {
      ...base,
      providerMessageId: null,
      ...outcome,
    });
    if (next !== null) await this.flushAck(next);
    await this.finishLive(plan, row, {
      kind: outcome.localState === 'UNKNOWN' ? 'UNKNOWN' : 'NOT_SENT',
      providerMessageId: null,
    });
    return true;
  }

  /** Live conversation tail of a decided item, in contract order: the hook
   *  (greeting record, session-ack ENDED) and then the replay of what the
   *  HUMAN session held back. The outcome is already recorded, so a failure
   *  here is logged and never re-runs the item. Never throws. */
  private async finishLive(
    plan: Plan,
    row: DeliveryRow,
    result: LiveSendResult,
  ): Promise<void> {
    if (plan.after !== undefined) {
      try {
        await plan.after(result);
      } catch (error) {
        this.logger.warn(
          `delivery ${row.deliveryId} live follow-up failed: ${describeError(error)}`,
        );
      }
    }
    if (plan.replay === true && row.conversationRef !== null) {
      try {
        await this.onCustomerInbound(row.conversationRef);
      } catch (error) {
        this.logger.warn(
          `delivery ${row.deliveryId} held deliveries replay failed: ${describeError(error)}`,
        );
      }
    }
  }

  private async plan(row: DeliveryRow): Promise<Plan> {
    const item = row.item;
    if (item.type === 'unknown') {
      if (item.rawType === 'request.merged') {
        // Never log the raw item: it carries the customer's conversationRef.
        this.logger.warn(
          `feed item ${row.deliveryId} request.merged was malformed: ACK STALE; the merged request may stay open in the registry`,
        );
        return { action: 'stale', decision: 'UNKNOWN_TYPE' };
      }
      this.logger.warn(
        `feed item ${row.deliveryId} of unknown type ${sanitizeErrorText(item.rawType)}: STALE`,
      );
      return { action: 'stale', decision: 'UNKNOWN_TYPE' };
    }

    if (isLiveConversationItem(item)) {
      if (this.ports.live !== undefined) {
        const live = await this.ports.live.plan(row, item);
        return live.action === 'send'
          ? { ...live, cancellation: true, live: true }
          : live;
      }
      // Without a handler wired, live items behave exactly as before the
      // parser knew them (unknown type: nothing sent, ACK STALE), which is
      // safe for a claim: the backend reverts it after the start timeout.
      this.logger.warn(
        `feed item ${row.deliveryId} of live conversation type ${item.type} has no handler wired: STALE`,
      );
      return { action: 'stale', decision: 'UNKNOWN_TYPE' };
    }

    if (isScheduledConversationItem(item)) {
      if (this.ports.scheduled !== undefined) {
        const planned = await this.ports.scheduled.plan(row, item);
        // A notice that may not wait: HUMAN mode is an immediate STALE
        // (HUMAN_SESSION), a closed window is STALE, never a deferral.
        return planned.action === 'send'
          ? { ...planned, cancellation: true }
          : planned.action === 'stale'
            ? planned
            : { action: 'stale', decision: 'UNKNOWN_TYPE' };
      }
      this.logger.warn(
        `feed item ${row.deliveryId} of type ${item.type} has no handler wired: STALE`,
      );
      return { action: 'stale', decision: 'UNKNOWN_TYPE' };
    }

    if (item.type === 'request.answered') {
      const payload = item.payload;
      // L4: the legacy poll paths deliver wrapped decisions.
      if (payload.kind === 'DECISION')
        return { action: 'stale', decision: 'LEGACY_PATH_DELIVERS' };
      if (payload.kind !== 'CLARIFICATION') {
        this.logger.warn(
          `feed item ${row.deliveryId} with unrecognized answer kind ${sanitizeErrorText(String(payload.raw.kind))}: STALE`,
        );
        return { action: 'stale', decision: 'UNKNOWN_KIND' };
      }
      const senderId = this.recipient(row);
      if (senderId === null)
        return { action: 'stale', decision: 'NO_CONVERSATION' };
      const style = await this.readStyle(senderId);
      // The question is answered (the request is already RESOLVED upstream).
      await this.ports.store.closeRequest(item.requestId, 'RESOLVED');
      return {
        action: 'send',
        decision: 'CLARIFICATION',
        senderId,
        text: withTeamPrefix(payload.text, payload.prefix, style),
        ...(payload.replyId === undefined
          ? {}
          : { staffReplyId: payload.replyId }),
        cancellation: false,
      };
    }

    if (item.type === 'request.merged') {
      // Informational: staff folded this request into another open one; the
      // target keeps the customer's question, so nothing is sent.
      await this.ports.store.closeRequest(item.requestId, 'CANCELLED');
      this.logger.log(
        `request ${item.requestId} merged into ${item.payload.intoRequestId}: STALE`,
      );
      return { action: 'stale', decision: 'DUPLICATE' };
    }

    if (item.type === 'request.overdue_notice') {
      // The request stays open in the registry; the customer is told once.
      // A request this bot already saw closed (cancelled, merged, answered)
      // must not get "sigue pendiente", e.g. when a backlog drains late.
      const known = await this.ports.store.getRequest(item.requestId);
      if (known !== null && known.status !== 'OPEN')
        return { action: 'stale', decision: 'REQUEST_CLOSED' };
      const senderId = this.recipient(row);
      if (senderId === null)
        return { action: 'stale', decision: 'NO_CONVERSATION' };
      if (!(await this.ports.isWindowOpen(senderId)))
        return { action: 'stale', decision: 'WINDOW_CLOSED' };
      const style = await this.readStyle(senderId);
      return {
        action: 'send',
        decision: 'OVERDUE_NOTICE',
        senderId,
        text: styleFixedCopy(OVERDUE_NOTICE, style),
        cancellation: true,
        overdue: true,
      };
    }

    // request.cancelled: forget the request's pending state first.
    const payload = item.payload;
    await this.ports.store.closeRequest(payload.requestId, 'CANCELLED');
    if (payload.reason === 'DUPLICATE')
      return { action: 'stale', decision: 'DUPLICATE' };
    const senderId = this.recipient(row);
    if (senderId === null)
      return { action: 'stale', decision: 'NO_CONVERSATION' };
    if (!(await this.ports.isWindowOpen(senderId)))
      return { action: 'stale', decision: 'WINDOW_CLOSED' };
    const style = await this.readStyle(senderId);
    const note = payload.customerNote?.trim() ? payload.customerNote : null;
    return {
      action: 'send',
      decision: 'CANCEL_NOTICE',
      senderId,
      text:
        note === null
          ? styleFixedCopy(CANCEL_NOTICE, style)
          : withTeamPrefix(note, null, style),
      cancellation: true,
    };
  }

  private recipient(row: DeliveryRow): string | null {
    const senderId = senderIdFromRef(row.conversationRef);
    if (senderId === null)
      this.logger.warn(
        `feed item ${row.deliveryId} needs a send but has no usable conversationRef: STALE`,
      );
    return senderId;
  }

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }

  /** One ACK attempt with the row's stored body. Never throws: a failure
   *  leaves the ACK PENDING for the sweeper. */
  private async flushAck(row: DeliveryRow): Promise<void> {
    if (row.ackState !== 'PENDING' || row.attemptId === null) return;
    const body = normalizeDeliveryOutcome(ackBodyFor(row));
    let completion: AckCompletion;
    if (body === null) {
      this.logger.error(
        `delivery ${row.deliveryId} has an invalid ${row.ackOutcome} ACK body: FAILED_PERMANENT`,
      );
      completion = { ackState: 'FAILED_PERMANENT', error: 'invalid body' };
    } else {
      let result: RecordDeliveryOutcomeResult | Error;
      try {
        result = await this.ports.client.recordDeliveryOutcome(
          row.deliveryId,
          body,
        );
      } catch (error) {
        result = error instanceof Error ? error : new Error(String(error));
      }
      completion = this.completionFor(row, result);
    }
    try {
      await this.ports.store.completeAck(
        row.deliveryId,
        row.attemptId,
        completion,
      );
    } catch (error) {
      this.logger.warn(
        `delivery ${row.deliveryId} ACK state not saved: ${describeError(error)}`,
      );
    }
  }

  private completionFor(
    row: DeliveryRow,
    result: RecordDeliveryOutcomeResult | Error,
  ): AckCompletion {
    const retryAt = (ms: number) => new Date(this.clock().getTime() + ms);
    if (result instanceof Error) {
      this.logger.warn(
        `delivery ${row.deliveryId} ACK failed, will retry: ${describeError(result)}`,
      );
      return {
        ackState: 'PENDING',
        retryAt: retryAt(ackBackoffMs(row.ackAttempts + 1, this.random)),
        error: describe(result),
      };
    }
    if (result.kind === 'ok') return { ackState: 'ACKED' };
    if (result.kind === 'RATE_LIMITED')
      return {
        ackState: 'PENDING',
        retryAt: retryAt(
          result.retryAfterSeconds === null
            ? ackBackoffMs(row.ackAttempts + 1, this.random)
            : Math.min(result.retryAfterSeconds * 1000, RETRY_AFTER_MAX_MS),
        ),
        error: 'RATE_LIMITED',
      };
    // IDEMPOTENCY_CONFLICT, OUTCOME_ALREADY_RECORDED, OUTCOME_NOT_ALLOWED,
    // NOT_FOUND or a rejected body: retrying the same body cannot succeed.
    // A rejected DEFERRED_HUMAN_SESSION (live since 5c) is a real error too;
    // the row stays HELD_HUMAN locally and is still replayed once BOT.
    const reason =
      result.kind === 'VALIDATION_ERROR'
        ? `VALIDATION_ERROR ${result.message ?? ''}`.trim()
        : result.kind;
    this.logger.error(
      `delivery ${row.deliveryId} ${row.ackOutcome} ACK rejected (${sanitizeErrorText(reason)}): FAILED_PERMANENT`,
    );
    return { ackState: 'FAILED_PERMANENT', error: reason };
  }

  private async safely(id: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      this.logger.warn(`delivery ${id} replay failed: ${describeError(error)}`);
    }
  }
}

/** `seq` of a live staff message (ordering key; others sort last). */
const seqOf = (item: FeedItem): number =>
  item.type === 'conversation.staff_message'
    ? item.payload.seq
    : Number.MAX_SAFE_INTEGER;

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
