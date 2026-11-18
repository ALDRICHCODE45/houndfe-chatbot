import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import type { PaymentDetail } from '../../chatbot-api/domain/dtos/payment-details.dto';
import { PAY_IN_STORE_SALE_ALREADY_PAID } from '../../chatbot-api/domain/dtos/pay-in-store.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  HumanRequestCreateService,
  type AskTeamOutcome,
} from '../../human-requests/application/human-request-create.service';
import {
  paymentMethodButtons,
  type CustomerReplyInteractive,
} from '../domain/customer-reply';
import { isPayRemainderRequest } from '../domain/minimal-order-requests';
import {
  PAY_IN_STORE_FAILED_REPLY,
  payInStoreHeldReply,
} from '../../pay-in-store/domain/pay-in-store-copy';
import {
  PAYMENT_METHODS,
  paymentMethodsFor,
  type PaymentMethod,
} from '../domain/payment-methods';
import {
  ReceiptReviewStatusRegistry,
  type ReceiptReviewStatusPort,
} from '../domain/receipt-review-status';
import {
  parseMinimalCart,
  type MinimalCartState,
} from './minimal-cart.service';

/** Asked right after the folio; one button per payment method. */
export const MINIMAL_PAYMENT_QUESTION =
  'Para terminar solo falta el pago. ¿Cómo desea pagar?';
/** Short body for the buttons when the reply text exceeds Meta's limit. */
export const MINIMAL_PAYMENT_BUTTONS_PROMPT = '¿Cómo desea pagar?';
/** The order is paid: no methods, no details, no team request (S6). */
export const MINIMAL_PAYMENT_ALREADY_PAID_REPLY = 'Su pedido ya está pagado.';
/**
 * S6: a payment question while a NEW cart exists after a paid order. The paid
 * order has nothing to pay and the new one is not registered yet, so no bank
 * details exist to share; the team is never asked for them.
 */
export const MINIMAL_PAYMENT_NEW_ORDER_REPLY =
  'Su pedido anterior ya está pagado. Los datos de pago de su nuevo pedido se los comparto en cuanto lo confirme.';
/**
 * Retest S3 (N19): the placed order already has a receipt in review. No bank
 * details (a second transfer is the risk) and no team request.
 */
export function minimalReceiptInReviewReply(folio: string | null): string {
  const order = folio === null ? 'del pedido' : `del pedido ${folio}`;
  return `Ya recibimos su comprobante ${order} y lo estamos revisando; no hace falta que vuelva a pagar. Le aviso en cuanto quede confirmado.`;
}
export const MINIMAL_PAYMENT_UNAVAILABLE_REPLY =
  'No pude obtener los datos en este momento; ya le avisé al equipo y se los comparto en cuanto estén.';

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;

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

type PlacedSale = NonNullable<MinimalCartState['placedSale']>;

/** What the customer is told; `paymentOffer` keeps a later yes bound to it. */
export interface MinimalPaymentReply {
  reply: string;
  paymentOffer?: { saleId: string };
}

/** The placed order as the customer sees it (S5); buttons only when unpaid. */
export interface MinimalPlacedOrderStatus extends MinimalPaymentReply {
  interactive?: CustomerReplyInteractive;
}

/** Where the request is anchored: the triggering inbound, when known. */
export interface MinimalPaymentTrigger {
  inboundAt?: string;
  triggerWaMessageId?: string;
}

/**
 * Payment step after an order: bank details on demand (fetched when asked,
 * not at order time) and the team notice with a persisted marker when they
 * cannot be read. The backend stays the source of truth for the details.
 */
@Injectable()
export class MinimalPaymentService {
  private readonly logger = new Logger(MinimalPaymentService.name);

