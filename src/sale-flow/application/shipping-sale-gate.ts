/**
 * Pure SQ-5D1 shipping sale-continuation marker gate (SQ-5D2 snapshot-aware).
 *
 * The backend `CreateSaleInput` has no shipping-charge field, so a sale can be
 * created honestly only while the conversation carries no server-written
 * shipping marker. This gate answers that question before SQ-5D2 mints an
 * idempotency key or calls the backend.
 *
 * Contract:
 *   - `pass`            — no non-null `shippingQuoteDraft` / `shippingApproval`
 *                         marker (absent key, JSON `null`, or `undefined`);
 *                         carries the ONE validated `data` snapshot the caller
 *                         must thread through `readCart` / the persistence
 *                         paths (`null` only for a `null` state).
 *   - `blocked`         — a non-null marker of ANY shape, freshness, or
 *                         decision, including stale/expired/rejected/approved.
 *   - `malformed_state` — hostile, unreadable, or non-plain state/data.
 *
 * Fail closed: a `null` state passes (D2 calls the gate before the cart read,
 * which itself tolerates `null`); anything else that cannot be snapshotted as
 * a plain `data` bag is `malformed_state`. An accessor `state.data` or an own
 * accessor marker key (getter/setter) is also `malformed_state`, rejected from
 * its property descriptor WITHOUT executing it — a stateful accessor could
 * otherwise hand this gate a clean snapshot and a marker-bearing bag to a
 * later reader. D1 deliberately ignores marker freshness and decision, and
 * never infers quote intent from `shippingAddressId` — an ordinary sale may
 * carry a delivery address.
 *
 * Descriptor/Get divergence: for a `Proxy`, `getOwnPropertyDescriptor(key)`
 * and plain `key` access can disagree. Reading only the descriptor let a
 * hostile state show a clean `data` to this gate while `readCart` / the
 * persistence spread consumed a shipping-marked `get('data')`. Every read here
 * therefore compares the own-data descriptor with the `get` result and treats
 * a mismatch as `malformed_state` — checked BEFORE the key mint / backend call.
 *
 * Known limitation (NOT claimed as universal Proxy detection): a `data` bag
 * that is itself a `Proxy` whose descriptor and `get` agree is snapshotted by
 * identity like plain JSON; a stateful or divergent bag nested INSIDE `data`
 * is out of scope for this pure gate.
 *
 * Pure: no clock, async, I/O, provider, Nest, or caller-state mutation. Own
 * data properties are read exactly once behind a single try/catch; own
 * accessors are rejected before any read, so a stateful or throwing getter can
 * never flip or escape the verdict.
 */
import type { ConversationStateData } from '../../conversation/domain/conversation-store';
import { SHIPPING_APPROVAL_KEY } from '../../human-handoff/application/shipping-approval-persistence';
import { SHIPPING_QUOTE_DRAFT_KEY } from '../../shipping/application/shipping-quote-draft-record';

export type ShippingSaleGateVerdict =
  | { readonly kind: 'pass'; readonly data: ConversationStateData | null }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'malformed_state' };

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

/** One read per key: `absent` for a missing own key (the prototype chain is
 *  never consulted, so an inherited getter never runs), `unsafe` for an own
 *  accessor (whose getter is never executed) or a descriptor/`get` mismatch,
 *  and `value` for a consistent own data property. */
type OwnRead =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsafe' };

const readOwn = (target: Record<string, unknown>, key: string): OwnRead => {
  const descriptor: PropertyDescriptor | undefined =
    Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { kind: 'absent' };
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return { kind: 'unsafe' };
  }
  if (!Object.is(descriptor.value, target[key])) {
    return { kind: 'unsafe' };
  }
  return { kind: 'value', value: descriptor.value };
};

export function evaluateShippingSaleGate(
  state: unknown,
): ShippingSaleGateVerdict {
  try {
    if (state === null) return Object.freeze({ kind: 'pass', data: null });
    if (!isPlainObject(state)) return MALFORMED;
    const stateData = readOwn(state, 'data');
    if (stateData.kind === 'unsafe') return MALFORMED;
    const data: unknown =
      stateData.kind === 'value' ? stateData.value : undefined;
    if (!isPlainObject(data)) return MALFORMED;
    const draft = readOwn(data, SHIPPING_QUOTE_DRAFT_KEY);
    const approval = readOwn(data, SHIPPING_APPROVAL_KEY);
    if (draft.kind === 'unsafe' || approval.kind === 'unsafe') {
      return MALFORMED;
    }
    const draftValue = draft.kind === 'value' ? draft.value : undefined;
    const approvalValue =
      approval.kind === 'value' ? approval.value : undefined;
    if (isMarkerPresent(draftValue) || isMarkerPresent(approvalValue)) {
      return BLOCKED;
    }
    return Object.freeze({ kind: 'pass', data });
  } catch {
    return MALFORMED;
  }
}
