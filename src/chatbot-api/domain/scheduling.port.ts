import type {
  ListSlotsInput,
  ListSlotsResult,
  RescheduleRequestInput,
  RescheduleRequestResult,
} from './dtos/scheduling.dto';

export const SCHEDULING_CLIENT = Symbol('SCHEDULING_CLIENT');

/**
 * Scheduled conversations (backend unit 14), a separate port so existing
 * client fakes stay valid. Implemented by the HTTP adapter. Booking is the
 * existing `HumanRequestsClient.createHumanRequest` with `scheduledFor`.
 *
 * Every documented answer, including HTTP errors, 5xx, timeouts and network
 * failures, resolves as a typed result discriminated by `kind`; the methods
 * never throw, never retry (the caller decides: a SLOT_UNAVAILABLE means
 * re-offer, not retry the same slot) and never put the `conversationRef` or a
 * phone in a result or a log (S5). Local contract violations resolve as
 * `VALIDATION_ERROR { local: true }` before any request is made.
 */
export interface SchedulingClient {
  /** `GET /chatbot-api/scheduling/slots?conversationRef=&lastCustomerMessageAt=`
   *  (scope `requests:read`). `SCHEDULING_DISABLED` is the cue to fall back to
   *  the unit 11 out-of-hours create; `slots: []` means no free time. */
  listSlots(input: ListSlotsInput): Promise<ListSlotsResult>;
  /** `POST /chatbot-api/requests/:id/reschedule` (scope `requests:create`)
   *  with `X-Idempotency-Key` (a UUID). Only while the request is WAITING. */
  rescheduleRequest(
    requestId: string,
    input: RescheduleRequestInput,
    idempotencyKey: string,
  ): Promise<RescheduleRequestResult>;
}
