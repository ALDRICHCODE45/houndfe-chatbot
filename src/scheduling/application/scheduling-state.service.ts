import { Logger } from '@nestjs/common';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { LiveConversationClient } from '../../chatbot-api/domain/live-conversation.port';
import { describeError } from '../../common/log-safe';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import {
  type SchedulingAppointment,
  type SchedulingOffer,
  type SchedulingState,
} from '../../conversation/domain/scheduling-state';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';

export interface SchedulingStatePorts {
  store: Pick<ConversationStore, 'getScheduling' | 'commitScheduling'>;
  /** Recovery only: the state route carries `scheduledRequest`. */
  live: Pick<LiveConversationClient, 'getConversationState'>;
}

export interface SchedulingStateOptions {
  clock?: () => Date;
}

/** The CAS kept losing against concurrent writers. */
export class SchedulingStateConflictError extends Error {
  constructor() {
    super('scheduling state write conflict');
    this.name = 'SchedulingStateConflictError';
  }
}

const MAX_ATTEMPTS = 3;

/** What the bot knows about an appointment the backend just named. */
export interface KnownAppointment {
  requestId: string;
  subtype: string;
  scheduledFor: string;
  timeZone: string | null;
}

/**
 * Unit 14 T2: the durable offer / appointment of one conversation. Every
 * write is a compare-and-set of the whole `data.scheduling` slot (read, pure
 * transform, commit against the raw it read; on a lost race the transform is
 * re-applied to the fresh state, at most 3 times). Recovery: when the bot
 * needs the appointment and has none locally, one read of `scheduledRequest`
 * from the conversation state route (never otherwise).
 *
 * Writes throw on a store failure or repeated CAS loss; `getAppointment`
 * never throws. Nothing here logs a phone (S5).
 */
export class SchedulingStateService {
  private readonly logger = new Logger(SchedulingStateService.name);
  private readonly clock: () => Date;

  constructor(
    private readonly ports: SchedulingStatePorts,
    options: SchedulingStateOptions = {},
  ) {
    // Missing support (an older adapter or a hand-built stub) is NOT a boot
    // failure: every operation rejects with this and the policy degrades to
    // the unit 11 flow (planAsk → default) or the normal turn (handleReply).
    if (
      typeof ports.store.getScheduling !== 'function' ||
      typeof ports.store.commitScheduling !== 'function'
    )
      this.logger.warn(
        'the conversation store has no scheduling support: scheduling is inert',
      );
    this.clock = options.clock ?? (() => new Date());
  }

  /** The normalized state (empty when none or malformed). */
  async read(senderId: string): Promise<SchedulingState> {
    return (
      await this.supported().getScheduling.call(this.ports.store, senderId)
    ).state;
  }

  /** Replaces the offer (keeps the appointment). */
  async storeOffer(senderId: string, offer: SchedulingOffer): Promise<void> {
    await this.mutate(senderId, (state) => ({ ...state, offer }));
  }

  /** `unclearCount + 1` on the stored offer; null when there is none. */
  async bumpUnclear(senderId: string): Promise<SchedulingOffer | null> {
    const next = await this.mutate(senderId, (state) =>
      state.offer === null
        ? null
        : {
            ...state,
            offer: {
              ...state.offer,
              unclearCount: state.offer.unclearCount + 1,
            },
          },
    );
    return next.offer;
  }

  /** Drops the offer; writes nothing when there is none. */
  async clearOffer(senderId: string): Promise<void> {
    await this.mutate(senderId, (state) =>
      state.offer === null ? null : { ...state, offer: null },
    );
  }

  /** One write: the appointment is stored and the offer cleared. */
  async bookAppointment(
    senderId: string,
    appointment: SchedulingAppointment,
  ): Promise<void> {
    await this.mutate(senderId, () => ({ offer: null, appointment }));
  }

  /** Drops the appointment only when it is still `requestId`'s. */
  async clearAppointment(senderId: string, requestId: string): Promise<void> {
    await this.mutate(senderId, (state) =>
      state.appointment?.requestId === requestId
        ? { ...state, appointment: null }
        : null,
    );
  }

