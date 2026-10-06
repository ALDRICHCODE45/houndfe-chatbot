import { types } from 'node:util';
import { classifyExpirationApplication } from './expiration-application-policy';

export type ExpirationPreSendClassification = Readonly<{
  action: 'within_windows' | 'hold';
}>;
const HOLD: ExpirationPreSendClassification = Object.freeze({ action: 'hold' });
const WITHIN: ExpirationPreSendClassification = Object.freeze({
  action: 'within_windows',
});
const INPUT_KEYS =
  'senderId branchId receivingPhoneNumberId reservation backendDecisionId decision latestInbound now'.split(
    ' ',
  );
const INBOUND_KEYS =
  'senderId receivingPhoneNumberId messageId providerTimestampSeconds observedAt'.split(
    ' ',
  );

function ownData(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
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
  if (own.length !== keys.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function opaque(value: unknown, limit: number): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
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
function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value
    ? time.getTime()
    : null;
}

/** Inactive observation check, NOT permission to send or a latest-inbound reader.
 * Input extends the application-policy fields with receivingPhoneNumberId and
 * latestInbound (the five INBOUND_KEYS). This is not a persisted evidence schema:
 * no sourceRequestId is derived from a later message or rebound to this inquiry.
 * Caller must supply the latest authenticated inbound for this sender/channel,
 * trusted original context/decoded GET JSON, and a fresh clock after all awaits.
 * Shape cannot prove provenance, latestness, a committed claim or lock ownership.
 * A result cannot be cached as later send authority. No I/O, clock, send, template,
 * retry, ACK or mutation. Browsing can renew WhatsApp time, not human resolution.
 */
export function classifyExpirationPreSend(
  input: unknown,
): ExpirationPreSendClassification {
  try {
    const record = ownData(input, INPUT_KEYS);
    if (!record) return HOLD;
    const { receivingPhoneNumberId, latestInbound, ...application } = record;
    if (
      classifyExpirationApplication(application).classification !==
      'within_window'
    )
      return HOLD;
    const inbound = ownData(latestInbound, INBOUND_KEYS);
    if (
      !inbound ||
      !opaque(inbound.senderId, 200) ||
      inbound.senderId !== application.senderId ||
      typeof inbound.receivingPhoneNumberId !== 'string' ||
      !/^[0-9]{1,24}$/.test(inbound.receivingPhoneNumberId) ||
      inbound.receivingPhoneNumberId !== receivingPhoneNumberId ||
      !opaque(inbound.messageId, 512) ||
      typeof inbound.providerTimestampSeconds !== 'string' ||
      !/^[1-9][0-9]*$/.test(inbound.providerTimestampSeconds)
    )
      return HOLD;
    // Safe integer milliseconds also bound the digits-only seconds safely.
    const providerMs = Number(inbound.providerTimestampSeconds) * 1000;
    const observed = instant(inbound.observedAt);
    const now = instant(application.now);
    if (
      !Number.isSafeInteger(providerMs) ||
      !Number.isFinite(new Date(providerMs).getTime()) ||
      observed === null ||
      now === null ||
      providerMs > observed ||
      observed > now ||
      now >= providerMs + 86_400_000
    )
      return HOLD;
    return WITHIN;
  } catch {
    return HOLD;
  }
}
