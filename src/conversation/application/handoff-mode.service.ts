import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../domain/conversation-store';
import {
  ENDING_BOUND_MS,
  isEndingActive,
  type HandoffApplyResult,
  type HandoffState,
  type HandoffTransition,
  type HumanHandoffRef,
} from '../domain/handoff-mode';

/** Optional clock override (tests); the real clock when not provided. */
export const HANDOFF_MODE_CLOCK = Symbol('HANDOFF_MODE_CLOCK');

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
  private readonly logger = new Logger(HandoffModeService.name);
  private readonly clock: () => Date;
  /** Conversations whose expired ENDING marker was already logged (once). */
  private readonly expiredLogged = new Set<string>();

  constructor(
    @Inject(CONVERSATION_STORE)
    private readonly store: ConversationStore,
    @Optional()
    @Inject(HANDOFF_MODE_CLOCK)
    clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  /** Throws when the mode cannot be read, so callers fail closed. */
  async isHumanMode(senderId: string): Promise<boolean> {
    return (await this.getState(senderId)).mode === 'HUMAN';
  }

  /**
   * Follow-ups S4: true while the conversation carries a live ENDING marker
   * (a session known to be ending whose farewell is not decided yet). One
   * local read, no backend call; throws when the state cannot be read. The
   * marker is bounded: once its bound passes this is false again (the expiry
   * is logged once per conversation).
   */
  async isEnding(senderId: string): Promise<boolean> {
    return this.endingOf(await this.getState(senderId), senderId);
  }

  /**
   * The dispatcher's single question before a bot turn: "must the bot stay
   * silent?" — HUMAN mode, or a live ENDING marker. One local read.
   */
  async isSilenced(senderId: string): Promise<boolean> {
    const state = await this.getState(senderId);
    return state.mode === 'HUMAN' || this.endingOf(state, senderId);
  }

  private endingOf(state: HandoffState, senderId: string): boolean {
    if (state.ending === undefined) {
      this.expiredLogged.delete(senderId);
      return false;
    }
    if (isEndingActive(state, this.clock())) {
      this.expiredLogged.delete(senderId);
      return true;
    }
    if (!this.expiredLogged.has(senderId)) {
      if (this.expiredLogged.size >= 1000) this.expiredLogged.clear();
      this.expiredLogged.add(senderId);
      this.logger.warn(
        `ENDING marker of ${maskConversationRef(senderId)} (epoch ${state.ending.epoch}) expired before its farewell was decided: released`,
      );
    }
    return false;
  }

  /**
   * Follow-ups S4: marks the session of `epoch` as ending, for at most
   * `boundMs` (default 2 min). Applies while a handoff value exists and its
   * epoch is not newer; `false` otherwise (nothing to protect). The marker
   * survives the durable BOT (`applyEnded`) of that same epoch.
   */
  async markEnding(
    senderId: string,
    epoch: number,
    boundMs: number = ENDING_BOUND_MS,
  ): Promise<boolean> {
    if (this.store.markHandoffEnding === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    const until = new Date(this.clock().getTime() + boundMs).toISOString();
    const set = await this.store.markHandoffEnding(senderId, epoch, until);
    if (set) this.expiredLogged.delete(senderId);
    return set;
  }

  /** Follow-ups S4: the farewell is decided (or the end is moot): releases
   *  the marker of `epoch`. `false` when there was none. */
  async clearEnding(senderId: string, epoch: number): Promise<boolean> {
    if (this.store.clearHandoffEnding === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    this.expiredLogged.delete(senderId);
    return this.store.clearHandoffEnding(senderId, epoch);
  }

  async getState(senderId: string): Promise<HandoffState> {
    if (this.store.getHandoff === undefined) {
      throw new Error('ConversationStore does not support handoff mode');
    }
    return this.store.getHandoff(senderId);
  }

  /** `silent`: the mute is applied without a greeting (reconcile of a
   *  missed `started`); a later `started` of this epoch must not greet. */
  applyStarted(
    senderId: string,
    epoch: number,
    requestId: string,
    options: { silent?: boolean } = {},
  ): Promise<HandoffApplyResult> {
    return this.apply(senderId, {
      mode: 'HUMAN',
      epoch,
      requestId,
      ...(options.silent === true ? { silent: true } : {}),
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
