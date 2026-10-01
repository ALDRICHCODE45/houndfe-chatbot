/**
 * EXPIRATION source identity — PURE deterministic binding from an inbound
 * WhatsApp event to the EXPIRATION `sourceRequestId`. Mirrors
 * `restock-source-identity.ts` with a distinct immutable namespace + name tag
 * for domain separation, not a guarantee against hash collisions. Same event
 * → same UUID. No `randomUUID`, no persistence, no I/O.
 * Bytes travel verbatim (no trim, no case fold), so no normalization can alias.
 *
 * A syntactically valid tuple is NOT provenance proof: this binds bytes, not
 * origins; only the caller can guarantee the bytes are the customer's real
 * inbound (an ops/synthetic turn forwarding the same fields derives the same id).
 */
import { uuidV5 } from './restock-source-identity';

/**
 * Fixed repository constant RFC4122 namespace. Changing it re-keys every id, so
 * it is a published contract: never rotate it in place.
 */
export const EXPIRATION_SOURCE_NAMESPACE =
  '2b7d4c1a-6e8f-4a3b-9d2c-5f0a1b7e9c34';

/**
 * Exact inbound identity that binds an EXPIRATION event. All three fields are
 * required and travel verbatim; it carries no derived id.
 */
export interface ExpirationInboundEventIdentity {
  readonly receivingPhoneNumberId: string;
  readonly senderId: string;
  readonly messageId: string;
}

/** Versioned name tag; a future shape must ship as a NEW tag, not a mutation. */
const EVENT_NAME_PREFIX = 'EXPIRATION/v1';
const MAX_PHONE_ID = 24;
const MAX_SENDER_ID = 200;
const MAX_MESSAGE_ID = 512;
const DIGITS = /^\d+$/;
const REQUIRED_KEYS = [
  'receivingPhoneNumberId',
  'senderId',
  'messageId',
] as const;

/**
 * Snapshot the exact three own data descriptors into a null-prototype record.
 * A non-plain object, wrong/inherited/extra key, accessor, undefined value, or
 * a read that diverges from its descriptor (Proxy) fails closed with `null`.
 */
function snapshotExact(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== REQUIRED_KEYS.length) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of own) {
      if (
        typeof key !== 'string' ||
        !(REQUIRED_KEYS as readonly string[]).includes(key)
      ) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return null;
      const read = (value as Record<string, unknown>)[key];
      if (!Object.is(descriptor.value, read)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** Strict bounded identity: exact bytes only, no surrounding whitespace. */
function identity(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  return value === value.trim() ? value : null;
}

/**
 * Deterministically bind an inbound event to an EXPIRATION `sourceRequestId`, or
 * `null` when the event is not a valid, unambiguous identity. Always a
 * canonical lowercase UUIDv5 that satisfies the backend UUID pattern.
 */
export function deriveExpirationSourceRequestId(input: unknown): string | null {
  const event = snapshotExact(input);
  if (event === null) return null;
  const phone = event.receivingPhoneNumberId;
  if (
    typeof phone !== 'string' ||
    phone.length > MAX_PHONE_ID ||
    !DIGITS.test(phone)
  ) {
    return null;
  }
  const senderId = identity(event.senderId, MAX_SENDER_ID);
  const messageId = identity(event.messageId, MAX_MESSAGE_ID);
  if (senderId === null || messageId === null) return null;
  const name = JSON.stringify([EVENT_NAME_PREFIX, phone, senderId, messageId]);
  return uuidV5(EXPIRATION_SOURCE_NAMESPACE, name);
}

/**
 * Validate one inbound identity against a TRUSTED expected sender and return
 * its FROZEN detached copy plus the derived `sourceRequestId`, or `null`.
 *
 * Safety: the id is derived first, then the three ORIGINAL fields are copied
 * and re-derived and must equal the first id. That re-derivation is the TOCTOU
 * probe: a rotating or throwing getter yields a different (or absent) id and
 * the bind fails closed. Only after the comparison is the already-frozen copy
 * returned. Every throw becomes `null`; never throws, never mutates its input.
 */
export function bindExpirationInboundEvent(
  input: unknown,
  expectedSenderId: string,
): {
  readonly event: Readonly<ExpirationInboundEventIdentity>;
  readonly sourceRequestId: string;
} | null {
  try {
    const sourceRequestId = deriveExpirationSourceRequestId(input);
    if (sourceRequestId === null) return null;
    // SAFETY: the derivation above accepted `input` as exactly the three
    // bounded string fields; the re-derivation below re-checks every byte.
    const source = input as ExpirationInboundEventIdentity;
    const event = Object.freeze({
      receivingPhoneNumberId: source.receivingPhoneNumberId,
      senderId: source.senderId,
      messageId: source.messageId,
    });
    if (event.senderId !== expectedSenderId) return null;
    if (deriveExpirationSourceRequestId(event) !== sourceRequestId) return null;
    return { event, sourceRequestId };
  } catch {
    return null;
  }
}
