import { Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { SchedulingClient } from '../../chatbot-api/domain/scheduling.port';
import { describeError } from '../../common/log-safe';
import {
  isOfferExpired,
  type SchedulingAppointment,
  type SchedulingOffer,
  type SchedulingState,
} from '../../conversation/domain/scheduling-state';
import {
  maskConversationRef,
  type HumanRequestFeedStore,
} from '../../human-requests/domain/human-request-feed';
import type {
  ReplyContext,
  ReplyOutcome,
} from '../../whatsapp/domain/out-of-hours-policy';
import {
  isChangeConfirmation,
  parseAppointmentIntent,
} from '../domain/appointment-intent';
import { lastCustomerMessageAtFor } from '../domain/scheduled-booking';
import {
  cancelledText,
  notUnderstoodText,
  offerText,
  rescheduledText,
  slotTakenText,
  whatTimeText,
} from '../domain/scheduling-copy';
import { parseSlotChoice } from '../domain/slot-choice';
import { formatWhen, slotLabel } from '../domain/slot-time';
import type { SchedulingStateService } from './scheduling-state.service';

export interface AppointmentIntentPorts {
  scheduling: Pick<SchedulingClient, 'listSlots' | 'rescheduleRequest'>;
  /** The existing customer cancel route (`CUSTOMER_WITHDREW`). */
  requests: Pick<HumanRequestsClient, 'cancelHumanRequest'>;
  state: Pick<
    SchedulingStateService,
    | 'getAppointment'
    | 'clearChangeAsked'
    | 'startReschedule'
    | 'storeOffer'
    | 'bumpUnclear'
    | 'clearOffer'
    | 'recordCustomerReschedule'
    | 'learnTimeZone'
    | 'clearAppointment'
  >;
  /** The local open-request registry: a cancelled request is closed in it,
   *  like the cancel outbox adapter does. */
  registry: Pick<HumanRequestFeedStore, 'closeRequest'>;
}

export interface AppointmentIntentOptions {
  clock?: () => Date;
  /** The reschedule idempotency key of a new offer (a UUID). */
  newKey?: () => string;
}

/** Max customer reschedules per conversation (S3). */
export const MAX_CUSTOMER_RESCHEDULES = 3;
/** «¿Quiere cambiarla?» is answered by the very next "sí", not much later. */
export const CHANGE_QUESTION_TTL_MS = 10 * 60_000;
/** The branch zone when neither the appointment nor the API names one. */
const DEFAULT_ZONE = 'America/Mexico_City';
const MAX_OFFERED = 3;
/** A second unclear answer drops the offer. */
const MAX_UNCLEAR = 2;

const PASS: ReplyOutcome = { kind: 'pass' };

/** A stable v4-shaped UUID from a seed: the same cancel message always
 *  carries the same idempotency key. */
function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  const variant = (8 + (parseInt(h[16], 16) % 4)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Unit 14 T4: what the customer says about the appointment the bot holds,
 * handled deterministically BEFORE the LLM turn: "¿a qué hora quedé?",
 * change it (offer slots, then the reschedule call) and cancel it. The
 * matchers are conservative and anchored (`appointment-intent.ts`).
 *
 * `handle` returns `null` when the message is not for this service (the
 * caller goes on with its own logic) and `{kind:'pass'}` when it was for it
 * but nothing may be said (the normal turn runs). Every text is an approved
 * usted builder. Nothing here logs a phone or a message id (S5).
 */
export class AppointmentIntentService {
  private readonly logger = new Logger(AppointmentIntentService.name);
  private readonly clock: () => Date;
  private readonly newKey: () => string;

  constructor(
    private readonly ports: AppointmentIntentPorts,
    options: AppointmentIntentOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.newKey = options.newKey ?? randomUUID;
  }

  async handle(
    context: ReplyContext,
    state: SchedulingState,
  ): Promise<ReplyOutcome | null> {
    const { senderId, text } = context;
    const now = this.clock();
    const intent = parseAppointmentIntent(text);
    const appointment = state.appointment;
    const questionStored = appointment?.changeAskedAt !== undefined;
    const questionFresh =
      appointment !== null &&
      questionStored &&
      now.getTime() - Date.parse(appointment.changeAskedAt as string) <
        CHANGE_QUESTION_TTL_MS;
    const rescheduleOffer =
      state.offer?.rescheduleRequestId !== undefined ? state.offer : null;

    // The hot path: an ordinary message costs nothing here.
    if (intent === null && !questionStored && rescheduleOffer === null)
      return null;

    if (intent === 'cancel') return this.cancel(context);
    if (intent === 'change') return this.startChange(context, now);
    if (intent === 'what_time') {
      if (questionStored) await this.dropQuestion(senderId);
      return this.whatTime(context, now);
    }
    if (questionFresh && isChangeConfirmation(text))
      return this.startChange(context, now);
    if (questionStored) await this.dropQuestion(senderId);
    if (rescheduleOffer !== null)
      return this.chooseSlot(context, rescheduleOffer, appointment, now);
    return null;
  }

  // ------------------------------------------------------------ what time

  private async whatTime(
    context: ReplyContext,
    now: Date,
  ): Promise<ReplyOutcome | null> {
    const { senderId } = context;
    const appointment = await this.ports.state.getAppointment(senderId);
    if (appointment === null) return null;
    // A time that already passed is not announced as upcoming.
    if (Date.parse(appointment.scheduledFor) < now.getTime()) return PASS;
    const zone =
      appointment.timeZone ??
      (await this.resolveZone(context, appointment, now));
    return {
      kind: 'reply',
      text: whatTimeText(slotLabel(appointment.scheduledFor, zone, now)),
    };
  }

  /** The zone of a recovered appointment: one slots read, else the default. */
  private async resolveZone(
    context: ReplyContext,
    appointment: SchedulingAppointment,
    now: Date,
  ): Promise<string> {
    const { senderId } = context;
    try {
      const answer = await this.ports.scheduling.listSlots({
        conversationRef: conversationRefFor(senderId),
        lastCustomerMessageAt: lastCustomerMessageAtFor(context.inboundAt, now),
      });
      if (answer.kind !== 'ok') return DEFAULT_ZONE;
      await this.learnZone(senderId, appointment, answer.timeZone);
      return answer.timeZone;
    } catch (error) {
      this.warn('time zone read failed, using the default', senderId, error);
      return DEFAULT_ZONE;
    }
  }

  private async learnZone(
    senderId: string,
    appointment: SchedulingAppointment,
    timeZone: string,
  ): Promise<void> {
    if (appointment.timeZone !== null) return;
    try {
      await this.ports.state.learnTimeZone(
        senderId,
        appointment.requestId,
        timeZone,
      );
    } catch (error) {
      this.warn('time zone not stored', senderId, error);
    }
  }

  // --------------------------------------------------------------- change

  private async startChange(
    context: ReplyContext,
    now: Date,
  ): Promise<ReplyOutcome | null> {
    const { senderId } = context;
    const appointment = await this.ports.state.getAppointment(senderId);
    if (appointment === null) return null;
    if (appointment.rescheduleCount >= MAX_CUSTOMER_RESCHEDULES) return PASS;
    let answer;
    try {
      answer = await this.ports.scheduling.listSlots({
        conversationRef: conversationRefFor(senderId),
        lastCustomerMessageAt: lastCustomerMessageAtFor(context.inboundAt, now),
      });
    } catch (error) {
      this.warn('slots read failed, no reschedule offer', senderId, error);
      return PASS;
    }
    if (answer.kind !== 'ok') return PASS;
    const slots = answer.slots.slice(0, MAX_OFFERED).map((slot) => ({
      startsAt: slot.startsAt,
      withinWindow: slot.withinWindow,
    }));
    if (slots.length === 0) return PASS;
    const openWhen = formatWhen(
      answer.businessHours.nextOpenAt ?? slots[0].startsAt,
      answer.timeZone,
      now,
    );
    const offer: SchedulingOffer = {
      slots,
      timeZone: answer.timeZone,
      offeredAt: now.toISOString(),
      subtype:
        appointment.subtype === 'COMPLAINT' ? 'COMPLAINT' : 'TALK_TO_HUMAN',
      // The reschedule's idempotency key, stored BEFORE the call so a retry
      // of the same choice replays it.
      sourceRequestId: this.newKey(),
      openWhen,
      unclearCount: 0,
      rescheduleRequestId: appointment.requestId,
    };
    await this.ports.state.startReschedule(senderId, offer);
    await this.learnZone(senderId, appointment, answer.timeZone);
    return {
      kind: 'reply',
      text: offerText(
        openWhen,
        slots.map((slot) => slotLabel(slot.startsAt, offer.timeZone, now)),
      ),
    };
  }

  private async chooseSlot(
    context: ReplyContext,
    offer: SchedulingOffer,
    appointment: SchedulingAppointment | null,
    now: Date,
  ): Promise<ReplyOutcome> {
    const { senderId } = context;
    const requestId = offer.rescheduleRequestId as string;
    if (isOfferExpired(offer, now) || appointment?.requestId !== requestId) {
      await this.ports.state.clearOffer(senderId);
      return PASS;
    }
    const choice = parseSlotChoice(context.text, offer.slots, {
      timeZone: offer.timeZone,
      now,
    });
    if (choice.kind === 'unclear') {
      if (offer.unclearCount + 1 >= MAX_UNCLEAR) {
        await this.ports.state.clearOffer(senderId);
        return PASS;
      }
      await this.ports.state.bumpUnclear(senderId);
      return { kind: 'reply', text: notUnderstoodText() };
    }
    let result;
    try {
      result = await this.ports.scheduling.rescheduleRequest(
        requestId,
        {
          scheduledFor: choice.startsAt,
          lastCustomerMessageAt: lastCustomerMessageAtFor(
            context.inboundAt,
            now,
          ),
          ...(context.messageId === ''
            ? {}
            : { triggerWaMessageId: context.messageId }),
        },
        offer.sourceRequestId,
      );
    } catch (error) {
      // The offer (and its key) stay: a retry replays the same call.
      this.warn('reschedule call failed, keeping the offer', senderId, error);
      return PASS;
    }
    switch (result.kind) {
      case 'ok':
        return this.onRescheduled(senderId, offer, appointment, result, now);
      case 'SLOT_UNAVAILABLE':
        return this.onSlotTaken(senderId, offer, result, now);
      case 'REQUEST_CLOSED':
      case 'NOT_SCHEDULED':
      case 'NOT_FOUND':
        // clearAppointment also drops this request's reschedule offer.
        await this.ports.state.clearAppointment(senderId, requestId);
        return PASS;
      case 'RETRYABLE':
      case 'RATE_LIMITED':
        return PASS;
      case 'RESCHEDULE_NOT_ALLOWED':
        // A live session started: the words go to the attendee.
        await this.ports.state.clearOffer(senderId);
        return PASS;
      default:
        this.logger.error(
          `reschedule refused (${result.kind}) for ${this.masked(senderId)}`,
        );
        await this.ports.state.clearOffer(senderId);
        return PASS;
    }
  }

  private async onRescheduled(
    senderId: string,
    offer: SchedulingOffer,
    appointment: SchedulingAppointment | null,
    result: {
      status: 'RESCHEDULED' | 'UNCHANGED';
      scheduledFor: string;
      scheduleVersion: number;
    },
    now: Date,
  ): Promise<ReplyOutcome> {
    const requestId = offer.rescheduleRequestId as string;
    try {
      await this.ports.state.recordCustomerReschedule(senderId, {
        requestId,
        subtype: appointment?.subtype ?? offer.subtype,
        scheduledFor: result.scheduledFor,
        scheduleVersion: result.scheduleVersion,
        timeZone: offer.timeZone,
        counted: result.status === 'RESCHEDULED',
      });
    } catch (error) {
      // The backend changed it: the customer is told. A stale local time
      // must never answer later, so drop it (the next question recovers).
      this.warn('rescheduled appointment not stored', senderId, error);
      try {
        await this.ports.state.clearAppointment(senderId, requestId);
      } catch (clearError) {
        this.warn('stale appointment not dropped', senderId, clearError);
      }
    }
    return {
      kind: 'reply',
      text: rescheduledText(
        slotLabel(result.scheduledFor, offer.timeZone, now),
      ),
    };
  }

  private async onSlotTaken(
    senderId: string,
    offer: SchedulingOffer,
    result: {
      slots: readonly { startsAt: string; withinWindow: boolean }[];
      timeZone: string;
    },
    now: Date,
  ): Promise<ReplyOutcome> {
    const slots = result.slots.slice(0, MAX_OFFERED).map((slot) => ({
      startsAt: slot.startsAt,
      withinWindow: slot.withinWindow,
    }));
    if (slots.length === 0) {
      await this.ports.state.clearOffer(senderId);
      return PASS;
    }
    const fresh: SchedulingOffer = {
      ...offer,
      slots,
      timeZone: result.timeZone,
      offeredAt: now.toISOString(),
      sourceRequestId: this.newKey(),
      unclearCount: 0,
    };
    await this.ports.state.storeOffer(senderId, fresh);
    return {
      kind: 'reply',
      text: slotTakenText(
        slots.map((slot) => slotLabel(slot.startsAt, result.timeZone, now)),
      ),
    };
  }

  // --------------------------------------------------------------- cancel

  private async cancel(context: ReplyContext): Promise<ReplyOutcome | null> {
    const { senderId, messageId } = context;
    const appointment = await this.ports.state.getAppointment(senderId);
    if (appointment === null) return null;
    const { requestId } = appointment;
    let result;
    try {
      result = await this.ports.requests.cancelHumanRequest(
        requestId,
        { reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: messageId },
        uuidFrom(`appointment-cancel:${requestId}:${messageId}`),
      );
    } catch (error) {
      this.warn('cancel call failed', senderId, error);
      return PASS;
    }
    switch (result.kind) {
      case 'ok':
        await this.forget(senderId, requestId, 'CANCELLED');
        return { kind: 'reply', text: cancelledText() };
      case 'ALREADY_RESOLVED':
        await this.forget(senderId, requestId, 'RESOLVED');
        return PASS;
      case 'REQUEST_CLOSED':
      case 'NOT_FOUND':
        await this.forget(senderId, requestId, null);
        return PASS;
      default:
        // CANCEL_NOT_ALLOWED, IDEMPOTENCY_CONFLICT, RATE_LIMITED: nothing
        // approved to say; the appointment stays.
        this.logger.warn(
          `appointment cancel not done (${result.kind}) for ${this.masked(senderId)}`,
        );
        return PASS;
    }
  }

  /** The request is over: close its registry row and drop the appointment.
   *  Both best-effort (the backend already answered). */
  private async forget(
    senderId: string,
    requestId: string,
    closeAs: 'CANCELLED' | 'RESOLVED' | null,
  ): Promise<void> {
    if (closeAs !== null) {
      try {
        await this.ports.registry.closeRequest(requestId, closeAs);
      } catch (error) {
        this.warn('registry row not closed', senderId, error);
      }
    }
    try {
      await this.ports.state.clearAppointment(senderId, requestId);
    } catch (error) {
      this.warn('appointment not cleared', senderId, error);
    }
  }

  // -------------------------------------------------------------- helpers

  private async dropQuestion(senderId: string): Promise<void> {
    try {
      await this.ports.state.clearChangeAsked(senderId);
    } catch (error) {
      this.warn('change question not dropped', senderId, error);
    }
  }

  private masked(senderId: string): string {
    return maskConversationRef(conversationRefFor(senderId));
  }

  private warn(what: string, senderId: string, error: unknown): void {
    this.logger.warn(
      `appointment intents: ${what} for ${this.masked(senderId)}: ${describeError(error)}`,
    );
  }
}
