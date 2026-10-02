/** Pure EXPIRATION proposal only: a later route-fenced atomic store must claim
 * RESERVED -> POST_IN_FLIGHT before HTTP. NULL reservation metadata is NOT
 * RESERVED. This module neither persists nor retries nor releases a reservation.
 * Receipt identity must already be validated against the original request.
 */
export type ExpirationPostDecision =
  | { action: 'authorize_post' }
  | {
      action: 'hold';
      reason: 'post_in_flight' | 'unknown_state' | 'already_unknown';
    }
  | {
      action: 'historical_receipt' | 'record_receipt' | 'replay_receipt';
      backendDecisionId: string;
    }
  | { action: 'conflict'; storedBackendDecisionId: string }
  | { action: 'mark_unknown'; reason: 'pre_post' | 'ambiguous_post' }
  | { action: 'blocked'; reason: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
const canonicalId = (value: unknown): value is string =>
  uuid(value) && value === value.toLowerCase();
const blocked = (reason: string): ExpirationPostDecision => ({
  action: 'blocked',
  reason,
});

/** Exact own data snapshot, not repeated reads from caller-controlled fields. */
function snapshot(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    return null;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !('value' in descriptor) ||
      !Object.is(descriptor.value, (value as Record<string, unknown>)[key])
    )
      return null;
    result[key] = descriptor.value;
  }
  return result;
}

/** Repeated pure evaluations may authorize repeatedly; only a durable CAS
 * supplies exclusivity. UNKNOWN/in-flight never authorize another attempt. */
export function classifyExpirationPostTransition(
  input: unknown,
): ExpirationPostDecision {
  try {
    const request = snapshot(input, [
      'senderId',
      'sourceRequestId',
      'existing',
      'step',
    ]);
    if (
      !request ||
      typeof request.senderId !== 'string' ||
      !request.senderId.trim() ||
      !uuid(request.sourceRequestId)
    )
      return blocked('malformed_input');
    // Snapshot step once without invoking getters, then validate its exact shape.
    const rawStep = request.step;
    let step = snapshot(rawStep, ['kind']);
    if (!step) step = snapshot(rawStep, ['kind', 'backendDecisionId']);
    if (
      !step ||
      typeof step.kind !== 'string' ||
      !['begin_post', 'record_receipt', 'mark_unknown'].includes(step.kind)
    )
      return blocked('malformed_input');
    const kind = step.kind;
    if (
      (kind === 'record_receipt') !==
      Object.hasOwn(step, 'backendDecisionId')
    )
      return blocked('malformed_input');
    if (kind === 'record_receipt' && !canonicalId(step.backendDecisionId))
      return blocked('invalid_backend_decision_id');
    if (request.existing === 'absent') return blocked('missing_row');
    if (request.existing === 'unknown') return blocked('unknown_row');
    const row = snapshot(request.existing, [
      'type',
      'status',
      'senderId',
      'sourceRequestId',
      'backendDecisionId',
    ]);
    if (
      !row ||
      row.type !== 'EXPIRATION' ||
      typeof row.status !== 'string' ||
      !['RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN'].includes(
        row.status,
      )
    )
      return blocked('malformed_row');
    const state = row.status;
    const backend = row.backendDecisionId;
    if (state === 'RECEIPT_RECORDED' ? !canonicalId(backend) : backend !== null)
      return blocked('malformed_row');
    if (
      row.senderId !== request.senderId ||
      row.sourceRequestId !== request.sourceRequestId
    )
      return blocked('identity_mismatch');
    if (kind === 'begin_post') {
      if (state === 'RESERVED') return { action: 'authorize_post' };
      if (state === 'RECEIPT_RECORDED')
        return {
          action: 'historical_receipt',
          backendDecisionId: backend as string,
        };
      return {
        action: 'hold',
        reason: state === 'UNKNOWN' ? 'unknown_state' : 'post_in_flight',
      };
    }
    if (kind === 'record_receipt') {
      const id = step.backendDecisionId as string;
      if (state === 'POST_IN_FLIGHT')
        return { action: 'record_receipt', backendDecisionId: id };
      if (state === 'RECEIPT_RECORDED')
        return backend === id
          ? { action: 'replay_receipt', backendDecisionId: id }
          : { action: 'conflict', storedBackendDecisionId: backend as string };
      return blocked(state === 'UNKNOWN' ? 'unknown_state' : 'not_in_flight');
    }
    if (state === 'RECEIPT_RECORDED') return blocked('receipt_recorded');
    if (state === 'UNKNOWN')
      return { action: 'hold', reason: 'already_unknown' };
    return {
      action: 'mark_unknown',
      reason: state === 'RESERVED' ? 'pre_post' : 'ambiguous_post',
    };
  } catch {
    return blocked('malformed_input');
  }
}
