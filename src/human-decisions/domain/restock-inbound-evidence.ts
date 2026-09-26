import { bindRestockInboundEvent } from './restock-source-identity';

export interface RestockInboundEvidence {
  readonly sourceRequestId: string;
  readonly receivingPhoneNumberId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly providerTimestampSeconds: string;
  readonly observedAt: string;
  readonly version: 1;
}

const IDENTITY_KEYS = ['receivingPhoneNumberId', 'senderId', 'messageId'];
const INPUT_KEYS = ['event', 'providerTimestampSeconds', 'observedAt'];
const ROW_KEYS = [
  ...IDENTITY_KEYS,
  'sourceRequestId',
  'providerTimestampSeconds',
  'observedAt',
  'version',
];

/** Own data only; ordinary accessors rejected. Proxy traps may execute. */
function snapshot(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length) return null;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of own) {
      if (typeof key !== 'string' || !keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return null;
      if (!Object.is(descriptor.value, (value as Record<string, unknown>)[key]))
        return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function assemble(
  event: unknown,
  seconds: unknown,
  observedAt: unknown,
): RestockInboundEvidence | null {
  const identity = snapshot(event, IDENTITY_KEYS);
  if (!identity || typeof identity.senderId !== 'string') return null;
  const binding = bindRestockInboundEvent(identity, identity.senderId);
  if (!binding) return null;
  // Stricter evidence admission, without changing the frozen source namespace.
  // eslint-disable-next-line no-control-regex -- reject C0, DEL and C1 bytes
  const controls = /[\u0000-\u001f\u007f-\u009f]/u;
  if (
    controls.test(binding.event.senderId) ||
    controls.test(binding.event.messageId)
  )
    return null;
  if (typeof seconds !== 'string' || !/^[1-9][0-9]*$/.test(seconds))
    return null;
  const epochSeconds = Number(seconds);
  const epochMs = epochSeconds * 1000;
  if (!Number.isSafeInteger(epochSeconds) || !Number.isSafeInteger(epochMs))
    return null;
  if (!Number.isFinite(new Date(epochMs).getTime())) return null;
  if (typeof observedAt !== 'string') return null;
  const observation = new Date(observedAt);
  if (!Number.isFinite(observation.getTime())) return null;
  if (
    observation.toISOString() !== observedAt ||
    epochMs > observation.getTime()
  )
    return null;
  return Object.freeze({
    ...binding.event,
    sourceRequestId: binding.sourceRequestId,
    providerTimestampSeconds: seconds,
    observedAt,
    version: 1,
  });
}

/**
 * Inert shape/binding validation, NOT provenance, ownership, latest-inbound,
 * 24-hour eligibility or send permission. Only future capture from a
 * SignatureGuard-authenticated raw payload may persist this evidence; existing
 * rows must not be synthetically backfilled from local processing timestamps.
 * observedAt is the original verified HTTP ingress clock, not delivery time.
 * Future provider time holds conservatively: no automatic clock-skew grace.
 * Match immutable identity/provider fields; matching retries reuse the original
 * stored observation, never refresh it. Immutable-field conflicts hold.
 * No current clock or recovery policy lives here.
 */
export function bindRestockInboundEvidence(
  input: unknown,
  expectedReceivingPhoneNumberId: string,
): RestockInboundEvidence | null {
  const source = snapshot(input, INPUT_KEYS);
  if (!source) return null;
  const evidence = assemble(
    source.event,
    source.providerTimestampSeconds,
    source.observedAt,
  );
  // The bounded source binder validates the channel; configuration must match
  // its exact bytes. A single outbound configured phone is not inbound proof.
  return evidence?.receivingPhoneNumberId === expectedReceivingPhoneNumberId
    ? evidence
    : null;
}

/** Stored row validation only; a future reader must compare outbound config. */
export function normalizeRestockInboundEvidence(
  value: unknown,
): RestockInboundEvidence | null {
  const row = snapshot(value, ROW_KEYS);
  if (!row || row.version !== 1) return null;
  const evidence = assemble(
    {
      receivingPhoneNumberId: row.receivingPhoneNumberId,
      senderId: row.senderId,
      messageId: row.messageId,
    },
    row.providerTimestampSeconds,
    row.observedAt,
  );
  return evidence?.sourceRequestId === row.sourceRequestId ? evidence : null;
}