  constructor(
    @Inject(CHATBOT_API_CLIENT) private readonly api: ChatbotApiClient,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    // Explicit token: a `Pick<>` type would emit `Object` as DI metadata.
    @Optional()
    @Inject(HumanRequestCreateService)
    private readonly team?: Pick<HumanRequestCreateService, 'askTeam'>,
    // Retest S3: a receipt already in review withholds the bank details.
    @Optional()
    @Inject(ReceiptReviewStatusRegistry)
    private readonly receipts?: ReceiptReviewStatusPort,
    // Pay in store S3: PAY_IN_STORE_ENABLED (exactly `true`); absent → off.
    @Optional()
    @Inject(ConfigService)
    config?: Pick<ConfigService, 'get'>,
  ) {
    this.payInStoreEnabled =
      config?.get<unknown>('payInStore.enabled') === true;
  }

  private readonly payInStoreEnabled: boolean;

  /** Pay in store S3: an unpaid pickup order placed with the flag on. */
  private canPayInStore(sale: PlacedSale): boolean {
    return (
      this.payInStoreEnabled && sale.paid !== true && sale.pickup !== undefined
    );
  }

  /**
   * The methods the sender's placed order is offered (the buttons and the
   * typed answer to them): «Pagar en tienda» joins only for a pickup order
   * with pay in store on; otherwise today's list.
   */
  async offeredMethods(senderId: string): Promise<readonly PaymentMethod[]> {
    const sale = (await this.read(senderId))?.cart.placedSale;
    return sale === undefined
      ? PAYMENT_METHODS
      : paymentMethodsFor({ payInStore: this.canPayInStore(sale) });
  }

  /**
   * Pay in store S3: «Pagar en tienda» for the sender's placed order
   * `saleId`. Exactly one PATCH payment-intent per call (the backend is
   * idempotent: a re-tap gets the current hold and the same text). The
   * paid and receipt-in-review rules keep priority (no PATCH). `null`: not
   * offered for this order (another or no placed order, not pickup, flag
   * off), so the caller answers as for a stale button.
   */
  async payInStore(
    senderId: string,
    saleId: string,
  ): Promise<MinimalPaymentReply | null> {
    const sale = (await this.read(senderId))?.cart.placedSale;
    if (sale === undefined || sale.saleId !== saleId) return null;
    if (sale.paid === true)
      return { reply: MINIMAL_PAYMENT_ALREADY_PAID_REPLY };
    if (!this.canPayInStore(sale) || sale.pickup === undefined) return null;
    if (await this.receiptInReview(senderId, sale))
      return { reply: minimalReceiptInReviewReply(sale.folio) };
    const failed = {
      reply: PAY_IN_STORE_FAILED_REPLY,
      // A later «transferencia» still answers this offer.
      paymentOffer: { saleId: sale.saleId },
    };
    if (typeof this.api.setPayInStoreIntent !== 'function') return failed;
    try {
      const hold = await this.api.setPayInStoreIntent(sale.saleId);
      if (sale.pickup.held !== true) await this.markHeld(senderId, sale.saleId);
      return {
        reply: payInStoreHeldReply({
          folio: hold.folio ?? sale.folio,
          holdUntil: hold.holdUntil,
          location: sale.pickup.location,
        }),
      };
    } catch (error) {
      const status = error instanceof ChatbotApiError ? error.statusCode : null;
      const code = error instanceof ChatbotApiError ? error.errorCode : null;
      this.logger.warn(
        `pay in store not set: status=${status ?? 'none'} code=${code ?? 'none'}`,
      );
      if (status === 409 && code === PAY_IN_STORE_SALE_ALREADY_PAID)
        return { reply: MINIMAL_PAYMENT_ALREADY_PAID_REPLY };
      return failed;
    }
  }

  /** The sender's last placed order, or `null`. */
  async placedSale(senderId: string): Promise<PlacedSale | null> {
    return (await this.read(senderId))?.cart.placedSale ?? null;
  }

