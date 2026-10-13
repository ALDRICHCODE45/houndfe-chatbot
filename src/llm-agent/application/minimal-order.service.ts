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
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
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
} from '../domain/minimal-order-confirmation';
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
export const MINIMAL_ORDER_CHANGED_REPLY =
  'Su pedido cambió desde el último resumen; no se creó ningún pedido. Revise el resumen actualizado:';
export const MINIMAL_ORDER_REJECTED_REPLY =
  'No se pudo crear el pedido. Puede revisar su carrito y pedir de nuevo el resumen cuando quiera.';
export const MINIMAL_ORDER_HELD_REPLY =
  'Tengo una solicitud de pedido anterior que no pude confirmar y sus datos ya no coinciden con este resumen. Para no duplicar su pedido no creé uno nuevo.';
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
function classifyFailure(error: unknown): 'rotate' | 'keep' {
  if (!(error instanceof ChatbotApiError)) return 'keep';
  if (error.errorCode !== null && KEEPING_ERROR_CODES.has(error.errorCode)) {
    return 'keep';
  }
  if (error.errorCode !== null && ROTATING_ERROR_CODES.has(error.errorCode)) {
    return 'rotate';
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
function fingerprint(payload: CreateSaleInput): string {
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
 * ONLINE sale without shipping for a unique customer with a confirmed saved
 * address, only after a strict armed SÍ for the exact presented summary. It
 * never registers customers, mutates addresses, reserves stock outside the
 * sale, quotes shipping or takes payment. Default off.
 */
@Injectable()
export class MinimalOrderService {
  private readonly confirmation = new MinimalOrderConfirmation();
  private readonly orderEnabled: boolean;
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
    const fresh = await this.freshOrder(senderId);
    if (!fresh.ok) {
      this.confirmation.cancel(senderId);
      return { reply: fresh.reply };
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
    if (!this.enabled || this.confirmation.status(input.senderId) === null) {
      return null;
    }
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
    if (!fresh.ok) return { reply: fresh.reply };
    if (!sameMinimalOrder(fresh.snapshot, result.snapshot)) {
      const offer = this.offer(
        input.senderId,
        input.inboundEvent,
        fresh.snapshot,
      );
      return offer.onSent === undefined
        ? { reply: MINIMAL_ORDER_CHANGED_REPLY }
        : {
            reply: `${MINIMAL_ORDER_CHANGED_REPLY}\n\n${offer.reply}`,
            onSent: offer.onSent,
          };
    }
    return { reply: await this.place(input.senderId, fresh.snapshot) };
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
      return verdict;
    } catch {
      return {
        ok: false,
        reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified,
      };
    }
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
    const payload: CreateSaleInput = {
      cashierUserId: this.cashierUserId,
      customerId: snapshot.customerId,
      shippingAddressId: snapshot.shippingAddressId,
      expectedTotalCents: snapshot.totalCents,
      items: snapshot.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        productName: item.name,
        variantName: item.variantName ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
    };
    const digest = fingerprint(payload);
    let keyed: MinimalCartState;
    let stored: unknown;
    try {
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      if (cart === null || !sameCartLines(cart, snapshot)) return unverified;
      if (cart.idempotencyKey === '') {
        keyed = structuredClone({
          ...cart,
          idempotencyKey: randomUUID(),
          idempotencyFingerprint: digest,
        });
        if (!(await this.commitCart(senderId, raw, keyed))) return unverified;
        stored = keyed;
      } else if (cart.idempotencyFingerprint === digest) {
        keyed = cart;
        stored = raw;
      } else {
        // An unresolved attempt carried another payload: reusing its key could
        // be rejected as a conflict, rotating could duplicate it. Hold.
        return MINIMAL_ORDER_HELD_REPLY;
      }
    } catch {
      return unverified;
    }

    let sale: unknown;
    try {
      sale = await this.api.createSale(payload, keyed.idempotencyKey);
    } catch (error) {
      if (classifyFailure(error) === 'keep') {
        return MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;
      }
      const unkeyed = structuredClone({ ...keyed, idempotencyKey: '' });
      delete unkeyed.idempotencyFingerprint;
      await this.commitCart(senderId, stored, unkeyed);
      return MINIMAL_ORDER_REJECTED_REPLY;
    }
    if (!isSale(sale)) return MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY;

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
      ` Total de productos: ${mxn(sale.totalCents)}. El envío no está incluido y se coordinará por separado.`;
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
