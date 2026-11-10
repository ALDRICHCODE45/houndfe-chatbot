import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { toMexicanState } from '../domain/mexican-state';
import { ConfigService } from '@nestjs/config';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import { createHash, randomUUID } from 'node:crypto';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import type { BotSaleResponse } from '../../chatbot-api/domain/dtos/sales.dto';
import type { PaymentDetail } from '../../chatbot-api/domain/dtos/payment-details.dto';
import {
  CreateCheckoutInputSchema,
  INVALID_CHECKOUT_REQUEST,
  SHIPPING_QUOTE_ALREADY_USED,
  checkoutErrorMismatches,
  type CheckoutPickupLocation,
  type CreateCheckoutInput,
} from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  PACKAGING_DATA_MISSING,
  SHIPPING_QUOTE_EXPIRED,
  SHIPPING_QUOTE_MISMATCH,
  SHIPPING_QUOTE_NOT_FOUND,
  SHIPPING_QUOTE_UNAVAILABLE,
} from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  evaluateMinimalOrder,
  evaluateMinimalPickupOrder,
  sameMinimalOrder,
  type MinimalOrderIneligibleReason,
  type MinimalOrderSnapshot,
  type MinimalOrderStatus,
  type MinimalOrderShipping,
} from '../domain/minimal-order-confirmation';
import {
  isMinimalPickup,
  isPickupCurrent,
  isShippingCurrent,
  minimalShippingEta,
} from '../domain/minimal-shipping';
import {
  MinimalCartService,
  parseMinimalCart,
  type MinimalCartState,
} from './minimal-cart.service';
import {
  MINIMAL_CHECKOUT_ADDRESS_REQUIRED_REPLY,
  MINIMAL_CHECKOUT_INVALID_STATE_REPLY,
  MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY,
  MINIMAL_CHECKOUT_RESELECT_REPLY,
  MinimalCheckoutService,
  type MinimalCheckoutReply,
} from './minimal-checkout.service';
import { MinimalShippingService } from './minimal-shipping.service';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { processLocalConversationGates } from '../../conversation-gates/infrastructure/process-local-conversation-gates';
import { DurableOrderConfirmation } from './gates/order-confirmation.gate';

export const MINIMAL_ORDER_INELIGIBLE_REPLIES: Record<
  MinimalOrderIneligibleReason,
  string
> = {
  cart_unverified:
    'No pude verificar los precios y existencias de su carrito. Dígame «hacer pedido» para intentar verificarlos de nuevo; no se creó ningún pedido.',
  empty_cart:
    'Su carrito está vacío. Agregue productos antes de hacer su pedido. No se creó ningún pedido.',
  promotion_review:
    'Las promociones de su carrito requieren revisión del equipo. Comuníquese con la tienda para revisarlas antes de hacer el pedido; no se creó ningún pedido.',
  delivery_unconfirmed: MINIMAL_CHECKOUT_ADDRESS_REQUIRED_REPLY,
  invalid_state: MINIMAL_CHECKOUT_INVALID_STATE_REPLY,
  new_address_unsupported:
    'Por ahora solo puedo crear pedidos para clientes registrados con una dirección guardada. Comuníquese con la tienda para registrar sus datos; no se creó ningún pedido.',
};
export const MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY =
  'Antes del resumen necesito saber cómo recibirá su pedido: dígame «cotizar envío» para calcular el envío a su dirección confirmada, o «recoger en tienda» si prefiere recogerlo sin costo de envío. Por ahora no se creó ningún pedido.';
export const MINIMAL_ORDER_PICKUP_NAME_REQUIRED_REPLY =
  'Para registrar su pedido para recoger en tienda solo necesito su nombre. ¿Me lo comparte? Por ahora no se creó ningún pedido.';
export const MINIMAL_ORDER_PICKUP_CUSTOMER_UNAVAILABLE_REPLY =
  'Por ahora no puedo verificar sus datos de cliente. Intente de nuevo en un momento; no se creó ningún pedido.';
export const MINIMAL_ORDER_CUSTOMER_RECHECK_REPLY =
  'Sus datos de cliente ya no coinciden con la cotización de envío; no se creó ningún pedido. Dígame «quiero comprar» para revisar sus datos y después le cotizo el envío de nuevo.';
/** Backend code: `expectedTotalCents` no longer matches merchandise plus
 * shipping (a promotion started or ended); nothing was written. */
const PROMO_RE_QUOTE = 'PROMO_RE_QUOTE';
/** Internal `send` → `consume` marker for PROMO_RE_QUOTE; never sent. */
const PROMO_REPRICE_MARKER = Symbol('minimal-order.promo-reprice').toString();
/** Test seam for quote expiry; production uses `Date.now`. */
export const MINIMAL_ORDER_CLOCK = Symbol('MINIMAL_ORDER_CLOCK');
export const MINIMAL_ORDER_CHANGED_REPLY =
  'Su pedido cambió desde el último resumen; no se creó ningún pedido. Revise el resumen actualizado:';
export const MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY =
  'No puedo identificar un registro único para su teléfono. Por favor comuníquese con la tienda para revisar su pedido.';
export const MINIMAL_ORDER_REJECTED_REPLY =
  'No se pudo crear el pedido. Puede revisar su carrito y pedir de nuevo el resumen cuando quiera.';
