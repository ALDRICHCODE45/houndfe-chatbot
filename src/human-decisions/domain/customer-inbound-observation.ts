import { types } from 'node:util';

/**
 * Exact immutable inbound coordinates for one verified customer message: five
 * strings only, no `sourceRequestId`, version, request/product identity,
 * authorization, latestness or eligibility. Shape never authenticates an event.
 */
export type CustomerInboundObservation = Readonly<{
  senderId: string;
  receivingPhoneNumberId: string;
  messageId: string;
  providerTimestampSeconds: string;
  observedAt: string;
}>;

const KEYS =
  'senderId receivingPhoneNumberId messageId providerTimestampSeconds observedAt'.split(
    ' ',
  );

/**
 * Snapshot exactly the five own data descriptors, or null. Symbols, extras,
 * arrays, accessors, a foreign prototype and every Proxy fail closed without
 * executing a getter or Proxy trap. Detached from the caller's original object.
 */
function ownData(value: unknown): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== KEYS.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of own) {
    if (typeof key !== 'string' || !KEYS.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

/** Opaque bounded identity: 1..limit UTF-16 units, trimmed, no C0/DEL/C1. */
function opaque(value: unknown, limit: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

/** Canonical positive provider seconds as safe finite milliseconds, or null. */
function providerMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const seconds = Number(value);
  const ms = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(ms)) return null;
  if (!Number.isFinite(new Date(ms).getTime())) return null;
  return ms;
}

/** Canonical UTC instant from an exact `toISOString()` round-trip, or null. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value
    ? time.getTime()
    : null;
}

/**
 * Inert, pure boundary normalization of one captured or persisted observation.
 * Returns a detached frozen exact-five-string record or null. `receivingPhoneNumberId`
 * is digits 1..24; `senderId`/`messageId` are opaque 1..200/1..512 UTF-16 units;
 * provider time is canonical positive seconds with a finite date not after the
 * canonical UTC observation. No ambient clock, I/O or request metadata is used.
 */
export function normalizeCustomerInboundObservation(
  input: unknown,
): CustomerInboundObservation | null {
  try {
    const record = ownData(input);
    if (!record) return null;
    const {
      senderId,
      receivingPhoneNumberId,
      messageId,
      providerTimestampSeconds,
      observedAt,
    } = record;
    if (
      !opaque(senderId, 200) ||
      !opaque(messageId, 512) ||
      typeof receivingPhoneNumberId !== 'string' ||
      !/^[0-9]{1,24}$/.test(receivingPhoneNumberId) ||
      typeof providerTimestampSeconds !== 'string' ||
      typeof observedAt !== 'string'
    )
      return null;
    const provider = providerMs(providerTimestampSeconds);
    const observed = instant(observedAt);
    if (provider === null || observed === null || provider > observed)
      return null;
    return Object.freeze({
      senderId,
      receivingPhoneNumberId,
      messageId,
      providerTimestampSeconds,
      observedAt,
    });
  } catch {
    return null;
  }
}
