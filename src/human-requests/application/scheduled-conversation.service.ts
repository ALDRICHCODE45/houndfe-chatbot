import { Logger } from '@nestjs/common';
import type { ScheduledConversationItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import {
  reminderText,
  staffChangedText,
} from '../../scheduling/domain/scheduling-copy';
import { formatClock, slotLabel } from '../../scheduling/domain/slot-time';
import {
  senderIdFromRef,
  styleFixedCopy,
  type DeliveryDecision,
  type DeliveryRow,
  type HumanRequestFeedStore,
} from '../domain/human-request-feed';
import type { LivePlan } from './live-conversation.service';

/** The branch zone when neither the item nor the stored appointment names
 *  one (the contract's items carry `timeZone`; this is the safety net). */
export const DEFAULT_BRANCH_TIME_ZONE = 'America/Mexico_City';

/** What the bot holds about a request's appointment (T2's durable state). */
export interface KnownSchedule {
  /** ISO instant of the time the bot last told the customer / booked. */
  scheduledFor: string;
  /** The `scheduleVersion` the bot last saw for it (>= 1). */
  scheduleVersion: number;
  /** The branch IANA zone stored with the appointment, when known. */
  timeZone?: string | null;
}

/**
 * Read-only port over the bot's local appointment state (parent wires it to
 * the scheduling state of T2). `null`: the bot knows nothing about the
 * request (the item is then the truth). Rejects when the read fails
 * (transient: the feed retries the item, nothing is sent).
 */
export interface ScheduledAppointmentReader {
  /** `senderId` (when the caller has it) saves the registry lookup. */
  knownSchedule(
    requestId: string,
    senderId?: string | null,
  ): Promise<KnownSchedule | null>;
}

/** What a staff reschedule item tells the bot to remember. */
export interface StaffRescheduleSync {
  requestId: string;
  scheduledFor: string;
  scheduleVersion: number;
  /** The item's zone, `null` when it names none. */
  timeZone: string | null;
}

/**
 * Write port over the same state (unit 14 T4, L6): a `conversation.rescheduled`
 * item updates the stored appointment (only when its version is newer; the
 * implementation decides). Rejects when the write fails: the feed retries
 * the item.
 */
export interface ScheduledAppointmentWriter {
  recordStaffReschedule(
    senderId: string,
    update: StaffRescheduleSync,
  ): Promise<void>;
}

/** Nest injection token for an optional `ScheduledAppointmentWriter`. */
export const SCHEDULED_APPOINTMENT_WRITER = Symbol(
  'SCHEDULED_APPOINTMENT_WRITER',
);

/** Nest injection token for an optional `ScheduledAppointmentReader`. */
export const SCHEDULED_APPOINTMENT_READER = Symbol(
  'SCHEDULED_APPOINTMENT_READER',
);

export interface ScheduledConversationPorts {
  /** Registry reads only: a request the bot saw closed is not reminded. */
  store: Pick<HumanRequestFeedStore, 'getRequest'>;
  /** Local 24 h window; rejects when the read fails (never "closed"). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
  /** Optional version check; absent → the check is skipped. */
  appointments?: ScheduledAppointmentReader;
  /** Optional: a staff reschedule updates the stored appointment. */
  appointmentWriter?: ScheduledAppointmentWriter;
  clock?: () => Date;
}

export interface ScheduledConversationHandler {
  plan(row: DeliveryRow, item: ScheduledConversationItem): Promise<LivePlan>;
}

const instant = (value: string): number => Date.parse(value);

/** True when the bot holds a newer schedule than the item describes: a
 *  higher version, or the same version at another time (the contract:
 *  "ignore an item whose `scheduledFor` is not the one you hold"). A lower
 *  stored version means the item is the newer truth. */
export function isSupersededSchedule(
  known: KnownSchedule | null,
  item: { scheduledFor: string; scheduleVersion: number },
): boolean {
  if (known === null) return false;
  if (known.scheduleVersion > item.scheduleVersion) return true;
  return (
    known.scheduleVersion === item.scheduleVersion &&
    instant(known.scheduledFor) !== instant(item.scheduledFor)
  );
}

const usableZone = (zone: string | null | undefined): string | null => {
  if (typeof zone !== 'string' || zone === '') return null;
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
};

/**
 * Unit 14 feed items: the 10-minute reminder and the staff reschedule
 * notice. Both are BOT messages (mirrored like any bot message), sent only
 * while the 24 h window is open and the chat is not HUMAN, and never
 * deferred: the delivery service ACKs PROVIDER_ACCEPTED, DELIVERY_UNKNOWN or
 * STALE, never a DEFERRED_* (the backend answers 422). A closed window, a
 * HUMAN chat (checked by the delivery service right before the send), a
 * request closed, a time that already passed or a newer schedule the bot
 * holds are STALE.
 *
 * Nothing here logs the conversation ref, the phone or a message id.
 */
export class ScheduledConversationService implements ScheduledConversationHandler {
  private readonly logger = new Logger(ScheduledConversationService.name);
  private readonly clock: () => Date;

  constructor(private readonly ports: ScheduledConversationPorts) {
    this.clock = ports.clock ?? (() => new Date());
  }

  async plan(
    row: DeliveryRow,
    item: ScheduledConversationItem,
  ): Promise<LivePlan> {
    const sendDecision: DeliveryDecision =
      item.type === 'conversation.scheduled_reminder'
        ? 'REMINDER_SENT'
        : 'RESCHEDULE_NOTICE';
    const senderId = senderIdFromRef(row.conversationRef);
    if (senderId === null) {
      this.logger.warn(
        `feed item ${row.deliveryId} (${item.type}) has no usable conversationRef: STALE`,
      );
      return { action: 'stale', decision: 'NO_CONVERSATION' };
    }
    // A staff reschedule is the new truth whether or not the customer can be
    // told now (closed window, HUMAN chat): "¿a qué hora quedé?" must never
    // answer the old time. Rejects → the item is retried.
    if (item.type === 'conversation.rescheduled')
      await this.ports.appointmentWriter?.recordStaffReschedule(senderId, {
        requestId: item.payload.requestId,
        scheduledFor: item.payload.scheduledFor,
        scheduleVersion: item.payload.scheduleVersion,
        timeZone: usableZone(item.payload.timeZone),
      });
    const stale = await this.staleReason(senderId, item);
    if (stale !== null) {
      this.logger.log(
        `feed item ${row.deliveryId} (${item.type}) not sent: ${stale}`,
      );
      return { action: 'stale', decision: stale };
    }
    const known = await this.known(item.payload.requestId, senderId);
    const timeZone =
      usableZone(item.payload.timeZone) ??
      usableZone(known?.timeZone) ??
      DEFAULT_BRANCH_TIME_ZONE;
    const style = await this.readStyle(senderId);
    const usted =
      item.type === 'conversation.scheduled_reminder'
        ? reminderText(formatClock(item.payload.scheduledFor, timeZone))
        : staffChangedText(
            slotLabel(item.payload.scheduledFor, timeZone, this.clock()),
          );
    return {
      action: 'send',
      decision: sendDecision,
      senderId,
      text: styleFixedCopy(usted, style),
      // Right before the send (after the HUMAN hold): the window and the
      // schedule are read again, so a change after planning is never
      // announced.
      guard: () => this.staleReason(senderId, item),
    };
  }

  /** Why the item must not be said now, or `null` (send). Rejects when a
   *  read fails: the item is retried. */
  private async staleReason(
    senderId: string,
    item: ScheduledConversationItem,
  ): Promise<DeliveryDecision | null> {
    const { requestId, scheduledFor } = item.payload;
    const request = await this.ports.store.getRequest(requestId);
    if (request !== null && request.status !== 'OPEN') return 'REQUEST_CLOSED';
    if (instant(scheduledFor) <= this.clock().getTime())
      return 'STALE_SCHEDULE';
    if (
      isSupersededSchedule(await this.known(requestId, senderId), item.payload)
    )
      return 'STALE_SCHEDULE';
    if (!(await this.ports.isWindowOpen(senderId))) return 'WINDOW_CLOSED';
    return null;
  }

  private known(
    requestId: string,
    senderId: string,
  ): Promise<KnownSchedule | null> {
    return this.ports.appointments === undefined
      ? Promise.resolve(null)
      : this.ports.appointments.knownSchedule(requestId, senderId);
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