  /**
   * S5: the sender's placed order (folio, total, payment status / next step).
   * Unpaid: the payment-step lead and the method question, bound to the sale.
   * `null`: no placed order.
   */
  async placedOrderStatus(
    senderId: string,
  ): Promise<MinimalPlacedOrderStatus | null> {
    const sale = (await this.read(senderId))?.cart.placedSale;
    if (sale === undefined) return null;
    if (sale.paid === true)
      return {
        reply: `Pedido ${orderLabel(sale)}. Total: ${mxn(sale.totalCents)}.\n${MINIMAL_PAYMENT_ALREADY_PAID_REPLY}`,
      };
    // Follow-ups S6: no «Pagar en tienda» button while a receipt of this
    // order is in review (a tap or a typed «en tienda» still gets the
    // in-review reply). Read only when the button could be shown; an
    // unreadable receipt state keeps today's offer (fails open).
    const payInStore =
      this.canPayInStore(sale) && !(await this.receiptInReview(senderId, sale));
    return {
      reply: `${paymentLead(sale)}\n\n${MINIMAL_PAYMENT_QUESTION}`,
      interactive: paymentMethodButtons(
        sale.saleId,
        MINIMAL_PAYMENT_BUTTONS_PROMPT,
        paymentMethodsFor({ payInStore }),
      ),
      paymentOffer: { saleId: sale.saleId },
    };
  }

  /**
   * Retest S3: the in-review reply when the sender's unpaid placed order has
   * a receipt waiting for review; `null` otherwise (no placed order, paid,
   * no receipt in review, or the receipt state could not be read).
   */
  async receiptInReviewReply(
    senderId: string,
  ): Promise<MinimalPaymentReply | null> {
    const sale = (await this.read(senderId))?.cart.placedSale;
    if (sale === undefined || sale.paid === true) return null;
    return (await this.receiptInReview(senderId, sale))
      ? { reply: minimalReceiptInReviewReply(sale.folio) }
      : null;
  }

  /**
   * Bank details for the sender's placed order (`null`: no placed order).
   * A paid order answers that it is paid: no details, marker or request.
   * A receipt already in review answers that it is being reviewed (S3),
   * unless `customerText` says the customer must pay the rest or another
   * amount.
   * A failed read tells the customer the team was notified, persists the
   * marker and creates ONE request per sale; a later success clears it.
   */
  async paymentDetails(
    senderId: string,
    trigger: MinimalPaymentTrigger = {},
    customerText?: string,
  ): Promise<MinimalPaymentReply | null> {
    const read = await this.read(senderId);
    const sale = read?.cart.placedSale;
    if (sale === undefined) return null;
    if (sale.paid === true)
      return { reply: MINIMAL_PAYMENT_ALREADY_PAID_REPLY };
    if (
      !isPayRemainderRequest(customerText) &&
      (await this.receiptInReview(senderId, sale))
    )
      return { reply: minimalReceiptInReviewReply(sale.folio) };
    let detail: PaymentDetail;
    try {
      detail = await this.api.getPaymentDetails();
    } catch (error) {
      return this.unavailable(senderId, sale, error, trigger);
    }
    if (sale.paymentPending === true)
      await this.setMarker(senderId, sale.saleId, false);
    return {
      reply: `${paymentLead(sale)}\n\n${minimalPaymentInstructions(detail)}`,
    };
  }

  private async unavailable(
    senderId: string,
    sale: PlacedSale,
    error: unknown,
    trigger: MinimalPaymentTrigger,
  ): Promise<MinimalPaymentReply> {
    const status = error instanceof ChatbotApiError ? error.statusCode : null;
    const code = error instanceof ChatbotApiError ? error.errorCode : null;
    // Status and code only: the message or body could carry bank data.
    this.logger.warn(
      `payment details unavailable: status=${status ?? 'none'} code=${code ?? 'none'}`,
    );
    const reply = {
      reply: MINIMAL_PAYMENT_UNAVAILABLE_REPLY,
      paymentOffer: { saleId: sale.saleId },
    };
    // One request per sale: the marker is written first, so a failed write
    // creates nothing and the next attempt tries again.
    if (sale.paymentPending === true || this.team === undefined) return reply;
    const marked = await this.setMarker(senderId, sale.saleId, true);
    // The order was paid while the read failed: no marker, no request.
    if (marked === 'paid') return { reply: MINIMAL_PAYMENT_ALREADY_PAID_REPLY };
    if (marked === 'failed') return reply;
    let outcome: AskTeamOutcome;
    try {
      outcome = await this.team.askTeam({
        senderId,
        question: pendingQuestion(sale),
        summary: pendingSummary(sale),
        ...(trigger.inboundAt === undefined
          ? {}
          : { inboundAt: trigger.inboundAt }),
        ...(trigger.triggerWaMessageId === undefined
          ? {}
          : { triggerWaMessageId: trigger.triggerWaMessageId }),
      });
    } catch {
      outcome = { kind: 'failed', reason: 'unavailable' };
    }
    // No request exists: drop the marker so the next attempt asks again.
    if (outcome.kind === 'failed') {
      this.logger.warn(
        `payment pending request not created: reason=${outcome.reason}`,
      );
      await this.setMarker(senderId, sale.saleId, false);
    }
    return reply;
  }

