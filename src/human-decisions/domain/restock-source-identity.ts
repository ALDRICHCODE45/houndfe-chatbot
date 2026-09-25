/**
 * R3b3-c4b PURE deterministic binding from an inbound WhatsApp event to the
 * RESTOCK `sourceRequestId`. Same event → same UUID across restarts/deploys;
 * any field change → a distinct UUID. No `randomUUID`, no persistence.
 *
 * The source event MUST be the actual customer message that triggers the
 * request. It is NOT a synthetic ops turn, a newly minted id, or a value
 * re-derived per retry: an ops/synthetic turn would collide with (or shadow)
 * the customer's own id. And it is NOT sufficient to assume webhook dedup
 * already gives a stable id — that only proves a delivery was seen once for
 * this process. The stability below comes from the identity bytes, not from any
 * dedup or from a persisted per-event mapping (that mapping is a separate,
 * deliberately unbuilt concern). The bytes are used verbatim (no trim, no case
 * fold): the name is the exact `JSON.stringify` of a fixed tagged tuple, so two
 * different events cannot alias into one id via normalization.
 */
import { createHash } from 'node:crypto';

/**
 * Fixed repository constant RFC4122 namespace. Changing it re-keys every id, so
 * it is a published contract: never rotate it in place.
 */
export const RESTOCK_SOURCE_NAMESPACE = '4f3f1a2e-9c7b-4d1e-8a2f-6b5c0d9e1f23';

/**
 * Exact inbound identity that binds a RESTOCK event. All three fields are
 * required and travel verbatim; this is the only shape a downstream turn may
 * forward. It carries no derived id — the id stays internal to the deriver.
 */
export interface RestockInboundEventIdentity {
  readonly receivingPhoneNumberId: string;
  readonly senderId: string;
  readonly messageId: string;
}

/** Versioned name tag; a future shape must ship as a NEW tag, not a mutation. */
const EVENT_NAME_PREFIX = 'RESTOCK/v1';
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

/** RFC4122 UUIDv5: SHA1(namespace bytes ‖ UTF-8 name), version 5 + variant. */
function uuidV5(namespace: string, name: string): string {
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Deterministically bind an inbound event to a RESTOCK `sourceRequestId`, or
 * `null` when the event is not a valid, unambiguous identity. Always a
 * canonical lowercase UUIDv5 that satisfies the backend UUID pattern.
 */
export function deriveRestockSourceRequestId(input: unknown): string | null {
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
  return uuidV5(RESTOCK_SOURCE_NAMESPACE, name);
}

/**
 * Validate one inbound identity against a TRUSTED expected sender and return
 * its FROZEN copy plus the derived `sourceRequestId`, or `null`.
 *
 * Safety: the id is derived first (`deriveRestockSourceRequestId(input)`), then
 * the three ORIGINAL fields are copied and the copy is re-derived and must
 * equal the first id. That re-derivation is the TOCTOU probe: a rotating or
 * throwing getter yields a different (or absent) id and the bind fails closed.
 * Only after the comparison is the already-frozen copy returned — the raw input
 * is not read again. Every throw becomes `null`; this never throws and never
 * mutates its input.
 */
export function bindRestockInboundEvent(
  input: unknown,
  expectedSenderId: string,
): {
  readonly event: Readonly<RestockInboundEventIdentity>;
  readonly sourceRequestId: string;
} | null {
  try {
    const sourceRequestId = deriveRestockSourceRequestId(input);
    if (sourceRequestId === null) return null;
    // SAFETY: `deriveRestockSourceRequestId` above already accepted `input` as
    // exactly the three bounded string fields, and the re-derivation below
    // re-checks every copied byte before anything is returned.
    const source = input as RestockInboundEventIdentity;
    const event = Object.freeze({
      receivingPhoneNumberId: source.receivingPhoneNumberId,
      senderId: source.senderId,
      messageId: source.messageId,
    });
    if (event.senderId !== expectedSenderId) return null;
    if (deriveRestockSourceRequestId(event) !== sourceRequestId) return null;
    return { event, sourceRequestId };
  } catch {
    return null;
  }
}
