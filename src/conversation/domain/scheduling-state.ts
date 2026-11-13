/**
 * Unit 14 T2: the durable per-conversation scheduling state, stored under the
 * CAS-owned key `conversation_state.data.scheduling` (like `handoff` and the
 * cart): `{ offer, appointment }`, both always present (null when absent).
 *
 *  - `offer`: up to 3 slots shown to the customer, awaiting a choice. It
 *    expires ~30 minutes after `offeredAt`. `sourceRequestId` is the
 *    idempotency key of the booking that will follow (so a retry replays the
 *    same create); `unclearCount` counts "no entendí" answers.
 *  - `appointment`: the customer's nearest open scheduled request, as the bot
 *    knows it. `scheduleVersion` 0 means "unknown, any newer version wins".
 *    `timeZone` is null when the appointment was recovered from the state
 *    route (which does not carry it).
 *
 * Readers are lenient (a malformed half reads as null, never throws); the
 * write guard `normalizeSchedulingState` is strict. No phone or conversation
 * ref is ever stored here.
 */

export const OFFER_TTL_MS = 30 * 60_000;
const MAX_OFFERED_SLOTS = 3;

export type SchedulingSubtype = 'TALK_TO_HUMAN' | 'COMPLAINT';

export interface OfferedSlotState {
  /** ISO-8601 instant: exactly the `scheduledFor` to book. */
  startsAt: string;
  withinWindow: boolean;
}

export interface SchedulingOffer {
  slots: OfferedSlotState[];
  /** The branch's IANA zone, from the API. */
  timeZone: string;
  /** ISO-8601; the offer expires `OFFER_TTL_MS` after it. */
  offeredAt: string;
  subtype: SchedulingSubtype;
  /** Idempotency key of the booking this offer leads to. */
  sourceRequestId: string;
  /** `{cuándo}` the branch opens ("mañana a las 9:00 a. m."), when known. */
  openWhen?: string;
  /** How many answers were not understood (the second drops the offer). */
  unclearCount: number;
  /** Unit 14 T4: present when this is a RESCHEDULE offer for that request
   *  (`sourceRequestId` is then the reschedule's idempotency key). */
  rescheduleRequestId?: string;
}

export interface SchedulingAppointment {
  requestId: string;
  subtype: string;
  scheduledFor: string;
  /** 0 = unknown. */
  scheduleVersion: number;
  timeZone: string | null;
  rescheduleCount: number;
  /** Unit 14 T4: when «¿Quiere cambiarla?» was asked (the next "sí" is the
   *  answer, for a few minutes). */
  changeAskedAt?: string;
}

export interface SchedulingState {
  offer: SchedulingOffer | null;
  appointment: SchedulingAppointment | null;
  /** Unit 14 F5: customer reschedules in this conversation (cap 3). A sibling
   *  of offer/appointment, so it survives clearing the appointment, a new
   *  booking and a recovery. Absent = 0; see `effectiveRescheduleCount`. */
  rescheduleCount?: number;
}

/** The reschedules used so far: the conversation count, or the legacy
 *  per-appointment field when that is larger (older stored documents). */
export function effectiveRescheduleCount(state: SchedulingState): number {
  return Math.max(
    state.rescheduleCount ?? 0,
    state.appointment?.rescheduleCount ?? 0,
  );
}

export const EMPTY_SCHEDULING_STATE: Readonly<SchedulingState> = Object.freeze({
  offer: null,
  appointment: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readSlots(raw: unknown): OfferedSlotState[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OFFERED_SLOTS)
    return null;
  const slots: OfferedSlotState[] = [];
  for (const item of raw as unknown[]) {
    if (
      !isRecord(item) ||
      !isInstant(item.startsAt) ||
      typeof item.withinWindow !== 'boolean'
    )
      return null;
    slots.push({ startsAt: item.startsAt, withinWindow: item.withinWindow });
  }
  return slots;
}

function readOffer(raw: unknown): SchedulingOffer | null {
  if (!isRecord(raw)) return null;
  const slots = readSlots(raw.slots);
  if (
    slots === null ||
    !isText(raw.timeZone) ||
    !isInstant(raw.offeredAt) ||
    (raw.subtype !== 'TALK_TO_HUMAN' && raw.subtype !== 'COMPLAINT') ||
    !isText(raw.sourceRequestId) ||
    (raw.rescheduleRequestId !== undefined && !isText(raw.rescheduleRequestId))
  )
    return null;
  const unclearCount = raw.unclearCount === undefined ? 0 : raw.unclearCount;
  if (!isCount(unclearCount)) return null;
  return {
    slots,
    timeZone: raw.timeZone,
    offeredAt: raw.offeredAt,
    subtype: raw.subtype,
    sourceRequestId: raw.sourceRequestId,
    ...(isText(raw.openWhen) ? { openWhen: raw.openWhen } : {}),
    unclearCount,
    ...(raw.rescheduleRequestId === undefined
      ? {}
      : { rescheduleRequestId: raw.rescheduleRequestId }),
  };
}

function readAppointment(raw: unknown): SchedulingAppointment | null {
  if (!isRecord(raw)) return null;
  if (
    !isText(raw.requestId) ||
    !isText(raw.subtype) ||
    !isInstant(raw.scheduledFor) ||
    !isCount(raw.scheduleVersion) ||
    !(raw.timeZone === null || isText(raw.timeZone)) ||
    !isCount(raw.rescheduleCount) ||
    (raw.changeAskedAt !== undefined && !isInstant(raw.changeAskedAt))
  )
    return null;
  return {
    requestId: raw.requestId,
    subtype: raw.subtype,
    scheduledFor: raw.scheduledFor,
    scheduleVersion: raw.scheduleVersion,
    timeZone: raw.timeZone,
    rescheduleCount: raw.rescheduleCount,
    ...(raw.changeAskedAt === undefined
      ? {}
      : { changeAskedAt: raw.changeAskedAt }),
  };
}

/** A stored `data.scheduling` value as a detached state; malformed halves
 *  (or a non-object value) read as null. */
export function readSchedulingState(raw: unknown): SchedulingState {
  if (!isRecord(raw)) return { offer: null, appointment: null };
  return {
    offer: readOffer(raw.offer),
    appointment: readAppointment(raw.appointment),
    ...(isCount(raw.rescheduleCount)
      ? { rescheduleCount: raw.rescheduleCount }
      : {}),
  };
}

/** Write guard: the canonical document, or null when anything is malformed
 *  (a half is never silently dropped on a write). */
export function normalizeSchedulingState(
  value: unknown,
): SchedulingState | null {
  if (!isRecord(value)) return null;
  const { offer, appointment, rescheduleCount } = value;
  if (offer === undefined || appointment === undefined) return null;
  if (rescheduleCount !== undefined && !isCount(rescheduleCount)) return null;
  const normalizedOffer = offer === null ? null : readOffer(offer);
  const normalizedAppointment =
    appointment === null ? null : readAppointment(appointment);
  if (offer !== null && normalizedOffer === null) return null;
  if (appointment !== null && normalizedAppointment === null) return null;
  return {
    offer: normalizedOffer,
    appointment: normalizedAppointment,
    ...(rescheduleCount === undefined ? {} : { rescheduleCount }),
  };
}

/** Expired at `offeredAt + OFFER_TTL_MS`; an unparsable instant is expired. */
export function isOfferExpired(offer: SchedulingOffer, now: Date): boolean {
  const offeredAt = Date.parse(offer.offeredAt);
  if (Number.isNaN(offeredAt)) return true;
  return now.getTime() >= offeredAt + OFFER_TTL_MS;
}
