import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  CreateHumanRequestResult,
  HumanRequestCreated,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { SchedulingSlot } from '../../chatbot-api/domain/dtos/scheduling.dto';
import type { SchedulingClient } from '../../chatbot-api/domain/scheduling.port';
import { describeError } from '../../common/log-safe';
import {
  isOfferExpired,
  type SchedulingOffer,
} from '../../conversation/domain/scheduling-state';
import type { HumanRequestCreateService } from '../../human-requests/application/human-request-create.service';
import {
  ASK_TEAM_OPEN_LIMIT_REPLY,
  ASK_TEAM_RATE_LIMITED_REPLY,
  TALK_TO_HUMAN_QUEUED_REPLY,
} from '../../human-requests/domain/human-request-create';
import {
  maskConversationRef,
  type HumanRequestFeedStore,
} from '../../human-requests/domain/human-request-feed';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
  type AskContext,
  type AskPlan,
  type OutOfHoursContext,
  type OutOfHoursPolicy,
  type ReplyContext,
  type ReplyOutcome,
} from '../../whatsapp/domain/out-of-hours-policy';
import {
  buildScheduledRequest,
  lastCustomerMessageAtFor,
} from '../domain/scheduled-booking';
import {
  alreadyBookedText,
  bookedOutOfWindowText,
  bookedText,
  noSlotsText,
  notUnderstoodText,
  offerText,
  slotTakenText,
} from '../domain/scheduling-copy';
import { parseSlotChoice } from '../domain/slot-choice';
import { formatWhen, slotLabel } from '../domain/slot-time';
import type { AppointmentIntentService } from './appointment-intent.service';
import type { SchedulingStateService } from './scheduling-state.service';

export interface SchedulingPolicyPorts {
  scheduling: Pick<SchedulingClient, 'listSlots'>;
  /** Booking is inline: never through the outbox (a queued scheduled create
   *  would hit SLOT_UNAVAILABLE later as a permanent refusal). */
  requests: Pick<HumanRequestsClient, 'createHumanRequest'>;
  state: Pick<
    SchedulingStateService,
    | 'read'
    | 'storeOffer'
    | 'bumpUnclear'
    | 'clearOffer'
    | 'bookAppointment'
    | 'adoptKnownAppointment'
    | 'getAppointment'
    | 'markChangeAsked'
  >;
  /** The unscheduled create, for "no free slot" outcomes. */
  team: Pick<HumanRequestCreateService, 'requestTalkToHuman'>;
  /** The local open-request registry row of a booked request. */
  registry: Pick<HumanRequestFeedStore, 'recordOpenRequest'>;
  /** Unit 14 T4: "¿a qué hora quedé?", change and cancel, before the offer
   *  logic. Absent → those messages are not intercepted. */
  appointments?: Pick<AppointmentIntentService, 'handle'>;
}

export interface SchedulingPolicyOptions {
  clock?: () => Date;
  newSourceRequestId?: () => string;
  /** Injected for tests; default is a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Transient booking failures: at most this many attempts of the SAME key… */
const MAX_BOOKING_ATTEMPTS = 3;
/** …with these pauses, and never more than ~10 s of wall-clock in total
 *  (call latency + pauses): a webhook dispatch is never held longer. */
const BACKOFF_MS = [1_000, 3_000];
const RETRY_BUDGET_MS = 10_000;
/** The write guard rejects more than this many slots in an offer. */
const MAX_OFFERED = 3;
/** A second unclear answer drops the offer. */
const MAX_UNCLEAR = 2;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Booking =
  | { kind: 'done'; result: CreateHumanRequestResult }
  /** Transient failures kept failing (or the retry would exceed the budget). */
  | { kind: 'gave_up' };

/**
 * Unit 14 T3: the scheduling implementation of `OutOfHoursPolicy`.
 *
 *  - `planAsk` (a clear ask): asks the slots FIRST (S2 point 4: open/closed is
 *    known before anything is created). SCHEDULING_DISABLED, a failed read, an
 *    open branch or an unknown `nextOpenAt` → today's flow. Closed with no
 *    free slot → create the unscheduled request and answer "no hay horarios".
 *    Closed with slots → store the offer and answer the numbered text; the
 *    request is NOT created yet.
 *  - `handleReply` (the next plain text while an offer is active): parses the
 *    choice before the LLM turn and books INLINE with the offer's key.
 *
 * Every text is an approved usted builder; the dispatcher styles it. Never
 * throws; no phone reaches a log (S5).
 */
export class SchedulingOutOfHoursPolicy implements OutOfHoursPolicy {
  private readonly logger = new Logger(SchedulingOutOfHoursPolicy.name);
  private readonly clock: () => Date;
  private readonly newSourceRequestId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ports: SchedulingPolicyPorts,
    options: SchedulingPolicyOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.newSourceRequestId = options.newSourceRequestId ?? randomUUID;
    this.sleep = options.sleep ?? realSleep;
  }

