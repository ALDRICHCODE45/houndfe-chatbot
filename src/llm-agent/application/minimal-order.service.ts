import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { toMexicanState } from '../domain/mexican-state';
import { ConfigService } from '@nestjs/config';
import { CustomerPetsService } from '../../customer-profile/application/customer-pets.service';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import { createHash, randomUUID } from 'node:crypto';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import type { BotSaleResponse } from '../../chatbot-api/domain/dtos/sales.dto';
import {
  BACKORDER_CLIENT,
  type BackorderBot,
  type BackorderClient,
} from '../../backorders/domain/backorder';
import {
  CreateCheckoutInputSchema,
  INVALID_CHECKOUT_REQUEST,
  backorderCheckoutFailure,
  SHIPPING_QUOTE_ALREADY_USED,
  CheckoutPickupLocationSchema,
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
import { sanitizeErrorText } from '../../common/log-safe';
import {
  BACKORDER_MISMATCH_REPLY,
  BACKORDER_REPRICE_FAILED_REPLY,
  BACKORDER_RESCHEDULE_PROMPT,
  BACKORDER_RESCHEDULE_QUESTION,
  BACKORDER_RESERVATION_UNAVAILABLE_REPLY,
  backorderLineDroppedReply,
} from '../domain/backorder-copy';
import {
  backorderRescheduleButtons,
  paymentMethodButtons,
} from '../domain/customer-reply';
import { backorderLineDecision } from './minimal-backorder-checkout';
import { sourceDecisionOf } from './minimal-backorder-confirm.service';
import { paymentMethodsFor } from '../domain/payment-methods';
import {
  MINIMAL_PAYMENT_BUTTONS_PROMPT,
  MINIMAL_PAYMENT_QUESTION,
} from './minimal-payment.service';

import {
  TITLE_EMOJI,
  bold,
  money,
  sectionTitle,
  storeLines,
} from '../domain/whatsapp-format';

export { minimalPaymentInstructions } from './minimal-payment.service';

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
/** A stored total that matches no quote: forces the next price refresh to rewrite. */
const STALE_TOTAL_CENTS = Number.MAX_SAFE_INTEGER;
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
/**
 * Multi-pet T5a R4: checkout refusals about a line's `petId` (contract §5,
 * §9). Nothing was created; a stale pet must never block the order.
 */
const PET_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'PET_NOT_FOUND',
  'PET_ARCHIVED',
  'PET_CUSTOMER_MISMATCH',
]);
/** The same line (or cart line) without its pet. */
function withoutPet<T extends { pet?: unknown }>(line: T): T {
  const copy = { ...line };
  delete copy.pet;
  return copy;
}
const isQuoteRejection = (error: unknown): boolean =>
  error instanceof ChatbotApiError &&
  error.errorCode !== null &&
  QUOTE_REJECTION_CODES.has(error.errorCode);

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

/**
 * Backend pickup location (C1) on its own lines (message formatting S2,
 * shared store block F3b-fix H3): «Recójalo en *<sucursal>*», the address,
 * «*Horario:* …». No location → no block; null parts are omitted, never
 * invented; values are `plain`.
 */
function pickupLocationLines(
  location: CheckoutPickupLocation | null | undefined,
): string[] {
  if (location === null || location === undefined) return [];
  return ['', ...storeLines('Recójalo en ', location)];
}

/**
 * Server-owned order-created copy; amounts and folio come from the sale.
 * Message formatting S2/S3: the «*¡Pedido registrado!* ✅» title, the bold
 * folio and total lines, then the pickup place and hours apart.
 */
export function minimalOrderCreatedReply(
  sale: PlacedSaleIdentity,
  shipping: { mode: 'pickup' } | { customerChargeCents: number } | undefined,
  pickupLocation: CheckoutPickupLocation | null | undefined,
): string {
  const total = (label: string, note: string | null) =>
    `${bold(`${label}:`)} ${money(sale.totalCents)}${note === null ? '' : ` (${note})`}`;
  return [
    sectionTitle('¡Pedido registrado!', TITLE_EMOJI.created),
    ...(sale.folio === null ? [] : [`${bold('Folio:')} ${sale.folio}`]),
    ...(shipping === undefined
      ? [
          total('Total de productos', null),
          'El envío no está incluido y se coordinará por separado.',
        ]
      : !('customerChargeCents' in shipping)
        ? [total('Total a pagar', 'recoge en tienda, sin costo de envío')]
        : shipping.customerChargeCents === 0
          ? [total('Total a pagar', 'envío sin costo')]
          : [total('Total a pagar', 'envío incluido')]),
    ...pickupLocationLines(pickupLocation),
  ].join('\n');
}

