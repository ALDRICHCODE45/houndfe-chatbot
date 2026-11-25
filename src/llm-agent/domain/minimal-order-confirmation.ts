/**
 * Minimal order confirmation — pure, instance-scoped consent for turning a
 * verified cart plus a locally confirmed delivery draft into ONE backend
 * sale (minimal-order-placement T1).
 *
 * Data and consent only: no SDK/Nest/HTTP/store dependency and no sale call.
 * The coordinator owns the fresh re-evaluation, the idempotency key, the sale
 * call and the transport. A candidate is a one-shot ticket bound to the exact
 * presented snapshot; the coordinator must recompute a fresh snapshot and
 * require `sameMinimalOrder` before creating the sale.
 */
import { randomUUID } from 'node:crypto';
import { toMexicanState } from './mexican-state';
import type { MinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';
import { classifyConfirmationReply } from './confirmation-reply';
import { minimalShippingEtaLine } from './minimal-shipping';
import {
  TITLE_EMOJI,
  bold,
  italic,
  itemDetail,
  itemLine,
  money,
  sectionTitle,
} from './whatsapp-format';

/** Pending-offer TTL; mirrors the checkout and RESTOCK volatile lifecycles. */
export const MINIMAL_ORDER_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export const MINIMAL_ORDER_AMBIGUOUS_REPLY =
  'Por ahora no puedo confirmar su pedido en este chat. Dígame «hacer pedido» para volver a mostrarle el resumen; no se creó ningún pedido.';

export const MINIMAL_ORDER_DECLINED_REPLY =
  'Entendido, no creé el pedido. ¿Desea cambiar algo del pedido?';

export interface MinimalOrderLine {
  readonly productId: string;
  readonly variantId?: string;
  readonly name: string;
  readonly variantName?: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly finalPriceCents: number;
  /** Display-only evaluation metadata; absent in older snapshots. */
  readonly appliedPromotionTitle?: string | null;
  readonly discountAmountCents?: number;
  /**
   * Restock backorder T5b: the line confirms this RESERVED backorder
   * (`unitPriceCents` = its final price, no promotion). Absent on ordinary
   * lines, so their snapshots are unchanged.
   */
  readonly backorder?: MinimalOrderBackorder;
  /**
   * Multi-pet T5a: the backend pet this line is for (checkout `petId`,
   * «(para Max)»). Absent on pet-less and backorder lines, so their
   * snapshots are unchanged.
   */
  readonly pet?: MinimalOrderPet;
}

/** The backend pet of an order line. */
export interface MinimalOrderPet {
  readonly id: string;
  readonly name: string;
}

/** The reservation a backorder line carries into the order. */
export interface MinimalOrderBackorder {
  readonly id: string;
  readonly folio: string;
  readonly productName: string;
  readonly variantName: string | null;
  readonly reservedUntil: string;
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
  | 'new_address_unsupported'
  | 'invalid_state';

/** Backend ETA: business days, or unknown while stock is pending (S7). */
export interface MinimalShippingEta {
  readonly days: number | null;
  readonly reason?: 'STOCK_PENDING';
}

/**
 * Backend-signed delivery quote (the backend computed charge and credit,
 * S2/S3) or store pickup (S4). Display fields are optional only for older
 * snapshots; a fresh order fills them from the stored quote.
 */
export type MinimalOrderShipping =
  | {
      readonly quoteId: string;
      readonly customerChargeCents: number;
      readonly creditCents?: number;
      readonly option?: {
        readonly carrier: string;
        readonly service: string;
      } | null;
      readonly eta?: MinimalShippingEta | null;
    }
  | { readonly mode: 'pickup' };

/** Customer identity of a store-pickup order (C1): no delivery data. */
export interface MinimalOrderCustomer {
  readonly firstName: string;
  readonly lastName: string | null;
}

/** Exact content the customer consents to; detached from every input. */
export interface MinimalOrderSnapshot {
  /** Empty for a new customer; new-address checkout resolves identity by phone. */
  readonly customerId: string;
  /** Empty for new addresses, whose exact fields live in draft. */
  readonly shippingAddressId: string;
  /** `null` only for store pickup, which needs no delivery data (C1). */
  readonly draft: MinimalCheckoutDraft | null;
  /** Pickup identity; set exactly when `draft` is `null`. */
  readonly customer?: MinimalOrderCustomer;
  readonly items: readonly MinimalOrderLine[];
  readonly totalCents: number;
  readonly shipping?: MinimalOrderShipping;
}

export type MinimalOrderEligibility =
  | { readonly ok: true; readonly snapshot: MinimalOrderSnapshot }
  | { readonly ok: false; readonly reason: MinimalOrderIneligibleReason };

/**
 * Eligibility for this slice (S1/S2/S4): a verified, non-empty, fully
 * evaluated cart, and a draft that is still exactly the locally confirmed one
 * with a unique saved address, a corrected saved address or a new address.
 * `confirmedDraft` must come from
 * `MinimalCheckoutConfirmation.confirmedDraft`, never from the bare status.
 */
export function evaluateMinimalOrder(input: {
  readonly confirmedDraft: MinimalCheckoutDraft | null;
  readonly quote: MinimalOrderQuote | null;
}): MinimalOrderEligibility {
  const { confirmedDraft, quote } = input;
  const cartReason = minimalQuoteIneligibility(quote);
  if (cartReason !== null || quote === null)
    return { ok: false, reason: cartReason ?? 'cart_unverified' };
  if (confirmedDraft === null) {
    return { ok: false, reason: 'delivery_unconfirmed' };
  }
  if (confirmedDraft.address.kind !== 'saved') {
    if (toMexicanState(confirmedDraft.address.fields.state) === null) {
      return { ok: false, reason: 'invalid_state' };
    }
    return {
      ok: true,
      snapshot: structuredClone({
        customerId: confirmedDraft.sourceCustomerId ?? '',
        shippingAddressId:
          confirmedDraft.address.kind === 'savedCorrected'
            ? confirmedDraft.address.snapshot.id
            : '',
        draft: confirmedDraft,
        items: quote.items.map((item) => ({ ...item })),
        totalCents: quote.totalCents,
      }),
    };
  }
  if (confirmedDraft.sourceCustomerId === null) {
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

/** Why a fresh cart quote cannot back an order, or `null` when it can. */
export function minimalQuoteIneligibility(
  quote: MinimalOrderQuote | null,
): 'cart_unverified' | 'empty_cart' | 'promotion_review' | null {
  if (quote === null) return 'cart_unverified';
  if (quote.items.length === 0) return 'empty_cart';
  return quote.promotionEvaluationStatus === 'fully_evaluated'
    ? null
    : 'promotion_review';
}

/**
 * Store pickup (C1): a verified cart plus the customer identity only, an
 * existing customer (`customerId`) or a new one by name (`customerId` empty).
 * No delivery draft, address or freight is involved.
 */
export function evaluateMinimalPickupOrder(input: {
  readonly quote: MinimalOrderQuote | null;
  readonly customerId: string;
  readonly customer: MinimalOrderCustomer;
}): MinimalOrderEligibility {
  const { quote } = input;
  const cartReason = minimalQuoteIneligibility(quote);
  if (cartReason !== null || quote === null)
    return { ok: false, reason: cartReason ?? 'cart_unverified' };
  return {
    ok: true,
    snapshot: structuredClone({
      customerId: input.customerId,
      shippingAddressId: '',
      draft: null,
      customer: {
        firstName: input.customer.firstName,
        lastName: input.customer.lastName,
      },
      items: quote.items.map((item) => ({ ...item })),
      totalCents: quote.totalCents,
      shipping: { mode: 'pickup' as const },
    }),
  };
}

/** Deterministic canonical content for exact snapshot binding. */
function canonicalize(snapshot: MinimalOrderSnapshot): string {
  return JSON.stringify([
    snapshot.customerId,
    snapshot.shippingAddressId,
    snapshot.draft,
    snapshot.customer ?? null,
    snapshot.items.map((item) => [
      item.productId,
      item.variantId ?? null,
      item.name,
      item.variantName ?? null,
      item.quantity,
      item.unitPriceCents,
      item.finalPriceCents,
      item.appliedPromotionTitle ?? null,
      item.discountAmountCents ?? 0,
      ...(item.backorder === undefined ? [] : [item.backorder.id]),
      // Multi-pet T5a: only when present, so pet-less lines are unchanged.
      ...(item.pet === undefined ? [] : [['pet', item.pet.id, item.pet.name]]),
    ]),
    snapshot.totalCents,
    snapshot.shipping === undefined
      ? null
      : 'quoteId' in snapshot.shipping
        ? [
            snapshot.shipping.quoteId,
            snapshot.shipping.customerChargeCents,
            snapshot.shipping.creditCents ?? 0,
            snapshot.shipping.option?.carrier ?? null,
            snapshot.shipping.option?.service ?? null,
            snapshot.shipping.eta?.days ?? null,
            snapshot.shipping.eta?.reason ?? null,
          ]
        : [snapshot.shipping.mode],
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

/**
 * "Producto — Presentación" for one line. Backend presentation labels may
 * already start with the product name ("Collar … Mediana"); only the
 * remainder is shown so the name is never repeated.
 */
export function minimalLineLabel(
  name: string,
  variantName?: string | null,
): string {
  const presentation = variantName?.trim() ?? '';
  if (presentation === '') return name;
  const prefix = name.trim();
  const rest = presentation.slice(prefix.length);
  if (
    presentation
      .toLocaleLowerCase('es')
      .startsWith(prefix.toLocaleLowerCase('es')) &&
    (rest === '' || /^[\s\-–—:,]/.test(rest))
  ) {
    const remainder = rest.replace(/^[\s\-–—:,]+/, '');
    return remainder === '' ? name : `${name} — ${remainder}`;
  }
  return `${name} — ${presentation}`;
}

/** Server-owned display of validated backend savings, never a price calculation. */
export function minimalPromotionSuffix(
  item: Pick<MinimalOrderLine, 'appliedPromotionTitle' | 'discountAmountCents'>,
): string {
  const discount = item.discountAmountCents ?? 0;
  if (discount <= 0) return '';
  const label = item.appliedPromotionTitle?.trim()
    ? `promoción: ${item.appliedPromotionTitle}, ahorro`
    : 'descuento: ahorro';
  return ` (${label} ${mxn(discount)})`;
}

/**
 * Restock backorder T5b: « (pedido apartado BO-000012)» after the line of a
 * confirmed backorder; empty for every ordinary line.
 */
export function minimalBackorderSuffix(
  item: Pick<MinimalOrderLine, 'backorder'>,
): string {
  return item.backorder === undefined
    ? ''
    : ` (pedido apartado ${item.backorder.folio})`;
}

/**
 * Multi-pet T5a R5 (S16): « (para Max)» after a line for a pet; empty for
 * every other line.
 */
export function minimalPetSuffix(item: Pick<MinimalOrderLine, 'pet'>): string {
  return item.pet === undefined ? '' : ` (para ${item.pet.name})`;
}

const present = (part: string | null | undefined): part is string =>
  typeof part === 'string' && part.trim() !== '';

/**
 * Message formatting S2: the people/address lines of the summary, one piece
 * per line (name; street + numbers; colonia, C.P., city, state). Store
 * pickup (no draft) shows the customer name only.
 */
function deliveryLines(snapshot: MinimalOrderSnapshot): string[] {
  const draft = snapshot.draft;
  if (draft === null) {
    const name = [snapshot.customer?.firstName, snapshot.customer?.lastName]
      .filter(present)
      .join(' ');
    return name === '' ? [] : [name];
  }
  const address =
    draft.address.kind === 'saved'
      ? draft.address.snapshot
      : draft.address.fields;
  const name = [draft.customer.firstName, draft.customer.lastName]
    .filter(present)
    .join(' ');
  if (address === null) return [name].filter(present);
  return [
    name,
    [
      [address.street, address.exteriorNumber].filter(present).join(' '),
      address.interiorNumber === null ? null : `int. ${address.interiorNumber}`,
    ]
      .filter(present)
      .join(', '),
    [
      address.neighborhood,
      address.zipCode === null ? null : `C.P. ${address.zipCode}`,
      address.city ?? address.municipality,
      address.state,
    ]
      .filter(present)
      .join(', '),
  ].filter(present);
}

/**
 * Shipping block of the summary: carrier, charge, credit and ETA (S3/S7),
 * always closed by the bold «Total a pagar» (products + the customer's
 * shipping charge; free shipping and store pickup included). «Total de
 * productos» is shown only when it differs from the total to pay (a
 * shipping charge), so the same amount is never listed twice.
 */
function shippingLines(snapshot: MinimalOrderSnapshot): string[] {
  const shipping = snapshot.shipping;
  // Every presented snapshot carries a quote or pickup (`freshOrder`); an
  // older snapshot without one still shows its products total.
  if (shipping === undefined)
    return [bold(`Total de productos: ${money(snapshot.totalCents)}`)];
  if (!('quoteId' in shipping))
    return [
      `${bold('Envío:')} recoge en tienda — sin costo`,
      bold(`Total a pagar: ${money(snapshot.totalCents)}`),
    ];
  const carrier = shipping.option
    ? `${shipping.option.carrier} ${shipping.option.service} — `
    : '';
  const charge = shipping.customerChargeCents;
  const eta = minimalShippingEtaLine(shipping.eta);
  return [
    ...(charge > 0
      ? [`Total de productos: ${money(snapshot.totalCents)}`]
      : []),
    `${bold('Envío:')} ${carrier}${charge === 0 ? 'sin costo' : money(charge)}`,
    ...((shipping.creditCents ?? 0) > 0
      ? [
          `Usted tiene un crédito de ${money(shipping.creditCents ?? 0)} por sus productos (ya descontado del envío)`,
        ]
      : []),
    ...(eta === null ? [] : [eta]),
    bold(`Total a pagar: ${money(snapshot.totalCents + charge)}`),
  ];
}

/**
 * Message formatting S2: the item lines of the summary — the bullet with
 * the product label and its backorder (T5b) and pet (T5a) suffixes, then
 * the indented quantity × price = *amount* line and, with a backend
 * discount, the indented italic promotion line.
 */
function summaryItemLines(item: MinimalOrderLine): string[] {
  const discount = item.discountAmountCents ?? 0;
  const title = item.appliedPromotionTitle?.trim() ?? '';
  const promotion =
    title === ''
      ? 'Descuento'
      : /^promoci[oó]n\b/i.test(title)
        ? title
        : `Promoción ${title}`;
  return [
    itemLine(
      `${minimalLineLabel(item.name, item.variantName)}${minimalBackorderSuffix(item)}${minimalPetSuffix(item)}`,
    ),
    itemDetail(
      `${item.quantity} × ${money(item.unitPriceCents)} = ${bold(money(item.finalPriceCents))}`,
    ),
    ...(discount > 0
      ? [itemDetail(italic(`${promotion}: ahorra ${money(discount)}`))]
      : []),
  ];
}

/**
 * First line of the server-owned order summary, without its title emoji:
 * every `.includes(MINIMAL_ORDER_SUMMARY_HEADING)` check (and its tú form
 * via `applyCustomerRegister`) finds it in the styled reply.
 */
export const MINIMAL_ORDER_SUMMARY_HEADING = bold('Resumen de su pedido');

/** Last line of the order summary: the SÍ/change question. */
export const MINIMAL_ORDER_SUMMARY_CLOSING =
  '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.';

/**
 * Server-owned order summary in the message-formatting S2 layout; the model
 * never authors it.
 */
export function renderMinimalOrderSummary(
  snapshot: MinimalOrderSnapshot,
): string {
  const pickup =
    snapshot.shipping !== undefined && !('quoteId' in snapshot.shipping);
  return [
    sectionTitle('Resumen de su pedido', TITLE_EMOJI.summary),
    '',
    sectionTitle('Productos'),
    ...snapshot.items.flatMap(summaryItemLines),
    '',
    sectionTitle(pickup ? 'Datos del cliente' : 'Entrega'),
    ...deliveryLines(snapshot),
    ...(snapshot.draft?.address.kind === 'new'
      ? ['Guardaremos esta dirección con su pedido.']
      : []),
    ...(snapshot.draft?.address.kind === 'savedCorrected'
      ? ['Actualizaremos su dirección guardada con estos datos.']
      : []),
    '',
    ...shippingLines(snapshot),
    '',
    MINIMAL_ORDER_SUMMARY_CLOSING,
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

/**
 * Plain data of one pending offer, for the durable gate adapter (S4). The
 * presentation is not part of it: it is re-rendered from the snapshot.
 */
export interface MinimalOrderPendingState {
  readonly reference: string;
  readonly snapshot: MinimalOrderSnapshot;
  readonly receivingPhoneNumberId: string;
  readonly originMessageId: string;
  readonly expiresAt: number;
  readonly armed: boolean;
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

  /** Detached copy of the live (unexpired) pending offer, or `null`. */
  exportPending(senderId: string): MinimalOrderPendingState | null {
    const pending = this.pending.get(senderId);
    if (pending === undefined || this.now() >= pending.expiresAt) return null;
    return structuredClone({
      reference: pending.reference,
      snapshot: pending.snapshot,
      receivingPhoneNumberId: pending.receivingPhoneNumberId,
      originMessageId: pending.originMessageId,
      expiresAt: pending.expiresAt,
      armed: pending.armed,
    });
  }

  /**
   * Replace the sender's pending offer with restored data (`null` clears it).
   * Callbacks handed out for a previous object can no longer arm it.
   */
  restorePending(
    senderId: string,
    state: MinimalOrderPendingState | null,
  ): void {
    if (state === null) {
      this.pending.delete(senderId);
      return;
    }
    const snapshot = structuredClone(state.snapshot);
    this.pending.set(senderId, {
      reference: state.reference,
      snapshot,
      receivingPhoneNumberId: state.receivingPhoneNumberId,
      originMessageId: state.originMessageId,
      expiresAt: state.expiresAt,
      presentation: renderMinimalOrderSummary(snapshot),
      armed: state.armed,
    });
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
   * Interpret one inbound turn. Only a deterministic affirmative
   * (`classifyConfirmationReply`) on a trusted, armed, unexpired offer
   * yields a candidate, and it consumes the pending so a second SÍ cannot
   * create another order. Any other turn drops the pending: consent binds to
   * the reply right after the summary, so a later SÍ meant for something else
   * can never create this order. A deterministic refusal is answered here;
   * everything else is `null` or a handled refusal.
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
      const verdict = classifyConfirmationReply(input.text);
      if (verdict !== 'accept') {
        this.pending.delete(senderId);
        return verdict === 'decline'
          ? { kind: 'handled', reply: MINIMAL_ORDER_DECLINED_REPLY }
          : null;
      }
      // A refused affirmative also spends the offer: consent belongs only to
      // the reply right after the summary, never to a later SÍ.
      this.pending.delete(senderId);
      if (expired || !trusted || !pending.armed) return ambiguous();
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
