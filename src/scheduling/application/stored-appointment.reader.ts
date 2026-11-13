import type {
  KnownSchedule,
  ScheduledAppointmentReader,
} from '../../human-requests/application/scheduled-conversation.service';
import {
  senderIdFromRef,
  type HumanRequestFeedStore,
} from '../../human-requests/domain/human-request-feed';
import type { SchedulingStateService } from './scheduling-state.service';

export interface StoredAppointmentReaderPorts {
  /** The LOCAL appointment (never the backend); rejects on a store failure. */
  state: Pick<SchedulingStateService, 'findAppointment'>;
  /** Finds the conversation of a request when the caller has no sender. */
  registry: Pick<HumanRequestFeedStore, 'getRequest'>;
}

/**
 * `SCHEDULED_APPOINTMENT_READER` (unit 14 T5 port) backed by the durable
 * scheduling state: what the bot last told the customer about `requestId`.
 * `null` = the bot knows nothing about that request (the feed item is then
 * the truth); a failed read REJECTS, so the feed retries the item instead of
 * guessing. An unknown stored version is 0 (never "newer" than an item).
 */
export class StoredAppointmentReader implements ScheduledAppointmentReader {
  constructor(private readonly ports: StoredAppointmentReaderPorts) {}

  async knownSchedule(
    requestId: string,
    senderId?: string | null,
  ): Promise<KnownSchedule | null> {
    const sender = senderId ?? (await this.senderOf(requestId));
    if (sender === null) return null;
    const appointment = await this.ports.state.findAppointment(sender);
    if (appointment?.requestId !== requestId) return null;
    return {
      scheduledFor: appointment.scheduledFor,
      scheduleVersion: appointment.scheduleVersion,
      timeZone: appointment.timeZone,
    };
  }

  private async senderOf(requestId: string): Promise<string | null> {
    const record = await this.ports.registry.getRequest(requestId);
    return record === null ? null : senderIdFromRef(record.conversationRef);
  }
}