  /** After an unscheduled create the copy is the unit 11 fixed text. */
  outOfHoursReply(context: OutOfHoursContext): Promise<string> {
    void context;
    return Promise.resolve(TALK_TO_HUMAN_OUT_OF_HOURS_REPLY);
  }

  async planAsk(context: AskContext): Promise<AskPlan> {
    const { senderId } = context;
    if (parseMexicanWhatsAppPhone(senderId) === null)
      return { kind: 'default' };
    const now = this.clock();
    let answer;
    try {
      answer = await this.ports.scheduling.listSlots({
        conversationRef: conversationRefFor(senderId),
        lastCustomerMessageAt: lastCustomerMessageAtFor(context.inboundAt, now),
      });
    } catch (error) {
      this.warn('slots read threw, using the default flow', senderId, error);
      return { kind: 'default' };
    }
    if (answer.kind !== 'ok') {
      if (answer.kind !== 'SCHEDULING_DISABLED')
        this.logger.warn(
          `slots read refused (${answer.kind}) for ${this.masked(senderId)}, using the default flow`,
        );
      return { kind: 'default' };
    }
    const { businessHours } = answer;
    if (businessHours.openNow || businessHours.nextOpenAt === null)
      return { kind: 'default' };
    const openWhen = formatWhen(businessHours.nextOpenAt, answer.timeZone, now);
    if (answer.slots.length === 0)
      return { kind: 'create_then_reply', closedReply: noSlotsText(openWhen) };

    const offer: SchedulingOffer = {
      slots: answer.slots.slice(0, MAX_OFFERED).map((slot) => ({
        startsAt: slot.startsAt,
        withinWindow: slot.withinWindow,
      })),
      timeZone: answer.timeZone,
      offeredAt: now.toISOString(),
      subtype: 'TALK_TO_HUMAN',
      sourceRequestId: this.newSourceRequestId(),
      openWhen,
      unclearCount: 0,
    };
    try {
      await this.ports.state.storeOffer(senderId, offer);
    } catch (error) {
      // Never an offer nobody remembers: the unit 11 create takes over.
      this.warn('offer not stored, using the default flow', senderId, error);
      return { kind: 'default' };
    }
    return {
      kind: 'reply',
      text: offerText(
        openWhen,
        offer.slots.map((slot) =>
          slotLabel(slot.startsAt, offer.timeZone, now),
        ),
      ),
    };
  }

  async handleReply(context: ReplyContext): Promise<ReplyOutcome> {
    const { senderId } = context;
    try {
      const state = await this.ports.state.read(senderId);
      const now = this.clock();
      if (this.ports.appointments !== undefined) {
        const intent = await this.ports.appointments.handle(context, state);
        if (intent !== null) return intent;
      }
      const { offer } = state;
      if (offer === null) return PASS;
      // A reschedule offer belongs to the appointment intents: never book it.
      if (offer.rescheduleRequestId !== undefined) return PASS;
      if (isOfferExpired(offer, now)) {
        await this.ports.state.clearOffer(senderId);
        return PASS;
      }
      const choice = parseSlotChoice(context.text, offer.slots, {
        timeZone: offer.timeZone,
        now,
      });
      if (choice.kind === 'unclear')
        return await this.onUnclear(senderId, offer);
      return await this.book(context, offer, choice.startsAt, now);
    } catch (error) {
      this.warn('offer handling failed, normal turn', senderId, error);
      return PASS;
    }
  }

