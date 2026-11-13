import type { ConversationMirrorCommonFailure } from './conversation-mirror.dto';

/**
 * Scheduled conversations (backend unit 14, houndfe-backend
 * `docs/chatbot-handoff/chatbot-requests-bot-contract.md` §"Scheduled
 * conversations (unit 14)", commit 5b549e18): the slots read, the reschedule
 * call, and the shared bodies of the booking (`POST /chatbot-api/requests`
 * with `scheduledFor`) and reschedule 409s.
 *
 * Error style (same as the unit 9/11 routes): every documented answer is a
 * typed result discriminated by `kind`; nothing here echoes the
 * `conversationRef` or a phone in an error or result (S5). Parsing is
 * fail-closed on missing keys and wrong types, never throws, and drops unknown
 * extra keys.
 */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SCHEDULING_TRIGGER_WA_MESSAGE_ID_MAX_CHARS = 512;

export type SchedulingFailure = ConversationMirrorCommonFailure;

export const SCHEDULING_WEEK_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type SchedulingWeekDay = (typeof SCHEDULING_WEEK_DAYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A non-empty string that starts like an ISO-8601 instant and parses. */
export function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

// ------------------------------------------------------------------ slots

export interface SchedulingSlot {
  /** ISO-8601 instant: also the exact `scheduledFor` to book. */
  startsAt: string;
  /** `startsAt + 15 min < whatsappWindowClosesAt` (the greeting is free). */
  withinWindow: boolean;
}

export interface SchedulingWeeklyRange {
  day: SchedulingWeekDay;
  /** `HH:mm` in the branch zone; empty when the day is closed. */
  ranges: { open: string; close: string }[];
}

export interface SchedulingBusinessHours {
  openNow: boolean;
  nextOpenAt: string | null;
  timeZone: string;
  /** The seven days, Monday first. */
  weeklyRanges: SchedulingWeeklyRange[];
  /** `YYYY-MM-DD`, today through the next 14 days, sorted. */
  closedDates: string[];
}

export interface ListSlotsInput {
  conversationRef: string;
  /** Always send it: when unknown the backend assumes the window is closed. */
  lastCustomerMessageAt: string;
}

export interface SlotsAnswer {
  /** The branch's IANA zone; format every time with it, never an offset. */
  timeZone: string;
  whatsappWindowClosesAt: string;
  businessHours: SchedulingBusinessHours;
  /** At most 3, earliest first; `[]` when nothing is free for 14 days. */
  slots: SchedulingSlot[];
}

export type ListSlotsResult =
  | ({ kind: 'ok' } & SlotsAnswer)
  /** 422: the branch has scheduling off; fall back to the unit 11 create. */
  | { kind: 'SCHEDULING_DISABLED' }
  | SchedulingFailure;

/** A fixed, input-free reason when the input breaks the contract, or null. */
export function listSlotsProblem(input: unknown): string | null {
  if (!isRecord(input)) return 'input must be an object';
  if (!isIsoInstant(input.lastCustomerMessageAt))
    return 'lastCustomerMessageAt must be an ISO-8601 instant';
  return null;
}

/** Slots with `available: false` are dropped (the contract says never). */
function parseSlot(raw: unknown): SchedulingSlot | null | 'skip' {
  if (!isRecord(raw)) return null;
  if (!isIsoInstant(raw.startsAt) || typeof raw.withinWindow !== 'boolean')
    return null;
  if (raw.available === false) return 'skip';
  return { startsAt: raw.startsAt, withinWindow: raw.withinWindow };
}

export function parseSchedulingSlots(raw: unknown): SchedulingSlot[] | null {
  if (!Array.isArray(raw)) return null;
  const slots: SchedulingSlot[] = [];
  for (const item of raw) {
    const slot = parseSlot(item);
    if (slot === null) return null;
    if (slot !== 'skip') slots.push(slot);
  }
  return slots;
}

function parseWeeklyRanges(raw: unknown): SchedulingWeeklyRange[] | null {
  if (!Array.isArray(raw)) return null;
  const days: SchedulingWeeklyRange[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !Array.isArray(item.ranges)) return null;
    const { day } = item;
    if (!(SCHEDULING_WEEK_DAYS as readonly unknown[]).includes(day))
      return null;
    const ranges: { open: string; close: string }[] = [];
    for (const range of item.ranges as unknown[]) {
      if (!isRecord(range) || !isText(range.open) || !isText(range.close))
        return null;
      ranges.push({ open: range.open, close: range.close });
    }
    days.push({ day: day as SchedulingWeekDay, ranges });
  }
  return days;
}