  /**
   * The backend named an appointment (ALREADY_SCHEDULED): store it and drop
   * the offer. A local appointment of the same request is kept as is (it has
   * the version and the reschedule count); otherwise the version comes from
   * one read of the state route (0 = unknown when unavailable).
   */
  async adoptKnownAppointment(
    senderId: string,
    known: KnownAppointment,
  ): Promise<SchedulingAppointment> {
    const local = (await this.read(senderId)).appointment;
    if (local?.requestId === known.requestId) {
      await this.clearOffer(senderId);
      return local;
    }
    const summary = await this.readScheduledRequest(senderId);
    const matches = summary?.requestId === known.requestId ? summary : null;
    const appointment: SchedulingAppointment = {
      requestId: known.requestId,
      subtype: matches?.subtype ?? known.subtype,
      scheduledFor: matches?.scheduledFor ?? known.scheduledFor,
      scheduleVersion: matches?.scheduleVersion ?? 0,
      timeZone: known.timeZone,
      rescheduleCount: 0,
    };
    await this.bookAppointment(senderId, appointment);
    return appointment;
  }

  /**
   * The local appointment; with none, one read of `scheduledRequest` from the
   * state route (stored when still none). Never throws; null when the
   * backend has none or is unreachable.
   */
  async getAppointment(
    senderId: string,
  ): Promise<SchedulingAppointment | null> {
    let local: SchedulingState;
    try {
      local = await this.read(senderId);
    } catch (error) {
      this.warn('local read failed', senderId, error);
      return null;
    }
    if (local.appointment !== null) return local.appointment;
    const summary = await this.readScheduledRequest(senderId);
    if (summary === null) return null;
    const recovered: SchedulingAppointment = {
      requestId: summary.requestId,
      subtype: summary.subtype,
      scheduledFor: summary.scheduledFor,
      scheduleVersion: summary.scheduleVersion,
      timeZone: null,
      rescheduleCount: 0,
    };
    try {
      const stored = await this.mutate(senderId, (state) =>
        state.appointment === null
          ? { ...state, appointment: recovered }
          : null,
      );
      return stored.appointment ?? recovered;
    } catch (error) {
      this.warn('recovered appointment not stored', senderId, error);
      return recovered;
    }
  }

  private async readScheduledRequest(senderId: string) {
    try {
      const answer = await this.ports.live.getConversationState(
        conversationRefFor(senderId),
      );
      if (answer.kind !== 'ok') return null;
      return answer.scheduledRequest ?? null;
    } catch (error) {
      this.warn('state route read failed', senderId, error);
      return null;
    }
  }

  /**
   * Read → transform → CAS; `null` from the transform means "no change" and
   * writes nothing. Returns the resulting state.
   */
  private async mutate(
    senderId: string,
    transform: (state: SchedulingState) => SchedulingState | null,
  ): Promise<SchedulingState> {
    const { getScheduling, commitScheduling } = this.supported();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await getScheduling.call(this.ports.store, senderId);
      const next = transform(snapshot.state);
      if (next === null) return snapshot.state;
      const committed = await commitScheduling.call(
        this.ports.store,
        senderId,
        snapshot.raw,
        next,
        this.clock().toISOString(),
      );
      if (committed) return next;
    }
    throw new SchedulingStateConflictError();
  }

  private supported(): Required<SchedulingStatePorts['store']> {
    const { getScheduling, commitScheduling } = this.ports.store;
    if (
      typeof getScheduling !== 'function' ||
      typeof commitScheduling !== 'function'
    )
      throw new Error('the conversation store has no scheduling support');
    return { getScheduling, commitScheduling };
  }

  private warn(what: string, senderId: string, error: unknown): void {
    this.logger.warn(
      `scheduling state ${what} for ${maskConversationRef(conversationRefFor(senderId))}: ${describeError(error)}`,
    );
  }
}