  private async onUnclear(
    senderId: string,
    offer: SchedulingOffer,
  ): Promise<ReplyOutcome> {
    if (offer.unclearCount + 1 >= MAX_UNCLEAR) {
      await this.ports.state.clearOffer(senderId);
      return PASS;
    }
    await this.ports.state.bumpUnclear(senderId);
    return { kind: 'reply', text: notUnderstoodText() };
  }

  private async book(
    context: ReplyContext,
    offer: SchedulingOffer,
    startsAt: string,
    now: Date,
    mayRotateKey = true,
  ): Promise<ReplyOutcome> {
    const { senderId } = context;
    const request = buildScheduledRequest({
      senderId,
      sourceRequestId: offer.sourceRequestId,
      subtype: offer.subtype,
      scheduledFor: startsAt,
      lastCustomerMessageAt: lastCustomerMessageAtFor(context.inboundAt, now),
      triggerWaMessageId: context.messageId,
    });
    if (request === null) return PASS;
    const booking = await this.createWithRetry(request, senderId);
    // Transient failures: the offer stays; the agent answers this message.
    if (booking.kind === 'gave_up') return PASS;
    const result = booking.result;
    switch (result.kind) {
      case 'ok':
        return this.onBooked(context, offer, startsAt, result.response);
      case 'SLOT_UNAVAILABLE':
        return this.onSlotTaken(
          senderId,
          offer,
          result.slots,
          result.timeZone,
          now,
        );
      case 'ALREADY_SCHEDULED': {
        const appointment = await this.ports.state.adoptKnownAppointment(
          senderId,
          {
            requestId: result.requestId,
            subtype: offer.subtype,
            scheduledFor: result.scheduledFor,
            timeZone: offer.timeZone,
          },
        );
        await this.armChangeQuestion(senderId, appointment.requestId, now);
        return {
          kind: 'reply',
          text: alreadyBookedText(
            slotLabel(
              appointment.scheduledFor,
              appointment.timeZone ?? offer.timeZone,
              now,
            ),
          ),
        };
      }
      case 'IDEMPOTENCY_CONFLICT':
        if (mayRotateKey)
          return this.onKeyConflict(context, offer, startsAt, now);
        this.logger.error(
          `scheduled booking refused (${result.kind}) for ${this.masked(senderId)}`,
        );
        await this.ports.state.clearOffer(senderId);
        return PASS;
      case 'CUSTOMER_OPEN_LIMIT':
        await this.ports.state.clearOffer(senderId);
        return { kind: 'reply', text: ASK_TEAM_OPEN_LIMIT_REPLY };
      case 'CUSTOMER_RATE_LIMITED':
        await this.ports.state.clearOffer(senderId);
        return { kind: 'reply', text: ASK_TEAM_RATE_LIMITED_REPLY };
      default:
        // SCHEDULING_DISABLED, SUBTYPE_DISABLED, VALIDATION_ERROR,
        // NOT_FOUND: nothing was promised.
        this.logger.error(
          `scheduled booking refused (${result.kind}) for ${this.masked(senderId)}`,
        );
        await this.ports.state.clearOffer(senderId);
        return PASS;
    }
  }