/** A created order whose reply asks how to pay (buttons, then details). */
interface OrderPlaced {
  reply: string;
  saleId: string;
  /** Pay in store S3: a pickup order with PAY_IN_STORE_ENABLED. */
  payInStore: boolean;
}

/** Restock backorder T5b: the checkout refused a backorder line; nothing was created. */
interface BackorderRefused {
  backorderReply: MinimalCheckoutReply;
}

/** The customer reply for a created order: text plus one button per method. */
function orderReply(value: string | OrderPlaced): MinimalCheckoutReply {
  if (typeof value === 'string') return { reply: value };
  return {
    reply: value.reply,
    interactive: paymentMethodButtons(
      value.saleId,
      MINIMAL_PAYMENT_BUTTONS_PROMPT,
      paymentMethodsFor({ payInStore: value.payInStore }),
    ),
    paymentOffer: { saleId: value.saleId },
  };
}

/** The checkout key a cart slot was placed under ('' / absent → null). */
function checkoutKeyOf(stored: unknown): string | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const key = (stored as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === 'string' && key !== '' ? key : null;
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
        line.backorder?.id === item.backorder?.id &&
        line.pet?.id === item.pet?.id &&
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
  /** Pay in store S3 (PAY_IN_STORE_ENABLED, exactly `true`). */
  private readonly payInStoreEnabled: boolean;

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
    // Restock backorder T5b: reads the backorder after a checkout refusal
    // (refreshed price, reschedule offer); optional, the refusal is worded
    // without it.
    @Optional()
    @Inject(BACKORDER_CLIENT)
    private readonly backorders?: BackorderClient,
    // Multi-pet T4b (S8): after an order the prospect's local pets are
    // uploaded (the checkout may have created the Customer); optional.
    @Optional() private readonly pets?: CustomerPetsService,
  ) {
    this.now = now ?? (() => Date.now());
    this.confirmation = new DurableOrderConfirmation(
      gates ?? processLocalConversationGates(),
    );
    const cashier = config.get<string>('chatbotApi.cashierUserId');
    this.cashierUserId = typeof cashier === 'string' ? cashier.trim() : '';
    this.payInStoreEnabled = config.get<unknown>('payInStore.enabled') === true;
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
      return orderReply(recovery.reply);
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
      return orderReply(recovery.reply);
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
    if (typeof reply !== 'string')
      return 'backorderReply' in reply
        ? reply.backorderReply
        : orderReply(reply);
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
  ): Promise<{ outstanding: boolean; reply?: string | OrderPlaced }> {
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
        ...(item.backorder === undefined
          ? {}
          : { backorderId: item.backorder.id }),
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
      ...(item.backorder === undefined
        ? {}
        : { backorderId: item.backorder.id }),
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
  ): Promise<string | OrderPlaced | BackorderRefused> {
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
        // Restock backorder T5b: the line confirms this RESERVED backorder
        // (`unitPriceCents` = its final price); sent only when present.
        ...(item.backorder === undefined
          ? {}
          : { backorderId: item.backorder.id }),
        // Multi-pet T5a R4: the backend pet this line is for; sent only
        // when present (it joins the idempotency hash only then).
        ...(item.pet === undefined ? {} : { petId: item.pet.id }),
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
  ): Promise<string | OrderPlaced | BackorderRefused> {
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
      // Restock backorder T5b: a refusal about a backorder line also proves
      // THIS call wrote nothing; after an earlier uncertain attempt the key is
      // read the same way (a sale under it is ours, an absence clears it).
      const backorderRefusalAfterAttempt =
        (keyed.idempotencyAttempts ?? 1) > 1 &&
        this.isBackorderRefusal(error, keyed);
      // Multi-pet T5a R4: a pet refusal also proves THIS call wrote nothing;
      // after an earlier uncertain attempt the key is read the same way.
      const petRefusal =
        code !== null &&
        PET_REFUSAL_CODES.has(code) &&
        snapshot.items.some((item) => item.pet !== undefined);
      if (
        (isQuoteRejection(error) &&
          (code === SHIPPING_QUOTE_ALREADY_USED ||
            (keyed.idempotencyAttempts ?? 1) > 1)) ||
        backorderRefusalAfterAttempt ||
        (petRefusal && (keyed.idempotencyAttempts ?? 1) > 1)
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
      // S6: a definite rejection (the key is rotated) is never silent. Status
      // and code only; the message is added solely for the request-shape code.
      if (classifyFailure(error) === 'rotate')
        this.logger.warn(
          `checkout rejected status=${error instanceof ChatbotApiError ? (error.statusCode ?? 'none') : 'none'} code=${code ?? 'none'}` +
            (code === INVALID_CHECKOUT_REQUEST && error instanceof Error
              ? `: ${sanitizeErrorText(error.message)}`
              : ''),
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
      if (petRefusal) {
        // Multi-pet T5a R4: the same order without pets (products and prices
        // unchanged) under a new key; the stale current pet goes too. The
        // resent snapshot has no pet, so this happens at most once.
        unkeyed.items = unkeyed.items.map(withoutPet);
        delete unkeyed.currentPet;
        if (!(await this.commitCart(senderId, stored, unkeyed)))
          return unverified;
        this.logger.warn(
          `checkout pet refusal code=${code}: pets removed, resending under a new key`,
        );
        return this.place(senderId, {
          ...snapshot,
          items: snapshot.items.map(withoutPet),
        });
      }
      // A quote is pinned to lines and address, never to the customer: kept,
      // it would be resent after the re-check and fail the same way.
      if (customerMismatch) delete unkeyed.shipping;
      // Restock backorder T5b: a refusal about a backorder line edits the
      // cart copy (drop / refresh the line) before the single commit below.
      const refused = await this.backorderRefusal(error, unkeyed);
      await this.commitCart(senderId, stored, unkeyed);
      if (refused !== null) return refused;
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

  /**
   * Restock backorder T5b: the checkout refused a line that carries a
   * `backorderId` and wrote nothing (the key is already being rotated). The
   * decision is `backorderLineDecision`; this applies it to `cart` (the copy
   * about to be committed) and words the answer. `null`: not a backorder-line
   * refusal, the existing handling answers.
   */
  private async backorderRefusal(
    error: unknown,
    cart: MinimalCartState,
  ): Promise<string | BackorderRefused | null> {
    const failure = backorderCheckoutFailure(error);
    const lines = cart.items.filter((item) => item.backorder !== undefined);
    if (failure === null || lines.length === 0) return null;
    const decision = backorderLineDecision(failure);
    if (decision === null) return null;
    this.logger.warn(
      `checkout backorder refusal code=${failure.code} decision=${decision.kind}` +
        (decision.kind === 'mismatch'
          ? ` field=${decision.field ?? 'none'}`
          : ''),
    );
    if (decision.kind === 'unavailable')
      return {
        backorderReply: { reply: BACKORDER_RESERVATION_UNAVAILABLE_REPLY },
      };
    const read = new Map(
      await Promise.all(
        lines.map(
          async (line) =>
            [
              line.backorder!.id,
              await this.readBackorder(line.backorder!.id),
            ] as const,
        ),
      ),
    );
    const affected = this.affectedLines(lines, read, decision);
    const folio = affected.length === 1 ? affected[0].backorder! : null;
    const dropAffected = () => {
      cart.items = cart.items.filter((item) => !affected.includes(item));
      delete cart.shipping;
      delete cart.expectedTotalCents;
    };
    if (decision.kind === 'mismatch') {
      dropAffected();
      return { backorderReply: { reply: BACKORDER_MISMATCH_REPLY } };
    }
    if (decision.kind === 'reprice') {
      const fresh =
        affected.length === 1
          ? (read.get(affected[0].backorder!.id)?.finalPriceCents ??
            decision.currentPriceCents)
          : null;
      if (fresh === null || !Number.isSafeInteger(fresh) || fresh < 0)
        return { backorderReply: { reply: BACKORDER_REPRICE_FAILED_REPLY } };
      // The stored shipping stays: `freshOrder` re-quotes a delivery quote
      // pinned to the old price (L16) and pickup does not depend on prices.
      // The line price alone never shows as a change (the refresh compares
      // the stored unit prices with the quote's, now equal), so the stored
      // total is parked on a value no real total can equal: the next
      // `refreshPrices` then reports a re-price, which re-quotes a delivery
      // order and rewrites the true total.
      affected[0].unitPriceCents = fresh;
      cart.expectedTotalCents = STALE_TOTAL_CENTS;
      return PROMO_REPRICE_MARKER;
    }
    dropAffected();
    const reply = backorderLineDroppedReply(decision.why, folio);
    const offer =
      decision.why === 'expired' && folio !== null
        ? read.get(folio.id)
        : undefined;
    if (
      offer === undefined ||
      offer === null ||
      sourceDecisionOf(offer) === null
    )
      return { backorderReply: { reply } };
    return {
      backorderReply: {
        reply: `${reply} ${BACKORDER_RESCHEDULE_QUESTION}`,
        interactive: backorderRescheduleButtons(
          offer.id,
          BACKORDER_RESCHEDULE_PROMPT,
        ),
      },
    };
  }

  /** The error is a backorder-line decision for a cart that holds such a line. */
  private isBackorderRefusal(error: unknown, cart: MinimalCartState): boolean {
    if (!cart.items.some((item) => item.backorder !== undefined)) return false;
    const failure = backorderCheckoutFailure(error);
    return failure !== null && backorderLineDecision(failure) !== null;
  }

  /** The backorder as the backend sees it now; `null` when it cannot be read. */
  private async readBackorder(id: string): Promise<BackorderBot | null> {
    try {
      return (await this.backorders?.getBackorder(id)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The error does not name its line. One backorder line is the one; with
   * several, the lines whose backorder no longer fits the refusal (read fresh)
   * are, else every backorder line (nothing could be told apart).
   */
  private affectedLines(
    lines: MinimalCartState['items'],
    read: ReadonlyMap<string, BackorderBot | null>,
    decision: ReturnType<typeof backorderLineDecision>,
  ): MinimalCartState['items'] {
    if (lines.length === 1 || decision === null) return lines;
    const nowMs = this.now();
    const odd = lines.filter((line) => {
      const backorder = read.get(line.backorder!.id);
      if (backorder === undefined || backorder === null) return false;
      if (decision.kind === 'reprice')
        return backorder.finalPriceCents !== line.unitPriceCents;
      if (decision.kind !== 'drop') return false;
      return (
        backorder.status !== 'RESERVED' ||
        !(Date.parse(backorder.reservedUntil ?? '') > nowMs)
      );
    });
    return odd.length > 0 ? odd : decision.kind === 'reprice' ? [] : lines;
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
  ): Promise<OrderPlaced> {
    // Pay in store S3: a pickup order keeps its checkout key (the feed
    // notices read the live hold with it) and its branch.
    const checkoutKey = checkoutKeyOf(stored);
    const payInStore =
      this.payInStoreEnabled &&
      shipping !== undefined &&
      !('customerChargeCents' in shipping) &&
      checkoutKey !== null;
    // The sale exists; a lost cart write must not hide it from the customer.
    await this.commitCart(senderId, stored, {
      items: [],
      idempotencyKey: '',
      placedSale: {
        saleId: sale.saleId,
        folio: sale.folio,
        totalCents: sale.totalCents,
        ...(payInStore
          ? {
              pickup: {
                checkoutKey,
                // Only a contract-valid location is stored: a bad one would
                // make the whole cart slot unreadable.
                location: CheckoutPickupLocationSchema.safeParse(pickupLocation)
                  .success
                  ? (pickupLocation ?? null)
                  : null,
              },
            }
          : {}),
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
    // T4b (S8) / T4b-fix A1: the pet upload runs in the background; it
    // never delays the order-created reply and a failure is only logged.
    this.uploadPetsInBackground(senderId);
    // Bank details are fetched when the customer chooses how to pay.
    return {
      reply: `${minimalOrderCreatedReply(sale, shipping, pickupLocation)}\n\n${MINIMAL_PAYMENT_QUESTION}`,
      saleId: sale.saleId,
      payInStore,
    };
  }

  /** Starts the post-checkout pet upload without awaiting it (A1). */
  private uploadPetsInBackground(senderId: string): void {
    const pets = this.pets;
    if (pets === undefined) return;
    const failed = (error: unknown) =>
      this.logger.warn(
        `customer pets afterCheckout failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    try {
      void Promise.resolve(pets.afterCheckout(senderId)).catch(failed);
    } catch (error) {
      failed(error);
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
