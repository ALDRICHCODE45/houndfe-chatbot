import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import type {
  BotSaleResponse,
  CreateSaleInput,
} from '../../chatbot-api/domain/dtos/sales.dto';
import {
  CreateCheckoutInputSchema,
  type CreateCheckoutInput,
} from '../../chatbot-api/domain/dtos/checkout.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MinimalOrderConfirmation,
  evaluateMinimalOrder,
  sameMinimalOrder,
  type MinimalOrderIneligibleReason,
  type MinimalOrderSnapshot,
  type MinimalOrderShipping,
} from '../domain/minimal-order-confirmation';
import {
  classifyMinimalShipping,
  isShippingCurrent,
} from '../domain/minimal-shipping';
import {
  MinimalCartService,
  parseMinimalCart,
  type MinimalCartState,
} from './minimal-cart.service';
import {
  MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY,
  MINIMAL_CHECKOUT_RESELECT_REPLY,
  MinimalCheckoutService,
  type MinimalCheckoutReply,
} from './minimal-checkout.service';

export const MINIMAL_ORDER_INELIGIBLE_REPLIES: Record<
  MinimalOrderIneligibleReason,
  string
> = {
  cart_unverified:
    'No pude verificar los precios y existencias de su carrito. No se creó ningún pedido.',
  empty_cart:
    'Su carrito está vacío. Agregue productos antes de hacer su pedido. No se creó ningún pedido.',
  promotion_review:
    'Las promociones de su carrito requieren revisión del equipo antes de crear el pedido. No se creó ningún pedido.',
  delivery_unconfirmed:
    'Antes de crear el pedido necesito que confirme sus datos de entrega. No se creó ningún pedido.',
  new_address_unsupported:
    'Por ahora solo puedo crear pedidos para clientes registrados con una dirección guardada. No se creó ningún pedido.',
};
export const MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY =
  'Antes de crear el pedido, solicite y confirme el envío con una cotización vigente aprobada por el equipo. No se creó ningún pedido.';
export const MINIMAL_ORDER_CHANGED_REPLY =
  'Su pedido cambió desde el último resumen; no se creó ningún pedido. Revise el resumen actualizado:';
export const MINIMAL_ORDER_REJECTED_REPLY =
  'No se pudo crear el pedido. Puede revisar su carrito y pedir de nuevo el resumen cuando quiera.';
export const MINIMAL_ORDER_HELD_REPLY =
  'Tengo una solicitud de pedido anterior que no pude confirmar y sus datos ya no coinciden con este resumen. Para no duplicar su pedido no creé uno nuevo; por favor comuníquese con la tienda para revisarlo.';
export const MINIMAL_ORDER_UNRESOLVED_REPLY =
  'No pude confirmar si su pedido anterior quedó registrado y no puedo crear otro sin riesgo de duplicarlo. Por favor comuníquese con la tienda para revisarlo.';
export const MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY =
  'No pude confirmar si su pedido quedó registrado. Si vuelve a pedir el resumen y responde SÍ, usaré la misma solicitud para no duplicarlo.';
const PAYMENT_UNAVAILABLE_REPLY =
  'No pude obtener los datos para la transferencia en este momento; su pedido sí quedó registrado.';

/**
 * Definite rejections. `IDEMPOTENCY_KEY_CONFLICT` is NOT one: the backend
 * already saw this key with another payload, so a sale may exist under it.
 */
const ROTATING_ERROR_CODES: ReadonlySet<string> = new Set(['PROMO_RE_QUOTE']);
const KEEPING_ERROR_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_KEY_IN_FLIGHT',
  'IDEMPOTENCY_KEY_CONFLICT',
]);

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;

type FreshOrder =
  | { ok: true; snapshot: MinimalOrderSnapshot }
  | { ok: false; reply: string };

/**
 * After a sale attempt: `rotate` when the backend definitely did not create it
 * (the key must not be reused for a different payload); `keep` when the outcome
 * is unknown or still in flight, so a retry replays the same key.
 */
function classifyFailure(error: unknown, atomic = false): 'rotate' | 'keep' {
  if (!(error instanceof ChatbotApiError)) return 'keep';
  if (atomic && error.errorCode === 'CHECKOUT_RETRY_REQUIRED') return 'keep';
  if (error.errorCode !== null && KEEPING_ERROR_CODES.has(error.errorCode)) {
    return 'keep';
  }
  const status = error.statusCode;
  if (
    !atomic &&
    error.errorCode !== null &&
    ROTATING_ERROR_CODES.has(error.errorCode)
  ) {
    return 'rotate';
  }
  return status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
    ? 'rotate'
    : 'keep';
}