  private async onBooked(
    context: ReplyContext,
    offer: SchedulingOffer,
    startsAt: string,
    response: HumanRequestCreated,
  ): Promise<ReplyOutcome> {
    const { senderId } = context;
    const requestId = response.mergedIntoId ?? response.id;
    if (
      requestId === null ||
      response.scheduledFor === undefined ||
      response.scheduleVersion === undefined
    ) {
      // A backend that ignored `scheduledFor` created an UNSCHEDULED request:
      // never tell the customer it is "agendado".
      this.logger.error(
        `booking answer for ${this.masked(senderId)} carries no schedule; answering the out-of-hours copy`,
      );
      await this.dropOffer(senderId);
      return { kind: 'reply', text: TALK_TO_HUMAN_OUT_OF_HOURS_REPLY };
    }
    await this.recordOpen(senderId, requestId, offer.subtype);
    // The backend confirmed the booking: whatever happens to the LOCAL
    // write, the customer is told (never `pass` after a confirmed booking).
    try {
      await this.ports.state.bookAppointment(senderId, {
        requestId,
        subtype: offer.subtype,
        scheduledFor: response.scheduledFor,
        scheduleVersion: response.scheduleVersion,
        timeZone: offer.timeZone,
        rescheduleCount: 0,
      });
    } catch (error) {
      this.warn(
        `request ${requestId} booked but the appointment was not stored`,
        senderId,
        error,
      );
      await this.dropOffer(senderId);
    }
    const chosen = offer.slots.find((slot) => slot.startsAt === startsAt);
    const outOfWindow =
      response.requiresTemplateAtStart === true ||
      chosen?.withinWindow === false;
    const label = slotLabel(
      response.scheduledFor,
      offer.timeZone,
      this.clock(),
    );
    return {
      kind: 'reply',
      text: outOfWindow ? bookedOutOfWindowText(label) : bookedText(label),
    };
  }

  /** 409 SLOT_UNAVAILABLE: re-offer the fresh list under a new key; with
   *  nothing free, the unscheduled request and the "no hay horarios" copy. */
  private async onSlotTaken(
    senderId: string,
    offer: SchedulingOffer,
    slots: readonly SchedulingSlot[],
    timeZone: string,
    now: Date,
  ): Promise<ReplyOutcome> {
    if (slots.length === 0) return this.onNothingFree(senderId, offer);
    const fresh: SchedulingOffer = {
      slots: slots.slice(0, MAX_OFFERED).map((slot) => ({
        startsAt: slot.startsAt,
        withinWindow: slot.withinWindow,
      })),
      timeZone,
      offeredAt: now.toISOString(),
      subtype: offer.subtype,
      sourceRequestId: this.newSourceRequestId(),
      ...(offer.openWhen === undefined ? {} : { openWhen: offer.openWhen }),
      unclearCount: 0,
    };
    await this.ports.state.storeOffer(senderId, fresh);
    return {
      kind: 'reply',
      text: slotTakenText(
        fresh.slots.map((slot) => slotLabel(slot.startsAt, timeZone, now)),
      ),
    };
  }

  private async onNothingFree(
    senderId: string,
    offer: SchedulingOffer,
  ): Promise<ReplyOutcome> {
    await this.ports.state.clearOffer(senderId);
    const outcome = await this.ports.team.requestTalkToHuman({
      senderId,
      text: '',
    });
    switch (outcome.kind) {
      case 'registered':
        return {
          kind: 'reply',
          text:
            offer.openWhen === undefined
              ? TALK_TO_HUMAN_OUT_OF_HOURS_REPLY
              : noSlotsText(offer.openWhen),
        };
      case 'queued':
        return { kind: 'reply', text: TALK_TO_HUMAN_QUEUED_REPLY };
      case 'open_limit':
        return { kind: 'reply', text: ASK_TEAM_OPEN_LIMIT_REPLY };
      case 'customer_rate_limited':
        return { kind: 'reply', text: ASK_TEAM_RATE_LIMITED_REPLY };
      case 'failed':
        return PASS;
    }
  }

