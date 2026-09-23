/**
 * Pure SQ-5D1 shipping sale-continuation marker gate.
 *
 * The backend `CreateSaleInput` has no shipping-charge field, so a sale can be
 * created honestly only while the conversation carries no server-written
 * shipping marker. This gate answers that question before SQ-5D2 mints an
 * idempotency key or calls the backend.
 *
 * Contract:
 *   - `pass`            — no non-null `shippingQuoteDraft` / `shippingApproval`
 *                         marker (absent key, JSON `null`, or `undefined`).
 *   - `blocked`         — a non-null marker of ANY shape, freshness, or
 *                         decision, including stale/expired/rejected/approved.
 *   - `malformed_state` — hostile, unreadable, or non-plain state/data.
 *
 * Fail closed: a `null` state passes (D2 calls the gate after the cart read,
 * which itself tolerates `null`); anything else that cannot be snapshotted as
 * a plain `data` bag is `malformed_state`. D1 deliberately ignores marker
 * freshness and decision, and never infers quote intent from
 * `shippingAddressId` — an ordinary sale may carry a delivery address.
 *
 * Pure: no clock, async, I/O, provider, Nest, or caller-state mutation. Each
 * `state.data` and marker value is snapshotted exactly once behind a single
 * try/catch so a stateful or throwing getter can never flip or escape it.
 */
import { SHIPPING_APPROVAL_KEY } from '../../human-handoff/application/shipping-approval-persistence';
import { SHIPPING_QUOTE_DRAFT_KEY } from '../../shipping/application/shipping-quote-draft-record';

export type ShippingSaleGateVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'malformed_state' };

const PASS: ShippingSaleGateVerdict = Object.freeze({ kind: 'pass' });
const BLOCKED: ShippingSaleGateVerdict = Object.freeze({ kind: 'blocked' });
const MALFORMED: ShippingSaleGateVerdict = Object.freeze({
  kind: 'malformed_state',
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

/** A marker is present unless the key is absent (`undefined`) or the stored
 *  value is an explicit JSON `null` left by the clear/compensation path. */
const isMarkerPresent = (value: unknown): boolean =>
  value !== undefined && value !== null;

export function evaluateShippingSaleGate(
  state: unknown,
): ShippingSaleGateVerdict {
  try {
    if (state === null) return PASS;
    if (!isPlainObject(state)) return MALFORMED;
    const data: unknown = state.data;
    if (!isPlainObject(data)) return MALFORMED;
    const draft: unknown = data[SHIPPING_QUOTE_DRAFT_KEY];
    const approval: unknown = data[SHIPPING_APPROVAL_KEY];
    if (isMarkerPresent(draft) || isMarkerPresent(approval)) return BLOCKED;
    return PASS;
  } catch {
    return MALFORMED;
  }
}
