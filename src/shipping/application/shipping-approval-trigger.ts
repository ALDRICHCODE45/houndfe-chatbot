/**
 * Pure SQ-5C3a guarded trigger preparation: no I/O, model input, provider,
 * persistence, or mutation. `prepareShippingApprovalRequest` decides whether
 * the server-owned redacted `shipping_approval` digest may be prepared:
 * `ready` only when `buildShippingApprovalDigest` succeeds and neither
 * `pendingHumanRequest` nor `shippingApproval` holds a non-null value;
 * `pending_handoff` for any non-null pending marker, canonical or malformed,
 * of any handoff kind; `prior_decision` for any non-null decision marker,
 * canonical or malformed, so a decided request is never reopened;
 * `malformed_state` for non-plain or hostile state/data; `unavailable` for a
 * missing, malformed, expired, or not-yet-created draft, or an invalid clock.
 *
 * A `null` conversation state is acceptable. Explicit JSON `null` markers left
 * by clear/compensation count as absent; the state gate runs before the draft
 * so a conflicting marker dominates. Results are fresh, exact-key, and frozen.
 */
import type { ShippingApprovalDigest } from '../../human-handoff/domain/human-handoff.types';
import { buildShippingApprovalDigest } from './shipping-approval';

export type ShippingApprovalTriggerResult =
  | { readonly kind: 'ready'; readonly digest: ShippingApprovalDigest }
  | { readonly kind: 'pending_handoff' }
  | { readonly kind: 'prior_decision' }
  | { readonly kind: 'malformed_state' }
  | { readonly kind: 'unavailable' };

const PENDING_HANDOFF: ShippingApprovalTriggerResult = Object.freeze({
  kind: 'pending_handoff',
});
const PRIOR_DECISION: ShippingApprovalTriggerResult = Object.freeze({
  kind: 'prior_decision',
});
const MALFORMED_STATE: ShippingApprovalTriggerResult = Object.freeze({
  kind: 'malformed_state',
});
const UNAVAILABLE: ShippingApprovalTriggerResult = Object.freeze({
  kind: 'unavailable',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
};

/** Returns a blocking result, or `null` when no marker conflicts. */
function inspectState(state: unknown): ShippingApprovalTriggerResult | null {
  try {
    if (state === null) return null;
    if (!isPlainObject(state)) return MALFORMED_STATE;
    const data: unknown = state.data;
    if (!isPlainObject(data)) return MALFORMED_STATE;
    const pending: unknown = data.pendingHumanRequest;
    // Any non-null pending marker blocks before the approval getter is read.
    if (pending !== undefined && pending !== null) return PENDING_HANDOFF;
    const approval: unknown = data.shippingApproval;
    // Any non-null marker blocks; explicit JSON `null`/`undefined` is absent.
    if (approval !== undefined && approval !== null) return PRIOR_DECISION;
    return null;
  } catch {
    return MALFORMED_STATE;
  }
}

export function prepareShippingApprovalRequest(
  state: unknown,
  draftRecord: unknown,
  nowMs: number,
): ShippingApprovalTriggerResult {
  const blocked = inspectState(state);
  if (blocked !== null) return blocked;
  const digest = buildShippingApprovalDigest(draftRecord, nowMs);
  if (digest === null) return UNAVAILABLE;
  return Object.freeze({ kind: 'ready', digest });
}
