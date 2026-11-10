import { Inject, Injectable } from '@nestjs/common';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../domain/conversation-store';
import type {
  HandoffApplyResult,
  HandoffState,
  HandoffTransition,
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