export function parseSchedulingBusinessHours(
  raw: unknown,
): SchedulingBusinessHours | null {
  if (!isRecord(raw)) return null;
  const { openNow, nextOpenAt, timeZone, closedDates } = raw;
  if (typeof openNow !== 'boolean' || !isText(timeZone)) return null;
  if (nextOpenAt !== null && !isIsoInstant(nextOpenAt)) return null;
  const weeklyRanges = parseWeeklyRanges(raw.weeklyRanges);
  if (weeklyRanges === null) return null;
  if (!Array.isArray(closedDates) || !closedDates.every(isText)) return null;
  return {
    openNow,
    nextOpenAt,
    timeZone,
    weeklyRanges,
    closedDates: [...closedDates],
  };
}

export function parseSlotsAnswer(body: unknown): SlotsAnswer | null {
  if (!isRecord(body)) return null;
  const { timeZone, whatsappWindowClosesAt } = body;
  if (!isText(timeZone) || !isIsoInstant(whatsappWindowClosesAt)) return null;
  const slots = parseSchedulingSlots(body.slots);
  const businessHours = parseSchedulingBusinessHours(body.businessHours);
  if (slots === null || businessHours === null) return null;
  return { timeZone, whatsappWindowClosesAt, businessHours, slots };
}

// ------------------------------------------------- shared 409 bodies

/** 409 `SLOT_UNAVAILABLE` (booking and reschedule): re-offer `slots`, never
 *  retry the same slot. */
export interface SlotUnavailable {
  kind: 'SLOT_UNAVAILABLE';
  slots: SchedulingSlot[];
  timeZone: string;
  whatsappWindowClosesAt: string;
}

export function parseSlotUnavailable(body: unknown): SlotUnavailable | null {
  const answer = parseSlotsPartial(body);
  return answer === null ? null : { kind: 'SLOT_UNAVAILABLE', ...answer };
}

function parseSlotsPartial(
  body: unknown,
): Omit<SlotUnavailable, 'kind'> | null {
  if (!isRecord(body)) return null;
  const { timeZone, whatsappWindowClosesAt } = body;
  if (!isText(timeZone) || !isIsoInstant(whatsappWindowClosesAt)) return null;
  const slots = parseSchedulingSlots(body.slots);
  if (slots === null) return null;
  return { slots, timeZone, whatsappWindowClosesAt };
}

/** 409 `ALREADY_SCHEDULED` on a booking: offer to reschedule `requestId`. */
export interface AlreadyScheduled {
  kind: 'ALREADY_SCHEDULED';
  requestId: string;
  scheduledFor: string;
}

export function parseAlreadyScheduled(body: unknown): AlreadyScheduled | null {
  if (!isRecord(body)) return null;
  const { requestId, scheduledFor } = body;
  if (!isText(requestId) || !isIsoInstant(scheduledFor)) return null;
  return { kind: 'ALREADY_SCHEDULED', requestId, scheduledFor };
}

// ------------------------------------------------- booking answer fields

/** The scheduling fields the create answer adds when `scheduledFor` was sent. */
export interface ScheduledBookingFields {
  scheduledFor: string;
  scheduleVersion: number;
  requiresTemplateAtStart: boolean;
  whatsappWindowClosesAt: string;
}

/**
 * `undefined` when the answer carries no `scheduledFor` (an unscheduled
 * create: nothing to add), `null` when it does but the rest breaks the
 * contract, else the fields.
 */
export function parseScheduledBookingFields(
  body: Record<string, unknown>,
): ScheduledBookingFields | null | undefined {
  const { scheduledFor, scheduleVersion, requiresTemplateAtStart } = body;
  if (scheduledFor === undefined || scheduledFor === null) return undefined;
  if (
    !isIsoInstant(scheduledFor) ||
    !Number.isSafeInteger(scheduleVersion) ||
    (scheduleVersion as number) < 1 ||
    typeof requiresTemplateAtStart !== 'boolean' ||
    !isIsoInstant(body.whatsappWindowClosesAt)
  )
    return null;
  return {
    scheduledFor,
    scheduleVersion: scheduleVersion as number,
    requiresTemplateAtStart,
    whatsappWindowClosesAt: body.whatsappWindowClosesAt,
  };
}

// ------------------------------------------------------------- reschedule

export interface RescheduleRequestInput {
  /** Exactly the `startsAt` of a bookable block. */
  scheduledFor: string;
  /** Always send it when known (unknown window = closed). */
  lastCustomerMessageAt?: string;
  /** Audit only (idempotency is the `X-Idempotency-Key`). */
  triggerWaMessageId?: string;
}

