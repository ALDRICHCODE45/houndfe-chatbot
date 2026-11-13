import { Inject, Injectable } from '@nestjs/common';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../domain/conversation-store';
import type {
  HandoffApplyResult,
  HandoffState,
  HandoffTransition,
  HumanHandoffRef,
} from '../domain/handoff-mode';

/**
 * S7 handoff mode entry points.
 *
 * The dispatcher reads `isHumanMode` before any LLM/agent step; the future
 * feed consumer (backend unit 5) calls `applyStarted` on
 * `conversation.started` and `applyEnded` on `conversation.ended`. This
 * service only owns the durable state: it never sends a message (the
 * "Le atiende…" greeting, the farewell and the session-acks belong to the
 * feed consumer).
 */
@Injectable()
export class HandoffModeService {
  constructor(
    @Inject(CONVERSATION_STORE)
    private readonly store: ConversationStore,
  ) {}

  /** Throws when the mode cannot be read, so callers fail closed. */
  async isHumanMode(senderId: string): Promise<boolean> {
    return (await this.getState(senderId)).mode === 'HUMAN';
  }

  async getState(senderId: string): Promise<HandoffState> {
    if (this.store.getHandoff === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    return this.store.getHandoff(senderId);
  }

  applyStarted(
    senderId: string,
    epoch: number,
    requestId: string,
  ): Promise<HandoffApplyResult> {
    return this.apply(senderId, {
      mode: 'HUMAN',
      epoch,
      requestId,
    });
  }

  applyEnded(senderId: string, epoch: number): Promise<HandoffApplyResult> {
    return this.apply(senderId, { mode: 'BOT', epoch, requestId: null });
  }

  /**
   * Live conversation T4: records that the greeting of `epoch` went out (a
   * START_TIMEOUT resume notice is only sent for a greeting that did).
   * `false` when the stored epoch is not `epoch`.
   */
  async markGreeted(senderId: string, epoch: number): Promise<boolean> {
    if (this.store.markHandoffGreeted === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    return this.store.markHandoffGreeted(senderId, epoch);
  }

  /**
   * Live conversation T7: claims the safety notice of `epoch` (true only for
   * the single winner; HUMAN at exactly that epoch).
   */
  async claimSafetyNotice(senderId: string, epoch: number): Promise<boolean> {
    if (this.store.claimHandoffSafetyNotice === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    return this.store.claimHandoffSafetyNotice(senderId, epoch);
  }

  /** Live conversation T7: the conversations this bot holds in HUMAN. */
  async listHuman(limit: number): Promise<HumanHandoffRef[]> {
    if (this.store.listHumanHandoffs === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    return this.store.listHumanHandoffs(limit);
  }

  private async apply(
    senderId: string,
    transition: HandoffTransition,
  ): Promise<HandoffApplyResult> {
    if (this.store.applyHandoff === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    return this.store.applyHandoff(senderId, transition);
  }
}