export const MINIMAL_ORDER_VARIANT_CHANGED_REPLY =
  'Las presentaciones de un producto de su carrito cambiaron y no pude crear el pedido así; no se creó ningún pedido. Revise su carrito, elija de nuevo la presentación de ese producto o quítelo, y pida otra vez el resumen.';
export const MINIMAL_ORDER_STOCK_CHANGED_REPLY =
  'Mientras confirmaba su pedido ya no alcanzó la existencia de un producto de su carrito; no se creó ningún pedido. Revise su carrito, ajuste la cantidad o quite ese producto, y pida otra vez el resumen.';
export const MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY =
  'La cotización de envío ya no es válida porque venció o cambió su pedido; no se creó ningún pedido. Pídame de nuevo el envío para su dirección y le muestro el total actualizado.';
export const MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY =
  'La cotización de envío venció o cambió, así que la actualicé; no se creó ningún pedido. Revise el nuevo total:';
export const MINIMAL_ORDER_SHIPPING_QUOTE_NOT_FOUND_REPLY =
  'No encontré su cotización de envío; no se creó ningún pedido. Dígame «cotizar envío» para calcularlo de nuevo, o «recoger en tienda» si prefiere recogerlo sin costo de envío.';
export const MINIMAL_ORDER_PACKAGING_MISSING_REPLY =
  'No pude confirmar el envío porque nos falta información de empaque de un producto; no se creó ningún pedido. Puede intentarlo más tarde o, si prefiere, recoger su pedido en tienda sin costo de envío.';
export const MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY =
  'No pude confirmar el envío en este momento; no se creó ningún pedido. Puede pedirme de nuevo el envío en unos minutos o, si prefiere, recoger su pedido en tienda sin costo de envío.';
export const MINIMAL_ORDER_HELD_REPLY =
  'Tengo una solicitud de pedido anterior que no pude confirmar y sus datos ya no coinciden con este resumen. Para no duplicar su pedido no creé uno nuevo; por favor comuníquese con la tienda para revisarlo.';
export const MINIMAL_ORDER_UNRESOLVED_REPLY =
  'No pude confirmar si su pedido anterior quedó registrado y no puedo crear otro sin riesgo de duplicarlo. Por favor comuníquese con la tienda para revisarlo.';
export const MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY =
  'No pude confirmar si su pedido quedó registrado. Si vuelve a pedir el resumen y responde SÍ, usaré la misma solicitud para no duplicarlo.';
export const MINIMAL_ORDER_PAYMENT_UNAVAILABLE_REPLY =
  'No pude obtener los datos para la transferencia en este momento; su pedido sí quedó registrado.';

/** The item no longer matches the product's current variants; nothing was written. */
const VARIANT_REJECTION_CODES: ReadonlySet<string> = new Set([
  'BOT_ITEM_VARIANT_REQUIRED',
  'BOT_ITEM_VARIANT_NOT_ALLOWED',
  'BOT_ITEM_VARIANT_MISMATCH',
]);
/** Definite checkout rejections about the shipping quote (S6). */
const SHIPPING_REJECTION_REPLIES: Readonly<Record<string, string>> = {
  [SHIPPING_QUOTE_EXPIRED]: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
  [SHIPPING_QUOTE_MISMATCH]: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
  [SHIPPING_QUOTE_ALREADY_USED]: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
  [SHIPPING_QUOTE_NOT_FOUND]: MINIMAL_ORDER_SHIPPING_QUOTE_NOT_FOUND_REPLY,
  [PACKAGING_DATA_MISSING]: MINIMAL_ORDER_PACKAGING_MISSING_REPLY,
  [SHIPPING_QUOTE_UNAVAILABLE]: MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY,
};
/**
 * Unknown outcomes. `IDEMPOTENCY_KEY_CONFLICT` is one: the backend already saw
 * this key with another payload, so a sale may exist under it.
 */
const KEEPING_ERROR_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_KEY_IN_FLIGHT',
  'IDEMPOTENCY_KEY_CONFLICT',
  'CHECKOUT_RETRY_REQUIRED',
]);

/** Checkout errors after which the backend wrote nothing (contract). */
const QUOTE_REJECTION_CODES: ReadonlySet<string> = new Set([
  SHIPPING_QUOTE_EXPIRED,
  SHIPPING_QUOTE_MISMATCH,
  SHIPPING_QUOTE_ALREADY_USED,
  SHIPPING_QUOTE_NOT_FOUND,
  SHIPPING_QUOTE_UNAVAILABLE,
]);
const isQuoteRejection = (error: unknown): boolean =>
  error instanceof ChatbotApiError &&
  error.errorCode !== null &&
  QUOTE_REJECTION_CODES.has(error.errorCode);

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;

type FreshOrder =
  | { ok: true; snapshot: MinimalOrderSnapshot }
  | { ok: false; reply: string; reason?: MinimalOrderIneligibleReason };

/**
 * After a sale attempt: `rotate` when the backend definitely did not create it
 * (the key must not be reused for a different payload); `keep` when the outcome
 * is unknown or still in flight, so a retry replays the same key.
 */
