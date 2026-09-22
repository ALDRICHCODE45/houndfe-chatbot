/**
 * Domain types for the human-handoff slice.
 *
 * The human-handoff channel is the asynchronous request/response bridge
 * between the chatbot (requesting) and a human agent (resolving). The
 * human agent's wa_id is `OPS_CHANNEL_PHONE`; the bot sends a structured
 * digest and waits indefinitely (no scheduler, no expiry) for the agent's
 * reply. While the customer is waiting, the bot holds subsequent customer
 * inbounds to a canned reply; the agent's reply unblocks the customer's
 * flow with a synthetic user turn injected through the runner.
 *
 * Spec: `openspec/changes/human-handoff/specs/human-handoff/spec.md`.
 *   - `HumanHandoffKind` — three active kinds (`out_of_stock`,
 *     `needs_human_review`, `expiration_date`) plus one reserved
 *     (`shipping_approval`, R6). The reserved kind is in the union so the
 *     future R6 slice can lift the gate without re-exporting the type.
 *   - `HumanHandoffDigest` — per-kind payload; persisted under
 *     `human_handoff_requests.digest` as jsonb.
 *   - `HumanHandoffResolution` — five-member discriminated union parsed
 *     from the human's free-text reply. The structured shipping resolution
 *     shapes are exported separately below and activate in SQ-5C2c.
 *   - `HumanHandoffRequest` — full lifecycle row.
 */

import type { ShippingApprovalStaleKind } from './shipping-approval-policy.port';

/** All known kinds. `shipping_approval` is reserved for the future R6
 *  slice; the tool's inputSchema rejects it today. */
export const HUMAN_HANDOFF_KINDS = [
  'out_of_stock',
  'needs_human_review',
  'expiration_date',
  'shipping_approval',
] as const;

export type HumanHandoffKind = (typeof HUMAN_HANDOFF_KINDS)[number];

/** Active kinds the tool's inputSchema accepts today. */
export const ACTIVE_HUMAN_HANDOFF_KINDS = [
  'out_of_stock',
  'needs_human_review',
  'expiration_date',
] as const satisfies readonly HumanHandoffKind[];

export type ActiveHumanHandoffKind =
  (typeof ACTIVE_HUMAN_HANDOFF_KINDS)[number];

/** Per-kind payload — one shape per kind, discriminated by `kind`. */
export type HumanHandoffDigest =
  | OutOfStockDigest
  | NeedsHumanReviewDigest
  | ExpirationDateDigest
  | ShippingApprovalDigest;

export interface OutOfStockDigest {
  kind: 'out_of_stock';
  productId: string;
  name: string;
  variantId?: string;
  quantity?: number;
}

export interface NeedsHumanReviewDigest {
  kind: 'needs_human_review';
  items: Array<NeedsHumanReviewDigestItem>;
  originalTotalCents?: number;
  recomputedTotalCents?: number;
}

export interface NeedsHumanReviewDigestItem {
  productId: string;
  name?: string;
  variantId?: string;
  quantity: number;
  unitPriceCents?: number;
}

export interface ExpirationDateDigest {
  kind: 'expiration_date';
  productId: string;
  name: string;
  question: string;
}

/**
 * Redacted ops digest for the structured shipping-approval request (SQ-5C1).
 * Exact server-owned fields only: net charge, total credit, carrier/service,
 * estimated delivery days, and the draft-created pin. No quote/rate IDs,
 * address, phone, product, measurements, raw provider/error, expiry/validity,
 * best/gross/applied/unused amounts, or qualifying-unit count may escape.
 */
export interface ShippingApprovalDigest {
  kind: 'shipping_approval';
  draftCreatedAt: string;
  customerPaysCents: number;
  totalCreditCents: number;
  carrierName: string;
  serviceName: string;
  estimatedDeliveryDays: number | null;
}

/** Discriminated union of valid agent decisions, parsed from the
 *  agent's free-text reply (case/whitespace tolerant). */
export type HumanHandoffResolution =
  | YesRestockInXDaysResolution
  | NoRestockResolution
  | ApprovedPromoResolution
  | ExpirationResolution
  | GenericResolution;

export interface YesRestockInXDaysResolution {
  decision: 'YES_RESTOCK_IN_X_DAYS';
  days: number;
}

export interface NoRestockResolution {
  decision: 'NO_RESTOCK';
}

export interface ApprovedPromoResolution {
  decision: 'APPROVED_PROMO';
  totalCents: number;
}

export interface ExpirationResolution {
  decision: 'EXPIRATION';
  text: string;
}

export interface GenericResolution {
  decision: 'GENERIC';
  text: string;
}

/**
 * Standalone structured shipping-approval decisions (SQ-5C2b). Exact fields
 * only: the draft-created pin plus, for expiry, the stale reason. No price,
 * credit, carrier/service, ETA, provider, customer/address/phone, reason, or
 * free text is carried on approve/reject; expired carries only the finite
 * reason. SQ-5C2c activates these atomically once the exhaustive service
 * formatter/resolver handles them.
 */
export interface ShippingApprovedResolution {
  readonly decision: 'SHIPPING_APPROVED';
  readonly draftCreatedAt: string;
}

export interface ShippingRejectedResolution {
  readonly decision: 'SHIPPING_REJECTED';
  readonly draftCreatedAt: string;
}

export interface ShippingExpiredResolution {
  readonly decision: 'SHIPPING_EXPIRED';
  readonly draftCreatedAt: string;
  readonly reason: ShippingApprovalStaleKind;
}

/** Full lifecycle record for a single handoff request. */
export interface HumanHandoffRequest {
  /** 12 lowercase hex chars; ref = `HF-${id}`. */
  id: string;
  /** WhatsApp senderId (wa_id) of the customer. */
  customerId: string;
  /** OPS_CHANNEL_PHONE at create time (ADR-24). */
  agentId: string;
  kind: HumanHandoffKind;
  digest: HumanHandoffDigest;
  status: 'pending' | 'resolved';
  resolution: HumanHandoffResolution | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null while pending. */
  resolvedAt: string | null;
}
