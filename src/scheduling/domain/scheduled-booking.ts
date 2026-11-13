import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { CreateDirectHumanRequestInput } from '../../chatbot-api/domain/dtos/human-requests.dto';
import { TALK_TO_HUMAN_SUMMARY } from '../../human-requests/domain/human-request-create';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import type { SchedulingSubtype } from '../../conversation/domain/scheduling-state';

/** Backend bounds for `lastCustomerMessageAt` (contract: ≤ 5 min ahead, ≤ 30
 *  days old, else 400). */
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * The inbound's time as the `lastCustomerMessageAt` to send; `now` when it is
 * absent, unparsable or out of the backend's bounds. Always a value: an
 * unknown window is read as closed by the backend, so the bot always sends one.
 */
export function lastCustomerMessageAtFor(
  inboundAt: string | null | undefined,
  now: Date,
): string {
  const at = typeof inboundAt === 'string' ? Date.parse(inboundAt) : NaN;
  const nowMs = now.getTime();
  return Number.isNaN(at) ||
    at > nowMs + MAX_FUTURE_MS ||
    at < nowMs - MAX_AGE_MS
    ? now.toISOString()
    : new Date(at).toISOString();
}

export interface ScheduledBookingInput {
  /** Raw Meta wa_id. */
  senderId: string;
  /** Also the `X-Idempotency-Key`: the offer's key, so a retry replays. */
  sourceRequestId: string;
  subtype: SchedulingSubtype;
  /** Exactly the `startsAt` of an offered slot. */
  scheduledFor: string;
  lastCustomerMessageAt: string;
  triggerWaMessageId?: string | null;
}

/**
 * The scheduled TALK_TO_HUMAN / COMPLAINT create body, or null when the
 * sender is unusable. No `dedupKey` (a scheduled create never merges) and no
 * `needs` (the customer's reply was a slot number, not a need).
 */
export function buildScheduledRequest(
  input: ScheduledBookingInput,
): CreateDirectHumanRequestInput | null {
  const phone = parseMexicanWhatsAppPhone(input.senderId);
  if (phone === null) return null;
  const trigger = input.triggerWaMessageId;
  return {
    sourceRequestId: input.sourceRequestId,
    subtype: input.subtype,
    customer: {
      phoneCountryCode: phone.phoneCountryCode,
      phone: phone.phone,
    },
    conversationRef: conversationRefFor(input.senderId),
    lastCustomerMessageAt: input.lastCustomerMessageAt,
    summary: TALK_TO_HUMAN_SUMMARY,
    scheduledFor: input.scheduledFor,
    ...(typeof trigger === 'string' && trigger !== ''
      ? { triggerWaMessageId: trigger }
      : {}),
  };
}
