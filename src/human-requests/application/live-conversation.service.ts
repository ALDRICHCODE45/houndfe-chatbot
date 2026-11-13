import { Logger } from '@nestjs/common';
import type {
  ConversationEndedItem,
  ConversationReassignedItem,
  ConversationStartedItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  SessionAckInput,
  SessionAckResult,
} from '../../chatbot-api/domain/dtos/live-conversation.dto';
import type { LiveConversationClient } from '../../chatbot-api/domain/live-conversation.port';
import type { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { describeError } from '../../common/log-safe';
import {
  LIVE_FAREWELL,
  LIVE_GREETING,
  LIVE_GREETING_NO_NAME,
  LIVE_REASSIGNED,
  LIVE_REASSIGNED_NO_NAME,
  LIVE_RESUME,
  liveNotice,
  maskConversationRef,
  senderIdFromRef,
  styleFixedCopy,
  type DeliveryDecision,
  type DeliveryRow,
} from '../domain/human-request-feed';

/** The three live items this service handles (staff messages and templates
 *  belong to the relay handler). */
export type ConversationLifecycleItem =
  | ConversationStartedItem
  | ConversationReassignedItem
  | ConversationEndedItem;

/** What happened to the notice, reported to `LivePlan.after` once the
 *  delivery outcome is durably recorded. */
export interface LiveSendResult {
  kind: 'ACCEPTED' | 'UNKNOWN' | 'NOT_SENT';
  providerMessageId: string | null;
}

interface LivePlanBase {
  decision: DeliveryDecision;
  /** Runs after the outcome is recorded (never before the notice). Failures
   *  are logged by the caller, never retried through the feed. */
  after?: (result: LiveSendResult) => Promise<void>;
  /** Replay the conversation's held / deferred deliveries after `after`. */
  replay?: boolean;
}

/** The delivery service executes the plan: notices are BOT messages, never
 *  held by HUMAN mode and never deferred (a closed window is STALE). */
export type LivePlan =
  | ({ action: 'stale' } & LivePlanBase)
  | ({ action: 'send'; senderId: string; text: string } & LivePlanBase);

export interface LiveConversationHandler {
  plan(row: DeliveryRow, item: ConversationLifecycleItem): Promise<LivePlan>;
}

export interface LiveConversationPorts {
  mode: Pick<
    HandoffModeService,
    'getState' | 'applyStarted' | 'applyEnded' | 'markGreeted'
  >;
  client: Pick<LiveConversationClient, 'sessionAck'>;
  /** Rejects when the read fails (transient, never "closed"). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
}

/**
 * Silence protocol, bot side (live conversation T4, contract rules 1, 6, 7
 * and the reassignment notice): started / reassigned / ended items.
 *
 * The inline, pre-send steps (durable mode compare-and-set, session-ack
 * STARTED, the window check) happen in `plan`, so a throw leaves the ledger
 * row RECEIVED and the feed retries the item (every step is idempotent: a
 * repeated CAS is a DUPLICATE, a repeated ack is a 200). The send, its
 * outcome and its ledger states are the delivery service's.
 */
export class LiveConversationService implements LiveConversationHandler {
  private readonly logger = new Logger(LiveConversationService.name);

  constructor(private readonly ports: LiveConversationPorts) {}

  async plan(
    row: DeliveryRow,
    item: ConversationLifecycleItem,
  ): Promise<LivePlan> {
    const senderId = senderIdFromRef(row.conversationRef);
    if (senderId === null || row.conversationRef === null) {
      this.logger.warn(
        `feed item ${row.deliveryId} (${item.type}) has no usable conversationRef: STALE`,
      );
      return { action: 'stale', decision: 'NO_CONVERSATION' };
    }
    switch (item.type) {
      case 'conversation.started':
        return this.started(row.conversationRef, senderId, item);
      case 'conversation.reassigned':
        return this.reassigned(senderId, item);
      case 'conversation.ended':
        return this.ended(row.conversationRef, senderId, item);
    }
  }

  // ------------------------------------------------------------ started

  private async started(
    ref: string,
    senderId: string,
    item: ConversationStartedItem,
  ): Promise<LivePlan> {
    const { handoffEpoch: epoch, requestId, staffFirstName } = item.payload;
    // 1. One durable compare-and-set to HUMAN, BEFORE the ack.
    const applied = await this.ports.mode.applyStarted(
      senderId,
      epoch,
      requestId,
    );
    if (!applied.applied) {
      if (applied.reason === 'INVALID')
        throw new Error('handoff state unusable: corrupt value or bad order');
      if (applied.reason === 'STALE_EPOCH') {
        this.logger.log(
          `conversation.started ${item.deliveryId} epoch ${epoch} is not newer than ours (${maskConversationRef(ref)}): STALE, no ack`,
        );
        return { action: 'stale', decision: 'STALE_EPOCH' };
      }
      // DUPLICATE: an earlier attempt of this same item already muted us
      // and then failed before deciding it; carry on with the ack.
    }

    // 2. Inline session-ack STARTED (never waits for Meta).
    const ack = await this.ports.client.sessionAck(ref, {
      epoch,
      state: 'STARTED',
    });
    if (ack.kind !== 'ok') {
      if (
        ack.kind === 'STALE_EPOCH' ||
        ack.kind === 'SESSION_NOT_ENDING' ||
        ack.kind === 'NOT_FOUND'
      ) {
        // A reconcile signal, never a retry: no greeting.
        this.logger.warn(
          `session-ack STARTED epoch ${epoch} answered ${ack.kind} (${maskConversationRef(ref)}): no greeting, STALE; reconcile decides`,
        );
        return { action: 'stale', decision: 'STALE_EPOCH' };
      }
      // Retryable (5xx, 429, timeout, network) or a credential problem: the
      // item is retried later, nothing is sent and nothing is ACKed yet.
      throw new Error(`session-ack STARTED failed: ${ack.kind}`);
    }

    // 3. Only after the 200: the greeting, if the window is open.
    if (!(await this.ports.isWindowOpen(senderId)))
      return { action: 'stale', decision: 'SESSION_STARTED' };
    const style = await this.readStyle(senderId);
    return {
      action: 'send',
      decision: 'SESSION_STARTED',
      senderId,
      text: liveNotice(
        LIVE_GREETING,
        LIVE_GREETING_NO_NAME,
        staffFirstName,
        style,
      ),
      // A greeting that really went out is what a START_TIMEOUT resume
      // notice depends on (an uncertain one does not count).
      after: async (result) => {
        if (result.kind === 'ACCEPTED')
          await this.ports.mode.markGreeted(senderId, epoch);
      },
    };
  }

  // --------------------------------------------------------- reassigned

  private async reassigned(
    senderId: string,
    item: ConversationReassignedItem,
  ): Promise<LivePlan> {
    const { handoffEpoch: epoch, staffFirstName } = item.payload;
    const state = await this.ports.mode.getState(senderId);
    if (state.epoch !== epoch)
      return { action: 'stale', decision: 'STALE_EPOCH' };
    if (state.mode !== 'HUMAN')
      return { action: 'stale', decision: 'SESSION_NOT_ACTIVE' };
    if (!(await this.ports.isWindowOpen(senderId)))
      return { action: 'stale', decision: 'WINDOW_CLOSED' };
    const style = await this.readStyle(senderId);
    return {
      action: 'send',
      decision: 'REASSIGNED_NOTICE',
      senderId,
      text: liveNotice(
        LIVE_REASSIGNED,
        LIVE_REASSIGNED_NO_NAME,
        staffFirstName,
        style,
      ),
    };
  }

  // -------------------------------------------------------------- ended

  private async ended(
    ref: string,
    senderId: string,
    item: ConversationEndedItem,
  ): Promise<LivePlan> {
    const {
      handoffEpoch: epoch,
      reason,
      farewell,
      resumeNotice,
    } = item.payload;
    // 1. Durable BOT (the epoch is kept) BEFORE anything is sent.
    const applied = await this.ports.mode.applyEnded(senderId, epoch);
    if (!applied.applied) {
      if (applied.reason === 'INVALID')
        throw new Error('handoff state unusable: corrupt value or bad order');
      if (applied.reason === 'STALE_EPOCH') {
        this.logger.log(
          `conversation.ended ${item.deliveryId} epoch ${epoch} is older than ours (${maskConversationRef(ref)}): STALE, no ack`,
        );
        return { action: 'stale', decision: 'STALE_EPOCH' };
      }
      // DUPLICATE: already BOT at this epoch (a retry of this item).
    }

    if (reason === 'START_TIMEOUT') {
      // A revert, not an end: no session-ack. The resume notice only
      // follows a greeting that actually went out for this epoch.
      if (resumeNotice) {
        const state = await this.ports.mode.getState(senderId);
        if (
          state.greetedEpoch === epoch &&
          (await this.ports.isWindowOpen(senderId))
        ) {
          const style = await this.readStyle(senderId);
          return {
            action: 'send',
            decision: 'RESUME_NOTICE',
            senderId,
            text: styleFixedCopy(LIVE_RESUME, style),
            replay: true,
          };
        }
      }
      return { action: 'stale', decision: 'SESSION_REVERTED', replay: true };
    }

    // The ack comes after the outcome; the replay after the ack, so the
    // farewell always precedes any replayed delivery.
    const after = (result: LiveSendResult) =>
      this.ackEnded(ref, epoch, result.providerMessageId);
    if (farewell && (await this.ports.isWindowOpen(senderId))) {
      const style = await this.readStyle(senderId);
      return {
        action: 'send',
        decision: 'FAREWELL',
        senderId,
        text: styleFixedCopy(LIVE_FAREWELL, style),
        after,
        replay: true,
      };
    }
    return {
      action: 'stale',
      decision: 'SESSION_ENDED',
      after,
      replay: true,
    };
  }

  /** session-ack ENDED, best effort: a 409 is a reconcile signal and a
   *  failure is not retried (the backend marks the session ENDED itself
   *  after its own timeout). Never throws. */
  private async ackEnded(
    ref: string,
    epoch: number,
    providerMessageId: string | null,
  ): Promise<void> {
    const input: SessionAckInput = {
      epoch,
      state: 'ENDED',
      ...(providerMessageId === null ? {} : { providerMessageId }),
    };
    let result: SessionAckResult;
    try {
      result = await this.ports.client.sessionAck(ref, input);
    } catch (error) {
      this.logger.warn(
        `session-ack ENDED epoch ${epoch} failed (${maskConversationRef(ref)}), not retried: ${describeError(error)}`,
      );
      return;
    }
    if (result.kind === 'ok') return;
    if (
      result.kind === 'STALE_EPOCH' ||
      result.kind === 'SESSION_NOT_ENDING' ||
      result.kind === 'NOT_FOUND'
    )
      this.logger.warn(
        `session-ack ENDED epoch ${epoch} answered ${result.kind} (${maskConversationRef(ref)}): reconcile signal, not retried`,
      );
    else
      this.logger.warn(
        `session-ack ENDED epoch ${epoch} failed with ${result.kind} (${maskConversationRef(ref)}), not retried`,
      );
  }

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }
}