function isSale(value: unknown): value is BotSaleResponse {
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

/** Deterministic digest of the exact payload sent under one key. */
function fingerprint(payload: CreateSaleInput | CreateCheckoutInput): string {
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
 * ONLINE sale for a unique customer with a confirmed saved
 * address, only after a strict armed SÍ for the exact presented summary. It
 * never registers customers, mutates addresses, reserves stock outside the
 * sale, quotes shipping or takes payment. Default off.
 */
@Injectable()
export class MinimalOrderService {
  private readonly confirmation = new MinimalOrderConfirmation();
  private readonly orderEnabled: boolean;
  private readonly shippingEnabled: boolean;
  private readonly atomicCheckoutEnabled: boolean;
  private readonly cashierUserId: string;

  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly api: ChatbotApiClient,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    private readonly cart: MinimalCartService,
    private readonly checkout: MinimalCheckoutService,
    config: ConfigService,
  ) {
    this.orderEnabled =
      config.get<{ orderEnabled?: boolean }>('minimalCatalogAgent')
        ?.orderEnabled === true;
    this.shippingEnabled =
      config.get<{ shippingEnabled?: boolean }>('minimalCatalogAgent')
        ?.shippingEnabled === true;
    this.atomicCheckoutEnabled =
      config.get<{ atomicCheckoutEnabled?: boolean }>('minimalCatalogAgent')
        ?.atomicCheckoutEnabled === true;
    const cashier = config.get<string>('chatbotApi.cashierUserId');
    this.cashierUserId = typeof cashier === 'string' ? cashier.trim() : '';
  }

  /** Gate, server-owned cashier and the owned CAS capabilities. */
  get enabled(): boolean {
    return (
      this.orderEnabled &&
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
      return {
        reply: recovery.outstanding
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : fresh.reply,
      };
    }
    return this.offer(senderId, inboundEvent, fresh.snapshot);
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
    const result = this.confirmation.consume({
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
    if (!fresh.ok)
      return {
        reply: recovery.outstanding
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : fresh.reply,
      };
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
    return {
      reply:
        recovery.outstanding &&
        (reply === MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified ||
          reply === MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY)
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : reply,
    };
  }

  /** Resolve an earlier POST before consulting mutable stock/address/shipping. */
  private async recoverOutstanding(
    senderId: string,
  ): Promise<{ outstanding: boolean; reply?: string }> {
    if (!this.atomicCheckoutEnabled) return { outstanding: false };
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
      if (status.status === 'succeeded' && isSale(status.checkout?.sale)) {
        return {
          outstanding: true,
          reply: await this.completeSale(
            senderId,
            raw,
            status.checkout.sale,
            this.shippingEnabled && cart !== null && cart.shipping !== undefined
              ? { classification: classifyMinimalShipping(cart.shipping) }
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

  /** Fresh quote + exact confirmed draft + saved-address freshness. */
  private async freshOrder(senderId: string): Promise<FreshOrder> {
    try {
      const quote = await this.cart.view(senderId);
      const confirmedDraft = await this.checkout.confirmedDraft(senderId);
      const verdict = evaluateMinimalOrder({
        confirmedDraft,
        quote: quote.ok ? quote : null,
      });
      if (!verdict.ok) {
        return {
          ok: false,
          reply: MINIMAL_ORDER_INELIGIBLE_REPLIES[verdict.reason],
        };
      }
      const revalidation = await this.checkout.revalidateSelection(
        senderId,
        verdict.snapshot.draft,
      );
      if (revalidation === 'reselect') {
        return { ok: false, reply: MINIMAL_CHECKOUT_RESELECT_REPLY };
      }
      if (revalidation === 'unavailable') {
        return { ok: false, reply: MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY };
      }
      if (this.shippingEnabled) {
        const raw = (await this.store.get(senderId))?.data.minimalCart;
        const cart = parseMinimalCart(raw);
        const shipping =
          cart === null ? null : this.currentShipping(cart, verdict.snapshot);
        if (shipping === null)
          return { ok: false, reply: MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY };
        return { ok: true, snapshot: { ...verdict.snapshot, shipping } };
      }
      return verdict;
    } catch {
      return {
        ok: false,
        reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified,
      };
    }
  }

  /** Freshness alone never authorizes a sale: require exact human approval. */
  private currentShipping(
    cart: MinimalCartState,
    snapshot: MinimalOrderSnapshot,
  ): MinimalOrderShipping | null {
    const record = cart.shipping;
    const address = snapshot.draft.address;
    if (
      record === undefined ||
      record.approval.state !== 'approved' ||
      address.kind !== 'saved' ||
      isShippingCurrent(record, {
        cartLines: snapshot.items.map((item) => ({
          productId: item.productId,
          ...(item.variantId === undefined
            ? {}
            : { variantId: item.variantId }),
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          finalPriceCents: item.finalPriceCents,
        })),
        addressId: address.snapshot.id,
        addressVersion: address.snapshot.version,
        nowMs: Date.now(),
      }) !== 'current'
    )
      return null;
    return {
      classification: classifyMinimalShipping(record),
      chargeCents: record.customerPaysCents,
      approvalId: record.approval.requestId,
      quoteId: record.quoteId,
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
    // `keyed` is the parsed cart; `stored` is the exact value now in the slot,
    // the only valid CAS expectation (parsed objects are not plain data).
    const legacyPayload: CreateSaleInput = {
      cashierUserId: this.cashierUserId,
      customerId: snapshot.customerId,
      shippingAddressId: snapshot.shippingAddressId,
      expectedTotalCents:
        snapshot.totalCents + (snapshot.shipping?.chargeCents ?? 0),
      ...(snapshot.shipping?.classification === 'charged'
        ? {
            shipping: {
              chargeCents: snapshot.shipping.chargeCents,
              approvalId: snapshot.shipping.approvalId,
              quoteId: snapshot.shipping.quoteId,
            },
          }
        : {}),
      items: snapshot.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: item.name,
        variantName: item.variantName ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
    };
    let checkoutPayload: CreateCheckoutInput | undefined;
    if (this.atomicCheckoutEnabled) {
      const phone = parseMexicanWhatsAppPhone(senderId);
      const address = snapshot.draft.address;
      if (phone === null || address.kind !== 'saved') return unverified;
      const parsed = CreateCheckoutInputSchema.safeParse({
        ...phone,
        customer: { mode: 'existing', customerId: snapshot.customerId },
        deliveryAddress: {
          mode: 'existing',
          addressId: snapshot.shippingAddressId,
          expectedVersion: address.snapshot.version,
        },
        sale: {
          cashierUserId: legacyPayload.cashierUserId,
          items: legacyPayload.items,
          expectedTotalCents: legacyPayload.expectedTotalCents,
          ...(legacyPayload.shipping
            ? { shipping: legacyPayload.shipping }
            : {}),
        },
      });
      if (!parsed.success) return unverified;
      checkoutPayload = parsed.data;
    }
    const digest = fingerprint(checkoutPayload ?? legacyPayload);
    let keyed: MinimalCartState;
    let stored: unknown;
    try {
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      if (cart === null || !sameCartLines(cart, snapshot)) return unverified;
      if (this.shippingEnabled) {
        const shipping = this.currentShipping(cart, snapshot);
        if (
          shipping === null ||
          !sameMinimalOrder(snapshot, { ...snapshot, shipping })
        ) {
          return MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY;
        }
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
    try {
      sale =
        checkoutPayload === undefined
          ? await this.api.createSale(legacyPayload, keyed.idempotencyKey)
          : (
              await this.api.createCheckout(
                checkoutPayload,
                keyed.idempotencyKey,
              )
            )?.sale;
    } catch (error) {
      if (classifyFailure(error, this.atomicCheckoutEnabled) === 'keep') {
        return MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;
      }
      // A definite rejection only proves THIS call created nothing; an earlier
      // uncertain call under the same key may have, so it is never rotated.
      if ((keyed.idempotencyAttempts ?? 1) > 1) {
        return MINIMAL_ORDER_UNRESOLVED_REPLY;
      }
      const unkeyed = structuredClone({ ...keyed, idempotencyKey: '' });
      delete unkeyed.idempotencyFingerprint;
      delete unkeyed.idempotencyAttempts;
      await this.commitCart(senderId, stored, unkeyed);
      if (
        this.atomicCheckoutEnabled &&
        error instanceof ChatbotApiError &&
        error.errorCode === 'ADDRESS_VERSION_CONFLICT'
      ) {
        return 'Su dirección guardada cambió. Seleccione y confirme nuevamente sus datos de entrega. No se creó ningún pedido.';
      }
      return MINIMAL_ORDER_REJECTED_REPLY;
    }
    if (!isSale(sale)) return MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;

    return this.completeSale(senderId, stored, sale, snapshot.shipping);
  }

  private async completeSale(
    senderId: string,
    stored: unknown,
    sale: BotSaleResponse,
    shipping?: Pick<MinimalOrderShipping, 'classification'>,
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
    const created =
      (sale.folio === null
        ? 'Su pedido quedó registrado.'
        : `Su pedido quedó registrado con folio ${sale.folio}.`) +
      (shipping === undefined
        ? ` Total de productos: ${mxn(sale.totalCents)}. El envío no está incluido y se coordinará por separado.`
        : shipping.classification === 'free'
          ? ` Total de productos: ${mxn(sale.totalCents)}. envío cubierto por su compra.`
          : ` Total a pagar: ${mxn(sale.totalCents)} (envío incluido).`);
    return `${created}\n\n${await this.paymentInstructions()}`;
  }

  private async paymentInstructions(): Promise<string> {
    try {
      const detail = await this.api.getPaymentDetails();
      return [
        'Para pagar por transferencia:',
        `Banco: ${detail.bankName}`,
        `Beneficiario: ${detail.beneficiary}`,
        `CLABE: ${detail.clabe}`,
        `Cuenta: ${detail.accountNumber}`,
        'Cuando haga la transferencia, envíe aquí la foto de su comprobante.',
      ].join('\n');
    } catch {
      return PAYMENT_UNAVAILABLE_REPLY;
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