  /**
   * The same key (a replay is safe) up to 3 times; the elapsed wall-clock
   * (call latency + pauses + any Retry-After) stays within ~10 s, and a
   * pause that would exceed it stops at once.
   */
  private async createWithRetry(
    request: NonNullable<ReturnType<typeof buildScheduledRequest>>,
    senderId: string,
  ): Promise<Booking> {
    const startedAt = this.clock().getTime();
    for (let attempt = 1; attempt <= MAX_BOOKING_ATTEMPTS; attempt += 1) {
      let retryAfterMs = 0;
      try {
        const result = await this.ports.requests.createHumanRequest(request);
        if (result.kind === 'RATE_LIMITED') {
          retryAfterMs = (result.retryAfterSeconds ?? 0) * 1000;
        } else if (result.kind !== 'VERSION_CONFLICT') {
          return { kind: 'done', result };
        }
      } catch (error) {
        this.warn(`booking attempt ${attempt} failed`, senderId, error);
      }
      if (attempt === MAX_BOOKING_ATTEMPTS) break;
      const delay = Math.max(BACKOFF_MS[attempt - 1] ?? 0, retryAfterMs);
      const elapsed = this.clock().getTime() - startedAt;
      if (elapsed + delay > RETRY_BUDGET_MS) break;
      await this.sleep(delay);
    }
    this.logger.warn(
      `booking for ${this.masked(senderId)} not confirmed, keeping the offer`,
    );
    return { kind: 'gave_up' };
  }

  /** The backend already holds a request under this key (an earlier attempt
   *  that gave up may have committed it, or the key was used for another
   *  slot): one recovery read. An appointment found is stored and answered;
   *  otherwise the choice is retried ONCE under a fresh key (stored first). */
  private async onKeyConflict(
    context: ReplyContext,
    offer: SchedulingOffer,
    startsAt: string,
    now: Date,
  ): Promise<ReplyOutcome> {
    const { senderId } = context;
    const appointment = await this.ports.state.getAppointment(senderId);
    if (appointment !== null) {
      await this.dropOffer(senderId);
      await this.recordOpen(senderId, appointment.requestId, offer.subtype);
      const zone = appointment.timeZone ?? offer.timeZone;
      const label = slotLabel(appointment.scheduledFor, zone, now);
      if (Date.parse(appointment.scheduledFor) === Date.parse(startsAt)) {
        const chosen = offer.slots.find((slot) => slot.startsAt === startsAt);
        return {
          kind: 'reply',
          text:
            chosen?.withinWindow === false
              ? bookedOutOfWindowText(label)
              : bookedText(label),
        };
      }
      await this.armChangeQuestion(senderId, appointment.requestId, now);
      return { kind: 'reply', text: alreadyBookedText(label) };
    }
    const fresh: SchedulingOffer = {
      ...offer,
      sourceRequestId: this.newSourceRequestId(),
    };
    await this.ports.state.storeOffer(senderId, fresh);
    return this.book(context, fresh, startsAt, now, false);
  }

  /** «¿Quiere cambiarla?» was asked: the next "sí" is the answer. */
  private async armChangeQuestion(
    senderId: string,
    requestId: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.ports.state.markChangeAsked(
        senderId,
        requestId,
        now.toISOString(),
      );
    } catch (error) {
      this.warn('change question not armed', senderId, error);
    }
  }

  private async recordOpen(
    senderId: string,
    requestId: string,
    subtype: SchedulingOffer['subtype'],
  ): Promise<void> {
    try {
      await this.ports.registry.recordOpenRequest({
        requestId,
        conversationRef: conversationRefFor(senderId),
        subtype,
        legacyId: null,
      });
    } catch (error) {
      this.warn(
        `request ${requestId} booked but its registry row failed`,
        senderId,
        error,
      );
    }
  }

  /** Best-effort offer drop (the customer was already answered). */
  private async dropOffer(senderId: string): Promise<void> {
    try {
      await this.ports.state.clearOffer(senderId);
    } catch (error) {
      this.warn('offer not dropped', senderId, error);
    }
  }

  private masked(senderId: string): string {
    return maskConversationRef(conversationRefFor(senderId));
  }

  private warn(what: string, senderId: string, error: unknown): void {
    this.logger.warn(
      `scheduling policy: ${what} for ${this.masked(senderId)}: ${describeError(error)}`,
    );
  }
}

const PASS: ReplyOutcome = { kind: 'pass' };
