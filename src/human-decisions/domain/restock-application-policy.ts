/** T4c1 pure RESTOCK application policy: no I/O; `ready` is a candidate, not a delivery claim. */
import {
  normalizeRestockDecision,
  normalizeRestockIntake,
  type RestockDecision,
  type RestockIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { deriveRestockAttemptId } from './restock-attempt-identity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEYS =
  'senderId branchId reservation backendDecisionId decision now'.split(' ');
const RESERVATION_KEYS = 'status route senderId requestKey intake'.split(' ');
const INTAKE_KEYS =
  'sourceRequestId type productId productName variantId sku requestedQuantity observedStockAtRequest stockObservedAt supersedesDecisionId'.split(
    ' ',
  ) as (keyof RestockIntakeInput)[];

export type RestockApplicationHoldReason =
  | 'malformed_input'
  | 'reservation_not_ready'
  | 'sender_mismatch'
  | 'identity_mismatch'
  | 'branch_mismatch'
  | 'invalid_clock'
  | 'clock_before_resolution';

export type RestockApplicationDecision =
  | { readonly action: 'hold'; readonly reason: RestockApplicationHoldReason }
  | { readonly action: 'pending' }
  | {
      readonly action: 'ready';
      readonly attemptId: string;
      readonly decisionId: string;
    }
  | {
      readonly action: 'stale';
      readonly attemptId: string;
      readonly decisionId: string;
    };

const hold = (
  reason: RestockApplicationHoldReason,
): RestockApplicationDecision => ({ action: 'hold', reason });
const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();
const sameNullableUuid = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : sameUuid(a, b);

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

/** Canonical UTC ISO only: `Date.parse` must round-trip exactly. */
function asCanonicalUtcInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString() === value ? epoch : null;
}

type ReservationCheck =
  | {
      readonly ok: true;
      readonly sourceRequestId: string;
      readonly intake: RestockIntakeInput;
    }
  | { readonly ok: false; readonly reason: RestockApplicationHoldReason };

function checkReservation(
  reservation: unknown,
  senderId: string,
): ReservationCheck {
  if (reservation === 'unknown' || reservation === 'absent') {
    return { ok: false, reason: 'reservation_not_ready' };
  }
  const record = snapshotExact(reservation, RESERVATION_KEYS);
  if (
    record === null ||
    record.status !== 'ACTIVE' ||
    record.route !== 'RESTOCK'
  ) {
    return { ok: false, reason: 'reservation_not_ready' };
  }
  const heldSender = record.senderId;
  const requestKey = record.requestKey;
  if (!nonBlank(heldSender) || !nonBlank(requestKey)) {
    return { ok: false, reason: 'reservation_not_ready' };
  }
  if (heldSender !== senderId) return { ok: false, reason: 'sender_mismatch' };
  if (!isUuid(requestKey)) {
    return { ok: false, reason: 'reservation_not_ready' };
  }
  const raw = snapshotExact(record.intake, INTAKE_KEYS);
  const intake = normalizeRestockIntake(raw);
  if (
    intake === null ||
    !sameUuid(intake.sourceRequestId, requestKey) ||
    INTAKE_KEYS.some((k) => !Object.is(raw?.[k], intake[k]))
  ) {
    return { ok: false, reason: 'reservation_not_ready' };
  }
  return { ok: true, sourceRequestId: requestKey, intake };
}

function bindsIntake(
  intake: RestockIntakeInput,
  snapshot: RestockDecision['snapshot'],
): boolean {
  return (
    sameUuid(snapshot.productId, intake.productId) &&
    (snapshot.variantId === null || intake.variantId === null
      ? snapshot.variantId === intake.variantId
      : sameUuid(snapshot.variantId, intake.variantId)) &&
    snapshot.productName === intake.productName &&
    snapshot.sku === intake.sku &&
    snapshot.requestedQuantity === intake.requestedQuantity &&
    snapshot.observedStockAtRequest === intake.observedStockAtRequest &&
    snapshot.stockObservedAt === intake.stockObservedAt
  );
}

/** Fail-closed classification; `RESOLVED` is sendable only in `[resolvedAt, applyBefore)`. */
export function classifyRestockApplication(
  input: unknown,
): RestockApplicationDecision {
  try {
    const record = snapshotExact(input, INPUT_KEYS);
    if (record === null) return hold('malformed_input');
    const senderId = record.senderId;
    const branchId = record.branchId;
    if (!nonBlank(senderId) || !nonBlank(branchId)) {
      return hold('malformed_input');
    }
    if (senderId !== senderId.trim()) {
      return hold('malformed_input');
    }
    const nowEpoch = asCanonicalUtcInstant(record.now);
    if (nowEpoch === null) return hold('invalid_clock');

    const reservation = checkReservation(record.reservation, senderId);
    if (!reservation.ok) return hold(reservation.reason);

    const backendDecisionId = record.backendDecisionId;
    if (!isUuid(backendDecisionId)) return hold('identity_mismatch');
    const decision = normalizeRestockDecision(record.decision);
    if (decision === null) return hold('identity_mismatch');
    if (
      !sameUuid(decision.id, backendDecisionId) ||
      !sameUuid(decision.sourceRequestId, reservation.sourceRequestId) ||
      !sameNullableUuid(
        reservation.intake.supersedesDecisionId,
        decision.supersedesDecisionId,
      ) ||
      !bindsIntake(reservation.intake, decision.snapshot)
    ) {
      return hold('identity_mismatch');
    }
    if (decision.snapshot.branchId !== branchId) {
      return hold('branch_mismatch');
    }
    if (decision.status === 'PENDING') return { action: 'pending' };

    const attemptId = deriveRestockAttemptId(
      decision.sourceRequestId,
      decision.id,
    );
    if (attemptId === null) return hold('identity_mismatch');
    const start = Date.parse(decision.resolution.resolvedAt);
    const end = Date.parse(decision.applyBefore);
    if (nowEpoch < start) return hold('clock_before_resolution');
    const expired =
      nowEpoch >= end ||
      (decision.resolution.action === 'PROVIDE_RESTOCK_ESTIMATE' &&
        nowEpoch >= start + decision.resolution.restockDays * 86_400_000);
    return expired
      ? { action: 'stale', attemptId, decisionId: decision.id }
      : { action: 'ready', attemptId, decisionId: decision.id };
  } catch {
    return hold('malformed_input');
  }
}
