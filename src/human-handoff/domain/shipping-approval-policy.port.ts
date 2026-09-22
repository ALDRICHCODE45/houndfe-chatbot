/**
 * Domain-owned SQ-5C2a shipping-approval policy port. Pure: no imports,
 * I/O, persistence, provider, or Nest surface.
 */

/** DI token for the pure policy adapter; the domain owns it so consumers
 *  never import the shipping application layer. */
export const SHIPPING_APPROVAL_POLICY = Symbol('SHIPPING_APPROVAL_POLICY');

/** Canonical structured decision union; the shipping application
 *  re-exports this instead of re-declaring it. */
export type ShippingApprovalDecision =
  | { readonly decision: 'SHIPPING_APPROVED' }
  | { readonly decision: 'SHIPPING_REJECTED' };

/** Finite, exact-key, data-free verifier verdict: `invalid_clock`,
 *  `draft_missing`, `draft_pin_mismatch`, `draft_expired`, or `valid`
 *  (only `createdAt <= now < expiresAt`). */
export type ShippingApprovalPinResult =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid_clock' }
  | { readonly kind: 'draft_missing' }
  | { readonly kind: 'draft_expired' }
  | { readonly kind: 'draft_pin_mismatch' };

/** Finite verdict kinds, exported for exhaustive consumers. */
export type ShippingApprovalPinKind = ShippingApprovalPinResult['kind'];

/** Port implemented by the shipping application's pure adapter:
 *  `parseDecision` strictly parses one ops decision (never throws);
 *  `verifyDraftPin` verifies one draft-created pin against the current
 *  conversation state (reads once, never mutates, never throws). */
export interface ShippingApprovalPolicy {
  parseDecision(value: unknown): ShippingApprovalDecision | null;
  verifyDraftPin(
    state: unknown,
    draftCreatedAt: string,
    nowMs: number,
  ): ShippingApprovalPinResult;
}