function classifyFailure(error: unknown): 'rotate' | 'keep' {
  if (!(error instanceof ChatbotApiError)) return 'keep';
  // The backend writes nothing after any SHIPPING_QUOTE_* error, even a 503.
  if (isQuoteRejection(error)) return 'rotate';
  if (error.errorCode !== null && KEEPING_ERROR_CODES.has(error.errorCode)) {
    return 'keep';
  }
  const status = error.statusCode;
  return status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
    ? 'rotate'
    : 'keep';
}

/** The sale fields the order-created reply and `placedSale` need. */
type PlacedSaleIdentity = Pick<
  BotSaleResponse,
  'saleId' | 'folio' | 'totalCents'
>;

function isSale(value: unknown): value is PlacedSaleIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const sale = value as Partial<BotSaleResponse>;
  return (
    typeof sale.saleId === 'string' &&
    sale.saleId !== '' &&
    (sale.folio === null || typeof sale.folio === 'string') &&
    Number.isSafeInteger(sale.totalCents) &&
    (sale.totalCents ?? -1) >= 0
  );
}

/** S1: the sale's confirmedAt, else the placement time. */
function saleConfirmedAt(sale: PlacedSaleIdentity, nowMs: number): string {
  const confirmed = (sale as { confirmedAt?: unknown }).confirmedAt;
  return typeof confirmed === 'string' && !Number.isNaN(Date.parse(confirmed))
    ? new Date(confirmed).toISOString()
    : new Date(nowMs).toISOString();
}

/** S1: the checkout first name of the order (delivery draft or pickup). */
function checkoutFirstName(snapshot: MinimalOrderSnapshot): string | null {
  return (
    snapshot.draft?.customer.firstName ?? snapshot.customer?.firstName ?? null
  );
}

/** Backend pickup location (C1); null parts are omitted, never invented. */
function pickupLocationText(
  location: CheckoutPickupLocation | null | undefined,
): string {
  if (location === null || location === undefined) return '';
  const place =
    location.address === null
      ? ` Recójalo en ${location.name}.`
      : ` Recójalo en ${location.name}: ${location.address.formatted.replace(/\.$/, '')}.`;
  return location.hours === null
    ? place
    : `${place} Horario: ${location.hours.summary}`;
}

/** Server-owned order-created copy; amounts and folio come from the sale. */
export function minimalOrderCreatedReply(
  sale: PlacedSaleIdentity,
  shipping: { mode: 'pickup' } | { customerChargeCents: number } | undefined,
  pickupLocation: CheckoutPickupLocation | null | undefined,
): string {
  return (
    (sale.folio === null
      ? 'Su pedido quedó registrado.'
      : `Su pedido quedó registrado con folio ${sale.folio}.`) +
    (shipping === undefined
      ? ` Total de productos: ${mxn(sale.totalCents)}. El envío no está incluido y se coordinará por separado.`
      : !('customerChargeCents' in shipping)
        ? ` Total a pagar: ${mxn(sale.totalCents)}. Recoge en tienda (sin costo de envío).`
        : shipping.customerChargeCents === 0
          ? ` Total de productos: ${mxn(sale.totalCents)}. Envío sin costo para usted.`
          : ` Total a pagar: ${mxn(sale.totalCents)} (envío incluido).`) +
    pickupLocationText(pickupLocation)
  );
}

/** Transfer instructions from the backend's active bank account. */
export function minimalPaymentInstructions(
  detail: Pick<
    PaymentDetail,
    'bankName' | 'beneficiary' | 'clabe' | 'accountNumber'
  >,
): string {
  return [
    'Para pagar por transferencia:',
    `Banco: ${detail.bankName}`,
    `Beneficiario: ${detail.beneficiary}`,
    `CLABE: ${detail.clabe}`,
    `Cuenta: ${detail.accountNumber}`,
    'Cuando haga la transferencia, envíe aquí la foto de su comprobante.',
  ].join('\n');
}

/** Deterministic digest of the exact payload sent under one key. */
function fingerprint(payload: CreateCheckoutInput): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sameCartLines(
  cart: MinimalCartState,
  snapshot: MinimalOrderSnapshot,
): boolean {
  return (
    cart.items.length === snapshot.items.length &&
    cart.items.every((line, index) => {
      const item = snapshot.items[index];
      return (
        line.productId === item.productId &&
        line.variantId === item.variantId &&
        line.quantity === item.quantity &&
        line.unitPriceCents === item.unitPriceCents
      );
    })
  );
}

/**
 * Minimal-route order placement (minimal-order-placement T2). Creates ONE
 * ONLINE sale only after a strict armed SÍ for the exact presented summary,
 * through one atomic `POST /chatbot-api/checkouts` that may also create the
 * customer and save a confirmed new or corrected address in that transaction.
 * No separate customer/address writes, stock reservation or payment. Always on.
 */