export type RescheduleRequestResult =
  /** 200. `UNCHANGED`: the same slot, nothing changed (the body then carries
   *  no previous time / template flag, read as null). */
  | {
      kind: 'ok';
      status: 'RESCHEDULED' | 'UNCHANGED';
      requestId: string;
      scheduledFor: string;
      previousScheduledFor: string | null;
      scheduleVersion: number;
      requiresTemplateAtStart: boolean | null;
      whatsappWindowClosesAt: string | null;
    }
  | SlotUnavailable
  /** 409: already RESOLVED or CANCELLED. */
  | { kind: 'REQUEST_CLOSED' }
  /** 409: the request has no `scheduledFor` (this is not a way to schedule). */
  | { kind: 'NOT_SCHEDULED' }
  /** 409: a live session has started; the words go to the attendee. */
  | { kind: 'RESCHEDULE_NOT_ALLOWED' }
  /** 409: same key with another body. */
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  /** 422: the branch has scheduling off. */
  | { kind: 'SCHEDULING_DISABLED' }
  /** 404: unknown id or another branch. */
  | { kind: 'NOT_FOUND' }
  | SchedulingFailure;

export function isSchedulingIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A fixed, input-free reason when the call breaks the contract, or null. */
export function rescheduleProblem(
  requestId: unknown,
  input: unknown,
  idempotencyKey: unknown,
): string | null {
  if (!isText(requestId)) return 'requestId must be a non-empty string';
  if (!isSchedulingIdempotencyKey(idempotencyKey))
    return 'idempotencyKey must be a UUID';
  if (!isRecord(input)) return 'input must be an object';
  const { scheduledFor, lastCustomerMessageAt, triggerWaMessageId } = input;
  if (!isIsoInstant(scheduledFor))
    return 'scheduledFor must be an ISO-8601 instant';
  if (
    lastCustomerMessageAt !== undefined &&
    !isIsoInstant(lastCustomerMessageAt)
  )
    return 'lastCustomerMessageAt must be an ISO-8601 instant';
  if (
    triggerWaMessageId !== undefined &&
    (typeof triggerWaMessageId !== 'string' ||
      triggerWaMessageId.length < 1 ||
      triggerWaMessageId.length > SCHEDULING_TRIGGER_WA_MESSAGE_ID_MAX_CHARS)
  )
    return `triggerWaMessageId must hold 1 to ${SCHEDULING_TRIGGER_WA_MESSAGE_ID_MAX_CHARS} characters`;
  return null;
}

/** Exactly the contract keys, in a fixed order (extra keys are a 400). */
export function toRescheduleBody(
  input: RescheduleRequestInput,
): Record<string, unknown> {
  const wire: Record<string, unknown> = { scheduledFor: input.scheduledFor };
  if (input.lastCustomerMessageAt !== undefined)
    wire.lastCustomerMessageAt = input.lastCustomerMessageAt;
  if (input.triggerWaMessageId !== undefined)
    wire.triggerWaMessageId = input.triggerWaMessageId;
  return wire;
}

export function parseRescheduleOk(
  body: unknown,
  requestId: string,
): Extract<RescheduleRequestResult, { kind: 'ok' }> | null {
  if (!isRecord(body)) return null;
  const { id, outcome, scheduledFor, scheduleVersion } = body;
  if (id !== requestId) return null;
  if (outcome !== 'RESCHEDULED' && outcome !== 'UNCHANGED') return null;
  if (!isIsoInstant(scheduledFor)) return null;
  if (!Number.isSafeInteger(scheduleVersion) || (scheduleVersion as number) < 1)
    return null;
  const previous = body.previousScheduledFor ?? null;
  const template = body.requiresTemplateAtStart ?? null;
  const closes = body.whatsappWindowClosesAt ?? null;
  if (previous !== null && !isIsoInstant(previous)) return null;
  if (template !== null && typeof template !== 'boolean') return null;
  if (closes !== null && !isIsoInstant(closes)) return null;
  return {
    kind: 'ok',
    status: outcome,
    requestId,
    scheduledFor,
    previousScheduledFor: previous,
    scheduleVersion: scheduleVersion as number,
    requiresTemplateAtStart: template,
    whatsappWindowClosesAt: closes,
  };
}

// ------------------------------------------------- scheduledRequest (state)

/** The chat's nearest open scheduled request, as the state routes carry it. */
export interface ScheduledRequestSummary {
  requestId: string;
  subtype: string;
  scheduledFor: string;
  needsReschedule: boolean;
  scheduleVersion: number;
}

/** `null` for a missing, null or malformed value: it is informational and
 *  must never break the mode/epoch read the silence protocol relies on. */
export function parseScheduledRequestSummary(
  raw: unknown,
): ScheduledRequestSummary | null {
  if (!isRecord(raw)) return null;
  const { requestId, subtype, scheduledFor, needsReschedule, scheduleVersion } =
    raw;
  if (
    !isText(requestId) ||
    !isText(subtype) ||
    !isIsoInstant(scheduledFor) ||
    typeof needsReschedule !== 'boolean' ||
    !Number.isSafeInteger(scheduleVersion) ||
    (scheduleVersion as number) < 1
  )
    return null;
  return {
    requestId,
    subtype,
    scheduledFor,
    needsReschedule,
    scheduleVersion: scheduleVersion as number,
  };
}
