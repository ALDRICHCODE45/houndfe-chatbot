/** INACTIVE, pure EXPIRATION application policy: no I/O, no runtime wiring, no
 * send, ACK or mutation. It classifies whether the trusted caller's original
 * ACTIVE EXPIRATION reservation and the current backend decision bind to the
 * same request and whether `now` lies in the half-open `[resolvedAt, applyBefore)`
 * window the EXPIRATION decision normalizer fixes at `resolvedAt + 24h`.
 * Classification is descriptive ONLY: it never authorizes a send and is not
 * STALE, acceptance, delivery or provider evidence. The separate WhatsApp 24h
 * service window and template eligibility are out of scope.
 *
 * Trust boundaries are explicit: `senderId`/`branchId` are trusted caller
 * inputs; the reservation is the original ACTIVE context and the decision is the
 * current backend projection, both untrusted until normalized. It never inspects
 * current browsing and never cancels or rebinds the original inquiry. */
import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';

export type ExpirationApplicationHoldReason =
  | 'malformed_input'
  | 'invalid_clock'
  | 'invalid_context'
  | 'clock_before_resolution';

export type ExpirationApplicationClassification =
  | {
      readonly classification: 'held';
      readonly reason: ExpirationApplicationHoldReason;
    }
  | { readonly classification: 'pending' }
  | { readonly classification: 'within_window' }
  | { readonly classification: 'expired' };

const INPUT_KEYS =
  'senderId branchId reservation backendDecisionId decision now'.split(' ');
const RESERVATION_KEYS = 'status route senderId requestKey intake'.split(' ');
const INTAKE_KEYS = 'sourceRequestId type productId variantId'.split(' ');
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const held = (
  reason: ExpirationApplicationHoldReason,
): ExpirationApplicationClassification => ({ classification: 'held', reason });

/** Own-keys null-proto snapshot; accessor/symbol/Proxy reads fail closed. */
function snapshotExact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const proto = Reflect.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return null;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    const read = (value as Record<string, unknown>)[key];
    if (!Object.is(descriptor.value, read)) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** Trusted sender is exact bytes: non-blank, no padding, no control chars. */
function validSender(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

/** Trusted branch is opaque bytes, only required to be non-blank. */
const validBranch = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Canonical UTC instant only: `Date.parse` must round-trip exactly. */
function asCanonicalUtcInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? epoch
    : null;
}

interface ReservationBinding {
  readonly sourceRequestId: string;
  readonly intake: ExpirationIntakeInput;
}

/** Exact no-fold/trim binding of one ACTIVE EXPIRATION reservation to the
 * trusted sender. Missing, absent, unknown, inactive, wrong-route or malformed
 * => null (invalid context). No receipt/ledger state is invented here. */
function bindReservation(
  reservation: unknown,
  senderId: string,
): ReservationBinding | null {
  if (reservation === 'absent' || reservation === 'unknown') return null;
  const record = snapshotExact(reservation, RESERVATION_KEYS);
  if (
    record === null ||
    record.status !== 'ACTIVE' ||
    record.route !== 'EXPIRATION' ||
    record.senderId !== senderId
  ) {
    return null;
  }
  const requestKey = record.requestKey;
  if (typeof requestKey !== 'string' || requestKey.trim().length === 0) {
    return null;
  }
  const raw = snapshotExact(record.intake, INTAKE_KEYS);
  if (raw === null) return null;
  const intake = normalizeExpirationIntake(raw);
  if (intake === null || intake.sourceRequestId !== requestKey) return null;
  const drifted = INTAKE_KEYS.some(
    (key) => !Object.is(raw[key], intake[key as keyof ExpirationIntakeInput]),
  );
  return drifted ? null : { sourceRequestId: requestKey, intake };
}

/** Fail-closed classification for one caller-supplied observation. */
export function classifyExpirationApplication(
  input: unknown,
): ExpirationApplicationClassification {
  try {
    const record = snapshotExact(input, INPUT_KEYS);
    if (record === null) return held('malformed_input');
    const senderId = record.senderId;
    const branchId = record.branchId;
    if (!validSender(senderId) || !validBranch(branchId)) {
      return held('malformed_input');
    }
    const now = asCanonicalUtcInstant(record.now);
    if (now === null) return held('invalid_clock');
    const binding = bindReservation(record.reservation, senderId);
    if (binding === null) return held('invalid_context');
    const backendDecisionId = record.backendDecisionId;
    if (
      typeof backendDecisionId !== 'string' ||
      !CANONICAL_UUID.test(backendDecisionId)
    ) {
      return held('invalid_context');
    }
    const decision = normalizeExpirationDecision(record.decision);
    if (decision === null) return held('invalid_context');
    const bound =
      decision.id === backendDecisionId &&
      decision.sourceRequestId === binding.sourceRequestId &&
      decision.snapshot.productId === binding.intake.productId &&
      decision.snapshot.variantId === binding.intake.variantId &&
      decision.snapshot.branchId === branchId;
    if (!bound) return held('invalid_context');
    if (decision.status === 'PENDING') return { classification: 'pending' };
    const start = Date.parse(decision.resolution.resolvedAt);
    const end = Date.parse(decision.applyBefore);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return held('invalid_context');
    }
    if (now < start) return held('clock_before_resolution');
    return now >= end
      ? { classification: 'expired' }
      : { classification: 'within_window' };
  } catch {
    return held('malformed_input');
  }
}