@Injectable()
export class MinimalOrderService {
  // S4: durable pending summary (process-local without ConversationGates).
  private readonly confirmation: DurableOrderConfirmation;
  private readonly logger = new Logger(MinimalOrderService.name);
  private readonly cashierUserId: string;
  private readonly now: () => number;

  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly api: ChatbotApiClient,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    private readonly cart: MinimalCartService,
    private readonly checkout: MinimalCheckoutService,
    config: ConfigService,
    private readonly shipping: MinimalShippingService,
    @Optional() @Inject(MINIMAL_ORDER_CLOCK) now?: () => number,
    // S1: the last-order pointer and checkout name for the customer memory.
    @Optional() private readonly profiles?: CustomerProfileService,
    @Optional() gates?: ConversationGates,
  ) {
    this.now = now ?? (() => Date.now());
    this.confirmation = new DurableOrderConfirmation(
      gates ?? processLocalConversationGates(),
    );
    const cashier = config.get<string>('chatbotApi.cashierUserId');
    this.cashierUserId = typeof cashier === 'string' ? cashier.trim() : '';
  }

  /** Server-owned cashier and the owned CAS capabilities. */
  get enabled(): boolean {
    return (
      this.cashierUserId !== '' &&
      typeof this.store.commitMinimalCart === 'function' &&
      this.checkout.available
    );
  }

  /** Server-owned order summary, or the reason no order can be offered. */
  async prepareOrder(
    senderId: string,
    inboundEvent: unknown,
  ): Promise<MinimalCheckoutReply> {
    if (!this.enabled) return { reply: MINIMAL_ORDER_AMBIGUOUS_REPLY };
    const recovery = await this.recoverOutstanding(senderId);
    if (recovery.reply !== undefined) {
      this.confirmation.cancel(senderId);
      return { reply: recovery.reply };
    }
    const fresh = await this.freshOrder(senderId);
    if (!fresh.ok) {
      this.confirmation.cancel(senderId);
      if (!recovery.outstanding && fresh.reason === 'delivery_unconfirmed')
        return this.checkout.prepareConfirmation(senderId, inboundEvent);
      return {
        reply: recovery.outstanding
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : fresh.reply,
      };
    }
    return this.offer(senderId, inboundEvent, fresh.snapshot);
  }

  /** S4: the live pending summary (reference + armed), or `null`. */
  offerStatus(senderId: string): MinimalOrderStatus | null {
    return this.confirmation.status(senderId);
  }

  /** Drop the sender's pending summary when another route answers a turn. */
  dismiss(senderId: string): void {
    this.confirmation.cancel(senderId);
  }

  /**
   * Consume one inbound turn against a pending order summary. `null` means
   * the turn is not an order answer and other routes keep it.
   */
  async consume(input: {
    senderId: string;
    text: string;
    inboundEvent?: unknown;
  }): Promise<MinimalCheckoutReply | null> {
    if (!this.enabled) return null;
    const recovery = await this.recoverOutstanding(input.senderId);
    if (recovery.reply !== undefined) {
      this.confirmation.cancel(input.senderId);
      return { reply: recovery.reply };
    }
    if (this.confirmation.status(input.senderId) === null) return null;
    const result = await this.confirmation.consume({
      senderId: input.senderId,
      text: input.text,
      inboundEvent: input.inboundEvent,
    });
    if (result === null) return null;
    if (result.kind === 'reoffer') {
      return { reply: result.reply, onSent: result.onSent };
    }
    if (result.kind === 'handled') return { reply: result.reply };
    const fresh = await this.freshOrder(input.senderId);
    if (!fresh.ok) {
      if (!recovery.outstanding && fresh.reason === 'delivery_unconfirmed')
        return this.checkout.prepareConfirmation(
          input.senderId,
          input.inboundEvent,
        );
      return {
        reply: recovery.outstanding
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : fresh.reply,
      };
    }
    if (!sameMinimalOrder(fresh.snapshot, result.snapshot)) {
      const offer = this.offer(
        input.senderId,
        input.inboundEvent,
        fresh.snapshot,
      );
      const changedReply = recovery.outstanding
        ? MINIMAL_ORDER_UNRESOLVED_REPLY
        : MINIMAL_ORDER_CHANGED_REPLY;
      return offer.onSent === undefined
        ? { reply: changedReply }
        : {
            reply: `${changedReply}\n\n${offer.reply}`,
            onSent: offer.onSent,
          };
    }
    const reply = await this.place(input.senderId, fresh.snapshot);
    // This reply only follows a cleared key (first attempt, or a later one
    // whose earlier attempt the status read resolved), so re-quoting is safe.
    if (reply === MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY)
      return this.requote(input.senderId, input.inboundEvent);
    if (reply === PROMO_REPRICE_MARKER)
      return this.represent(input.senderId, input.inboundEvent);
    return {
      reply:
        recovery.outstanding &&
        (reply === MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified ||
          reply === MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY)
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : reply,
    };
  }

  /**
   * S6: the backend refused an expired or mismatched quote and created
   * nothing. Ask for one fresh quote and present the new summary for a new
   * SÍ; any other outcome asks the customer to request shipping again.
   */
  private async requote(
    senderId: string,
    inboundEvent: unknown,
  ): Promise<MinimalCheckoutReply> {
    const fallback = { reply: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY };
    try {
      if ((await this.shipping.quote(senderId)).kind !== 'quoted')
        return fallback;
      const fresh = await this.freshOrder(senderId);
      if (!fresh.ok) return fallback;
      const offer = this.offer(senderId, inboundEvent, fresh.snapshot);
      return offer.onSent === undefined
        ? fallback
        : {
            reply: `${MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY}\n\n${offer.reply}`,
            onSent: offer.onSent,
          };
    } catch {
      return fallback;
    }
  }

  /**
   * F5: PROMO_RE_QUOTE wrote nothing and the key is already cleared. The
   * fresh order re-prices the cart (and re-quotes a delivery quote pinned to
   * the old prices); the new summary is shown for a fresh SÍ.
   */
  private async represent(
    senderId: string,
    inboundEvent: unknown,
  ): Promise<MinimalCheckoutReply> {
    const fresh = await this.freshOrder(senderId);
    if (!fresh.ok) return { reply: fresh.reply };
    const offer = this.offer(senderId, inboundEvent, fresh.snapshot);
    return offer.onSent === undefined
      ? { reply: MINIMAL_ORDER_CHANGED_REPLY }
      : {
          reply: `${MINIMAL_ORDER_CHANGED_REPLY}\n\n${offer.reply}`,
          onSent: offer.onSent,
        };
  }

  /** Resolve an earlier POST before consulting mutable stock/address/shipping. */
  private async recoverOutstanding(
    senderId: string,
  ): Promise<{ outstanding: boolean; reply?: string }> {
    try {
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      const key =
        typeof raw === 'object' &&
        raw !== null &&
        'idempotencyKey' in raw &&
        typeof raw.idempotencyKey === 'string'
          ? raw.idempotencyKey
          : '';
      if (key === '') return { outstanding: false };
      const status = await this.api.getCheckoutStatus(key);
      if (status.status === 'not_observed') return { outstanding: true };
      if (isSale(status.checkout?.sale)) {
        return {
          outstanding: true,
          reply: await this.completeSale(
            senderId,
            raw,
            status.checkout.sale,
            cart?.shipping !== undefined
              ? isMinimalPickup(cart.shipping)
                ? { mode: 'pickup' }
                : { customerChargeCents: cart.shipping.customerChargeCents }
              : undefined,
            'pickupLocation' in status.checkout
              ? status.checkout.pickupLocation
              : undefined,
          ),
        };
      }
    } catch {
      // A failed status read is not evidence that an earlier order is absent.
    }
    return { outstanding: true, reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY };
  }

  private offer(
    senderId: string,
    inboundEvent: unknown,
    snapshot: MinimalOrderSnapshot,
  ): MinimalCheckoutReply {
    const prepared = this.confirmation.prepare({
      senderId,
      inboundEvent,
      snapshot,
    });
    return prepared.kind === 'offer'
      ? { reply: prepared.reply, onSent: prepared.onSent }
      : { reply: MINIMAL_ORDER_AMBIGUOUS_REPLY };
  }

  /**
   * Fresh quote + exact confirmed draft + destination freshness. Fresh prices
   * are stored first so the summary they produce can be placed (L16).
   */
  private async freshOrder(senderId: string): Promise<FreshOrder> {
    try {
      const { quote, repriced } = await this.cart.refreshPrices(senderId);
      const pickup = await this.freshPickupOrder(
        senderId,
        quote.ok ? quote : null,
      );
      if (pickup !== null) return pickup;
      const confirmedDraft = await this.checkout.confirmedDraft(senderId);
      const verdict = evaluateMinimalOrder({
        confirmedDraft,
        quote: quote.ok ? quote : null,
      });
      if (!verdict.ok) {
        return {
          ok: false,
          reply: MINIMAL_ORDER_INELIGIBLE_REPLIES[verdict.reason],
          reason: verdict.reason,
        };
      }
      const draft = verdict.snapshot.draft;
      if (draft === null)
        return {
          ok: false,
          reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.delivery_unconfirmed,
          reason: 'delivery_unconfirmed',
        };
      const revalidation = await this.checkout.revalidateSelection(
        senderId,
        draft,
      );
      if (revalidation === 'reselect') {
        return { ok: false, reply: MINIMAL_CHECKOUT_RESELECT_REPLY };
      }
      if (revalidation === 'unavailable') {
        return { ok: false, reply: MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY };
      }
      const raw = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      let shipping =
        cart === null ? null : this.currentShipping(cart, verdict.snapshot);
      if (
        shipping === null &&
        repriced &&
        cart?.shipping !== undefined &&
        !isMinimalPickup(cart.shipping) &&
        cart.shipping.quoteId !== null
      ) {
        // The delivery quote was pinned to the old prices and its credit may
        // change: re-quote once, like the EXPIRED/MISMATCH checkout path.
        if ((await this.shipping.quote(senderId)).kind !== 'quoted')
          return { ok: false, reply: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY };
        const requoted = parseMinimalCart(
          (await this.store.get(senderId))?.data.minimalCart,
        );
        shipping =
          requoted === null
            ? null
            : this.currentShipping(requoted, verdict.snapshot);
        if (shipping === null)
          return { ok: false, reply: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY };
      }
      if (shipping === null)
        return { ok: false, reply: MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY };
      return { ok: true, snapshot: { ...verdict.snapshot, shipping } };
    } catch {
      return {
        ok: false,
        reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified,
      };
    }
  }

  /**
   * Store pickup (C1): a current pickup choice needs only the customer
   * identity, never confirmed delivery data. `null` when the cart holds no
   * current pickup choice, so the delivery path decides.
   */
  private async freshPickupOrder(
    senderId: string,
    quote: Parameters<typeof evaluateMinimalPickupOrder>[0]['quote'],
  ): Promise<FreshOrder | null> {
    const cart = parseMinimalCart(
      (await this.store.get(senderId))?.data.minimalCart,
    );
    const record = cart?.shipping;
    if (record === undefined || !isMinimalPickup(record)) return null;
    if (quote !== null && quote.items.length > 0) {
      const lines = quote.items.map((item) => ({
        productId: item.productId,
        ...(item.variantId === undefined ? {} : { variantId: item.variantId }),
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        finalPriceCents: item.finalPriceCents,
      }));
      if (!isPickupCurrent(record, lines)) return null;
    }
    const identity = await this.checkout.pickupIdentity(senderId);
    if (identity.kind === 'ambiguous')
      return { ok: false, reply: MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY };
    if (identity.kind === 'unavailable')
      return {
        ok: false,
        reply: MINIMAL_ORDER_PICKUP_CUSTOMER_UNAVAILABLE_REPLY,
      };
    if (identity.kind === 'name_required')
      return { ok: false, reply: MINIMAL_ORDER_PICKUP_NAME_REQUIRED_REPLY };
    const verdict = evaluateMinimalPickupOrder({
      quote,
      customerId: identity.kind === 'existing' ? identity.customerId : '',
      customer: { firstName: identity.firstName, lastName: identity.lastName },
    });
    return verdict.ok
      ? { ok: true, snapshot: verdict.snapshot }
      : {
          ok: false,
          reply: MINIMAL_ORDER_INELIGIBLE_REPLIES[verdict.reason],
          reason: verdict.reason,
        };
  }

  /**
   * A delivery order needs a stored backend quote for a deliverable zone with
   * a quoteId, not yet expired, whose cart and address pins still match. A
   * pickup order needs a pickup choice whose cart pin still matches (S4).
   */
  private currentShipping(
    cart: MinimalCartState,
    snapshot: MinimalOrderSnapshot,
  ): MinimalOrderShipping | null {
    const record = cart.shipping;
    if (record === undefined) return null;
    const cartLines = snapshot.items.map((item) => ({
      productId: item.productId,
      ...(item.variantId === undefined ? {} : { variantId: item.variantId }),
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      finalPriceCents: item.finalPriceCents,
    }));
    if (isMinimalPickup(record))
      return isPickupCurrent(record, cartLines) ? { mode: 'pickup' } : null;
    if (
      snapshot.draft === null ||
      record.quoteId === null ||
      isShippingCurrent(record, {
        cartLines,
        address: snapshot.draft.address,
        nowMs: this.now(),
      }) !== 'current'
    )
      return null;
    return {
      quoteId: record.quoteId,
      customerChargeCents: record.customerChargeCents,
      creditCents: record.creditCents,
      option:
        record.option === null
          ? null
          : { carrier: record.option.carrier, service: record.option.service },
      eta: minimalShippingEta(record),
    };
  }

  /**
   * Persist the idempotency key through the cart CAS BEFORE the sale call,
   * create the sale once, then clear the cart and record the placed sale.
   * The reply never claims an order that the backend did not confirm.
   */
  private async place(
    senderId: string,
    snapshot: MinimalOrderSnapshot,
  ): Promise<string> {
    const unverified = MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified;
    const phone = parseMexicanWhatsAppPhone(senderId);
    if (phone === null) return unverified;
    const parsed =
      snapshot.draft === null
        ? this.pickupPayload(phone, snapshot)
        : this.deliveryPayload(phone, snapshot, snapshot.draft);
    if (parsed === 'invalid_state') return MINIMAL_CHECKOUT_INVALID_STATE_REPLY;
    if (!parsed.success) return unverified;
    return this.send(senderId, snapshot, parsed.data);
  }

  /** Store pickup (C1): identity only, no deliveryAddress, merchandise total. */
  private pickupPayload(
    phone: { phoneCountryCode: string; phone: string },
    snapshot: MinimalOrderSnapshot,
  ) {
    const customer = snapshot.customer;
    return CreateCheckoutInputSchema.safeParse({
      ...phone,
      customer:
        snapshot.customerId !== ''
          ? { mode: 'existing', customerId: snapshot.customerId }
          : {
              mode: 'createIfAbsent',
              firstName: customer?.firstName,
              ...(customer?.lastName == null
                ? {}
                : { lastName: customer.lastName }),
            },
      sale: {
        ...this.saleLines(snapshot),
        expectedTotalCents: snapshot.totalCents,
        shipping: { mode: 'pickup' },
      },
    });
  }

  private saleLines(snapshot: MinimalOrderSnapshot) {
    return {
      cashierUserId: this.cashierUserId,
      items: snapshot.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: item.name,
        variantName: item.variantName ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
    };
  }

  private deliveryPayload(
    phone: { phoneCountryCode: string; phone: string },
    snapshot: MinimalOrderSnapshot,
    draft: NonNullable<MinimalOrderSnapshot['draft']>,
  ) {
    const address = draft.address;
    const state =
      address.kind !== 'saved' ? toMexicanState(address.fields.state) : null;
    if (address.kind !== 'saved' && state === null) return 'invalid_state';
    return CreateCheckoutInputSchema.safeParse({
      ...phone,
      customer:
        address.kind !== 'new'
          ? { mode: 'existing', customerId: snapshot.customerId }
          : {
              mode: 'createIfAbsent',
              firstName: draft.customer.firstName,
              ...(draft.customer.lastName === null
                ? {}
                : { lastName: draft.customer.lastName }),
            },
      deliveryAddress:
        address.kind === 'saved'
          ? {
              mode: 'existing',
              addressId: snapshot.shippingAddressId,
              expectedVersion: address.snapshot.version,
            }
          : {
              ...(address.kind === 'savedCorrected'
                ? {
                    mode: 'existingUpdated',
                    addressId: address.snapshot.id,
                    expectedVersion: address.snapshot.version,
                  }
                : { mode: 'newSaved' }),
              address: {
                ...Object.fromEntries(
                  Object.entries(address.fields).filter(
                    ([, value]) => value !== null,
                  ),
                ),
                state,
              },
            },
      sale: {
        ...this.saleLines(snapshot),
        expectedTotalCents:
          snapshot.totalCents +
          (snapshot.shipping !== undefined && 'quoteId' in snapshot.shipping
            ? snapshot.shipping.customerChargeCents
            : 0),
        ...(snapshot.shipping === undefined
          ? {}
          : {
              shipping:
                'quoteId' in snapshot.shipping
                  ? { quoteId: snapshot.shipping.quoteId }
                  : { mode: 'pickup' },
            }),
      },
    });
  }

  /**
   * Persist the key, POST once and map the outcome; see `place`. A
   * definite quote rejection returns a recovery marker for `consume`.
   */
  private async send(
    senderId: string,
    snapshot: MinimalOrderSnapshot,
    checkoutPayload: CreateCheckoutInput,
  ): Promise<string> {
    const unverified = MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified;
    const digest = fingerprint(checkoutPayload);
    // `keyed` is the parsed cart; `stored` is the exact value now in the slot,
    // the only valid CAS expectation (parsed objects are not plain data).
    let keyed: MinimalCartState;
    let stored: unknown;
    try {
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      if (cart === null || !sameCartLines(cart, snapshot)) return unverified;
      const shipping = this.currentShipping(cart, snapshot);
      if (
        shipping === null ||
        !sameMinimalOrder(snapshot, { ...snapshot, shipping })
      ) {
        return MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY;
      }
      // Every call is counted in the slot BEFORE it is made, so a crash or an
      // uncertain response always leaves evidence of an earlier attempt.
      if (cart.idempotencyKey === '') {
        keyed = structuredClone({
          ...cart,
          idempotencyKey: randomUUID(),
          idempotencyFingerprint: digest,
          idempotencyAttempts: 1,
        });
      } else if (cart.idempotencyFingerprint === digest) {
        keyed = structuredClone({
          ...cart,
          // Status reads are not POST attempts. A legacy key had one attempt.
          idempotencyAttempts: (cart.idempotencyAttempts ?? 1) + 1,
        });
      } else {
        // An unresolved attempt carried another payload: reusing its key could
        // be rejected as a conflict, rotating could duplicate it. Hold.
        return MINIMAL_ORDER_HELD_REPLY;
      }
      if (!(await this.commitCart(senderId, raw, keyed))) return unverified;
      stored = keyed;
    } catch {
      return unverified;
    }

    let sale: unknown;
    let pickupLocation: CheckoutPickupLocation | null | undefined;
    try {
      const response = await this.api.createCheckout(
        checkoutPayload,
        keyed.idempotencyKey,
      );
      sale = response?.sale;
      pickupLocation =
        response !== undefined && 'pickupLocation' in response
          ? response.pickupLocation
          : undefined;
    } catch (error) {
      // A 201 whose body fails the strict contract parse: the sale may exist
      // under our key. Read it back at once (a GET, never a second POST); a
      // failed read keeps the key for the next turn's recovery.
      if (error instanceof UpstreamError && error.statusCode === 201) {
        const own = await this.ownCheckout(keyed.idempotencyKey);
        return own.kind === 'sale'
          ? this.completeSale(
              senderId,
              stored,
              own.sale,
              snapshot.shipping,
              own.pickupLocation,
              checkoutFirstName(snapshot),
            )
          : MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;
      }
      const code = error instanceof ChatbotApiError ? error.errorCode : null;
      // A SHIPPING_QUOTE_* error proves THIS call wrote nothing. After an
      // earlier uncertain attempt (or for ALREADY_USED, where the quote may
      // back our own sale) the key is read first: a sale under it is ours to
      // complete; a confirmed absence lets the key be cleared below.
      let earlierResolved = false;
      if (
        isQuoteRejection(error) &&
        (code === SHIPPING_QUOTE_ALREADY_USED ||
          (keyed.idempotencyAttempts ?? 1) > 1)
      ) {
        const own = await this.ownCheckout(keyed.idempotencyKey);
        if (own.kind === 'sale')
          return this.completeSale(
            senderId,
            stored,
            own.sale,
            snapshot.shipping,
            own.pickupLocation,
            checkoutFirstName(snapshot),
          );
        earlierResolved = own.kind === 'absent';
      }
      if (code === INVALID_CHECKOUT_REQUEST)
        this.logger.warn(
          `checkout rejected ${INVALID_CHECKOUT_REQUEST}: ${error instanceof Error ? error.message : ''}`,
        );
      const customerMismatch =
        code === SHIPPING_QUOTE_MISMATCH &&
        error instanceof ChatbotApiError &&
        checkoutErrorMismatches(error.responseBody).includes('CUSTOMER');
      if (customerMismatch) this.checkout.clearSelection(senderId);
      const addressRejected =
        error instanceof ChatbotApiError &&
        (error.errorCode === 'ADDRESS_VERSION_CONFLICT' ||
          error.errorCode === 'SHIPPING_ADDRESS_NOT_FOUND');
      if (addressRejected) this.checkout.clearSelection(senderId);
      if (classifyFailure(error) === 'keep') {
        return MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;
      }
      // A definite rejection only proves THIS call created nothing; an earlier
      // uncertain call under the same key may have, so it is never rotated.
      const ambiguousPhone =
        error instanceof ChatbotApiError &&
        error.errorCode === 'CUSTOMER_PHONE_AMBIGUOUS';
      if ((keyed.idempotencyAttempts ?? 1) > 1 && !earlierResolved) {
        return ambiguousPhone
          ? MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY
          : MINIMAL_ORDER_UNRESOLVED_REPLY;
      }
      const unkeyed = structuredClone({ ...keyed, idempotencyKey: '' });
      delete unkeyed.idempotencyFingerprint;
      delete unkeyed.idempotencyAttempts;
      // A quote is pinned to lines and address, never to the customer: kept,
      // it would be resent after the re-check and fail the same way.
      if (customerMismatch) delete unkeyed.shipping;
      await this.commitCart(senderId, stored, unkeyed);
      if (ambiguousPhone) return MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY;
      if (addressRejected) return MINIMAL_CHECKOUT_RESELECT_REPLY;
      if (customerMismatch) return MINIMAL_ORDER_CUSTOMER_RECHECK_REPLY;
      if (code === PROMO_RE_QUOTE) return PROMO_REPRICE_MARKER;
      if (
        error instanceof ChatbotApiError &&
        error.errorCode !== null &&
        VARIANT_REJECTION_CODES.has(error.errorCode)
      ) {
        return MINIMAL_ORDER_VARIANT_CHANGED_REPLY;
      }
      if (
        error instanceof ChatbotApiError &&
        error.errorCode === 'STOCK_INSUFFICIENT_AT_CONFIRM'
      ) {
        return MINIMAL_ORDER_STOCK_CHANGED_REPLY;
      }
      if (
        error instanceof ChatbotApiError &&
        error.errorCode !== null &&
        Object.hasOwn(SHIPPING_REJECTION_REPLIES, error.errorCode)
      ) {
        return SHIPPING_REJECTION_REPLIES[error.errorCode];
      }
      return MINIMAL_ORDER_REJECTED_REPLY;
    }
    if (!isSale(sale)) return MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;

    return this.completeSale(
      senderId,
      stored,
      sale,
      snapshot.shipping,
      pickupLocation,
      checkoutFirstName(snapshot),
    );
  }

  /** What `/checkouts/status` shows under this key: our sale, a confirmed
   * `not_observed`, or `unknown` when the read failed. */
  private async ownCheckout(key: string): Promise<
    | {
        kind: 'sale';
        sale: PlacedSaleIdentity;
        pickupLocation?: CheckoutPickupLocation | null;
      }
    | { kind: 'absent' | 'unknown' }
  > {
    try {
      const status = await this.api.getCheckoutStatus(key);
      if (status.status === 'not_observed') return { kind: 'absent' };
      if (!isSale(status.checkout?.sale)) return { kind: 'unknown' };
      return {
        kind: 'sale',
        sale: status.checkout.sale,
        pickupLocation:
          'pickupLocation' in status.checkout
            ? status.checkout.pickupLocation
            : undefined,
      };
    } catch {
      return { kind: 'unknown' };
    }
  }

  private async completeSale(
    senderId: string,
    stored: unknown,
    sale: PlacedSaleIdentity,
    shipping?: { mode: 'pickup' } | { customerChargeCents: number },
    pickupLocation?: CheckoutPickupLocation | null,
    firstName?: string | null,
  ): Promise<string> {
    // The sale exists; a lost cart write must not hide it from the customer.
    await this.commitCart(senderId, stored, {
      items: [],
      idempotencyKey: '',
      placedSale: {
        saleId: sale.saleId,
        folio: sale.folio,
        totalCents: sale.totalCents,
      },
    });
    // S1: best effort; the profile never blocks the order-created reply.
    if (sale.folio !== null)
      await this.profiles?.recordOrder(
        senderId,
        {
          folio: sale.folio,
          confirmedAt: saleConfirmedAt(sale, this.now()),
          totalCents: sale.totalCents,
        },
        firstName,
      );
    const created = minimalOrderCreatedReply(sale, shipping, pickupLocation);
    return `${created}\n\n${await this.paymentInstructions()}`;
  }

  private async paymentInstructions(): Promise<string> {
    try {
      return minimalPaymentInstructions(await this.api.getPaymentDetails());
    } catch {
      return MINIMAL_ORDER_PAYMENT_UNAVAILABLE_REPLY;
    }
  }

  /** One CAS attempt on the owned cart slot; `false` never retries. */
  private async commitCart(
    senderId: string,
    expected: unknown,
    next: MinimalCartState,
  ): Promise<boolean> {
    if (typeof this.store.commitMinimalCart !== 'function') return false;
    try {
      return await this.store.commitMinimalCart(
        senderId,
        expected,
        next,
        new Date().toISOString(),
      );
    } catch {
      return false;
    }
  }
}
