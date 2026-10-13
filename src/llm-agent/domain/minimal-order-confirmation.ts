/**
 * Minimal order confirmation — pure, instance-scoped consent for turning a
 * verified cart plus a locally confirmed saved-address draft into ONE backend
 * sale (minimal-order-placement T1).
 *
 * Data and consent only: no SDK/Nest/HTTP/store dependency and no sale call.
 * The coordinator owns the fresh re-evaluation, the idempotency key, the sale
 * call and the transport. A candidate is a one-shot ticket bound to the exact
 * presented snapshot; the coordinator must recompute a fresh snapshot and
 * require `sameMinimalOrder` before creating the sale.
 */
import { randomUUID } from 'node:crypto';
import type { MinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';
import { isAffirmative } from './minimal-checkout-confirmation';

/** Pending-offer TTL; mirrors the checkout and RESTOCK volatile lifecycles. */
export const MINIMAL_ORDER_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export const MINIMAL_ORDER_AMBIGUOUS_REPLY =
  'Por ahora no puedo confirmar su pedido en este chat. No se creó ningún pedido.';

export interface MinimalOrderLine {
  readonly productId: string;
  readonly variantId?: string;
  readonly name: string;
  readonly variantName?: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly finalPriceCents: number;
}

/** A fresh, server-derived cart quote (shape of a successful cart view). */
export interface MinimalOrderQuote {
  readonly items: readonly MinimalOrderLine[];
  readonly totalCents: number;
  readonly promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
}

export type MinimalOrderIneligibleReason =
  | 'cart_unverified'
  | 'empty_cart'
  | 'promotion_review'
  | 'delivery_unconfirmed'
  | 'new_address_unsupported';

/** Exact content the customer consents to; detached from every input. */
export interface MinimalOrderSnapshot {
  readonly customerId: string;
  readonly shippingAddressId: string;
  readonly draft: MinimalCheckoutDraft;
  readonly items: readonly MinimalOrderLine[];
  readonly totalCents: number;
}

export type MinimalOrderEligibility =
  | { readonly ok: true; readonly snapshot: MinimalOrderSnapshot }
  | { readonly ok: false; readonly reason: MinimalOrderIneligibleReason };

/**
 * Eligibility for this slice (S1/S2/S4): a verified, non-empty, fully
 * evaluated cart, and a draft that is still exactly the locally confirmed one
 * with a saved address of a unique customer. `confirmedDraft` must come from
 * `MinimalCheckoutConfirmation.confirmedDraft`, never from the bare status.
 */
export function evaluateMinimalOrder(input: {
  readonly confirmedDraft: MinimalCheckoutDraft | null;
  readonly quote: MinimalOrderQuote | null;
}): MinimalOrderEligibility {
  const { confirmedDraft, quote } = input;
  if (quote === null) return { ok: false, reason: 'cart_unverified' };
  if (quote.items.length === 0) return { ok: false, reason: 'empty_cart' };
  if (quote.promotionEvaluationStatus !== 'fully_evaluated') {
    return { ok: false, reason: 'promotion_review' };
  }
  if (confirmedDraft === null) {
    return { ok: false, reason: 'delivery_unconfirmed' };
  }
  if (
    confirmedDraft.address.kind !== 'saved' ||
    confirmedDraft.sourceCustomerId === null
  ) {
    return { ok: false, reason: 'new_address_unsupported' };
  }
  return {
    ok: true,
    snapshot: structuredClone({
      customerId: confirmedDraft.sourceCustomerId,
      shippingAddressId: confirmedDraft.address.snapshot.id,
      draft: confirmedDraft,
      items: quote.items.map((item) => ({ ...item })),
      totalCents: quote.totalCents,
    }),
  };
}

/** Deterministic canonical content for exact snapshot binding. */
function canonicalize(snapshot: MinimalOrderSnapshot): string {
  return JSON.stringify([
    snapshot.customerId,
    snapshot.shippingAddressId,
    snapshot.draft,
    snapshot.items.map((item) => [
      item.productId,
      item.variantId ?? null,
      item.name,
      item.variantName ?? null,
      item.quantity,
      item.unitPriceCents,
      item.finalPriceCents,
    ]),
    snapshot.totalCents,
  ]);
}

/** True only when both snapshots carry identical order content. */
export function sameMinimalOrder(
  a: MinimalOrderSnapshot,
  b: MinimalOrderSnapshot,
): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;

function deliveryLine(snapshot: MinimalOrderSnapshot): string {
  const draft = snapshot.draft;
  const address =
    draft.address.kind === 'saved' ? draft.address.snapshot : null;
  const name = [draft.customer.firstName, draft.customer.lastName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
  if (address === null) return name;
  return [
    name,
    [address.street, address.exteriorNumber].filter(Boolean).join(' '),
    address.interiorNumber === null ? null : `int. ${address.interiorNumber}`,
    address.neighborhood,
    address.zipCode === null ? null : `C.P. ${address.zipCode}`,
    address.city ?? address.municipality,
    address.state,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
}

/** Server-owned order summary; the model never authors it. */
export function renderMinimalOrderSummary(
  snapshot: MinimalOrderSnapshot,
): string {
  return [
    'Resumen de su pedido:',
    ...snapshot.items.map(
      (item) =>
        `• ${item.name}${item.variantName ? ` — ${item.variantName}` : ''}: ${item.quantity} × ${mxn(item.unitPriceCents)}; importe ${mxn(item.finalPriceCents)}`,
    ),
    `Total de productos: ${mxn(snapshot.totalCents)}`,
    `Entrega a: ${deliveryLine(snapshot)}`,
    'El envío no está incluido en este total y se coordinará por separado.',
    '',
    'Responda exactamente "SÍ" para crear el pedido.',
  ].join('\n');
}

export interface MinimalOrderConfirmationOptions {
  /** Test seam; production uses `Date.now`. */
  readonly now?: () => number;
}

export type MinimalOrderPrepareResult =
  | {
      readonly kind: 'offer';
      readonly reply: string;
      readonly reference: string;
      /** Arms the pending ONLY after the transport accepted the summary. */
      readonly onSent: () => void;
    }
  | { readonly kind: 'blocked'; readonly reason: 'identity_unbound' };

/** One-shot server-owned consent ticket; NOT a created order. */
export interface MinimalOrderCandidate {
  readonly kind: 'candidate';
  readonly reference: string;
  readonly snapshot: MinimalOrderSnapshot;
}

export type MinimalOrderConsumeResult =
  | MinimalOrderCandidate
  | {
      readonly kind: 'reoffer';
      readonly reply: string;
      readonly onSent: () => void;
    }
  | { readonly kind: 'handled'; readonly reply: string }
  | null;

export interface MinimalOrderStatus {
  readonly reference: string;
  readonly armed: boolean;
  readonly expiresAt: number;
}

interface PendingOrder {
  readonly reference: string;
  readonly snapshot: MinimalOrderSnapshot;
  readonly receivingPhoneNumberId: string;
  readonly originMessageId: string;
  readonly expiresAt: number;
  readonly presentation: string;
  armed: boolean;
}

const ambiguous = (): MinimalOrderConsumeResult => ({
  kind: 'handled',
  reply: MINIMAL_ORDER_AMBIGUOUS_REPLY,
});

export class MinimalOrderConfirmation {
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingOrder>();

  constructor(options: MinimalOrderConfirmationOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Live pending offer for one sender, or `null` (expired is cleared). */
  status(senderId: string): MinimalOrderStatus | null {
    const pending = this.pending.get(senderId);
    if (pending === undefined) return null;
    if (this.now() >= pending.expiresAt) {
      this.pending.delete(senderId);
      return null;
    }
    return {
      reference: pending.reference,
      armed: pending.armed,
      expiresAt: pending.expiresAt,
    };
  }

  /** Drop any pending offer for the sender. */
  cancel(senderId: string): void {
    this.pending.delete(senderId);
  }

  /**
   * Present the exact snapshot. Supersedes any prior offer for the sender and
   * never creates anything.
   */
  prepare(input: {
    readonly senderId: string;
    readonly inboundEvent: unknown;
    readonly snapshot: MinimalOrderSnapshot;
  }): MinimalOrderPrepareResult {
    const { senderId } = input;
    this.pending.delete(senderId);
    const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
    if (bound === null) return { kind: 'blocked', reason: 'identity_unbound' };
    const snapshot = structuredClone(input.snapshot);
    const pending: PendingOrder = {
      reference: randomUUID(),
      snapshot,
      receivingPhoneNumberId: bound.event.receivingPhoneNumberId,
      originMessageId: bound.event.messageId,
      expiresAt: this.now() + MINIMAL_ORDER_CONFIRMATION_TTL_MS,
      presentation: renderMinimalOrderSummary(snapshot),
      armed: false,
    };
    this.pending.set(senderId, pending);
    return {
      kind: 'offer',
      reply: pending.presentation,
      reference: pending.reference,
      onSent: this.armFor(senderId, pending),
    };
  }

  /**
   * Interpret one inbound turn. Only a strict, trusted, armed, unexpired SÍ
   * yields a candidate, and it consumes the pending so a second SÍ cannot
   * create another order. Any other turn drops the pending: consent binds to
   * the reply right after the summary, so a later SÍ meant for something else
   * can never create this order. Everything else is `null` or a handled
   * refusal.
   */
  consume(input: {
    readonly senderId: string;
    readonly text: unknown;
    readonly inboundEvent: unknown;
  }): MinimalOrderConsumeResult {
    try {
      const { senderId } = input;
      const pending = this.pending.get(senderId);
      if (pending === undefined) return null;
      const expired = this.now() >= pending.expiresAt;
      if (expired) this.pending.delete(senderId);
      const event = bindRestockInboundEvent(
        input.inboundEvent,
        senderId,
      )?.event;
      const trusted =
        event !== undefined &&
        event.receivingPhoneNumberId === pending.receivingPhoneNumberId;
      if (!expired && trusted && event.messageId === pending.originMessageId) {
        return {
          kind: 'reoffer',
          reply: pending.presentation,
          onSent: this.armFor(senderId, pending),
        };
      }
      if (!isAffirmative(input.text)) {
        this.pending.delete(senderId);
        return null;
      }
      if (expired || !trusted || !pending.armed) return ambiguous();
      this.pending.delete(senderId);
      return {
        kind: 'candidate',
        reference: pending.reference,
        snapshot: structuredClone(pending.snapshot),
      };
    } catch {
      return ambiguous();
    }
  }

  /** Identity-checked arming: a replaced or expired offer is never armed. */
  private armFor(senderId: string, pending: PendingOrder): () => void {
    return () => {
      if (
        this.pending.get(senderId) === pending &&
        this.now() < pending.expiresAt
      ) {
        pending.armed = true;
      }
    };
  }
}