  /**
   * Follow-ups S7: records that the customer held `saleId` to pay in store
   * (`placedSale.pickup.held`). One CAS attempt, never retried and never
   * thrown: without the record a later SALE_NOT_PAYABLE receipt refusal
   * keeps today's generic text.
   */
  private async markHeld(senderId: string, saleId: string): Promise<void> {
    let saved = false;
    try {
      const read = await this.read(senderId);
      const sale = read?.cart.placedSale;
      if (
        read !== null &&
        sale?.saleId === saleId &&
        sale.pickup !== undefined &&
        typeof this.store.commitMinimalCart === 'function'
      )
        saved = await this.store.commitMinimalCart(
          senderId,
          read.raw,
          {
            ...read.cart,
            placedSale: { ...sale, pickup: { ...sale.pickup, held: true } },
          },
          new Date().toISOString(),
        );
    } catch {
      saved = false;
    }
    if (!saved) this.logger.warn('pay in store hold not recorded locally');
  }

  /** Fails open: an unreadable receipt state never withholds the details. */
  private async receiptInReview(
    senderId: string,
    sale: PlacedSale,
  ): Promise<boolean> {
    if (this.receipts === undefined) return false;
    try {
      return (
        (await this.receipts.hasReceiptInReview(senderId, sale.saleId)) === true
      );
    } catch {
      this.logger.warn('receipt review status unavailable');
      return false;
    }
  }

  private async read(senderId: string) {
    try {
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      return cart === null ? null : { raw, cart };
    } catch {
      return null;
    }
  }

  /**
   * One CAS attempt on the owned cart slot; `failed` never retries. Setting
   * the marker on a sale the fresh read shows as paid is refused (`paid`).
   */
  private async setMarker(
    senderId: string,
    saleId: string,
    pending: boolean,
  ): Promise<'written' | 'paid' | 'failed'> {
    if (typeof this.store.commitMinimalCart !== 'function') return 'failed';
    const read = await this.read(senderId);
    const sale = read?.cart.placedSale;
    if (read === null || sale === undefined || sale.saleId !== saleId)
      return 'failed';
    if (pending && sale.paid === true) return 'paid';
    const { paymentPending: _previous, ...rest } = sale;
    void _previous;
    try {
      const saved = await this.store.commitMinimalCart(
        senderId,
        read.raw,
        {
          ...read.cart,
          placedSale: pending ? { ...rest, paymentPending: true } : rest,
        },
        new Date().toISOString(),
      );
      return saved ? 'written' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

const orderLabel = (sale: PlacedSale) =>
  sale.folio === null ? 'sin folio' : `con folio ${sale.folio}`;

function paymentLead(sale: PlacedSale): string {
  return `Pedido ${orderLabel(sale)}. Total a pagar: ${mxn(sale.totalCents)}.`;
}

function pendingQuestion(sale: PlacedSale): string {
  return (
    `El cliente quiere pagar por transferencia el pedido ${orderLabel(sale)} ` +
    `(total ${mxn(sale.totalCents)}) y no pude obtener los datos bancarios; ` +
    'necesita que el equipo se los comparta.'
  );
}

function pendingSummary(sale: PlacedSale): string {
  return `Pago por transferencia pendiente del pedido ${orderLabel(sale)}: no se pudieron leer los datos bancarios.`;
}
