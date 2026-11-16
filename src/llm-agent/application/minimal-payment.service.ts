import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import type { PaymentDetail } from '../../chatbot-api/domain/dtos/payment-details.dto';
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
  parseMinimalCart,
  type MinimalCartState,
} from './minimal-cart.service';

/** Asked right after the folio; one button per payment method. */
export const MINIMAL_PAYMENT_QUESTION =
  'Para terminar solo falta el pago. ¿Cómo desea pagar?';
/** Short body for the buttons when the reply text exceeds Meta's limit. */
export const MINIMAL_PAYMENT_BUTTONS_PROMPT = '¿Cómo desea pagar?';
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
  ) {}

  /** The sender's last placed order, or `null`. */
  async placedSale(senderId: string): Promise<PlacedSale | null> {
    return (await this.read(senderId))?.cart.placedSale ?? null;
  }

  /**
   * Bank details for the sender's placed order (`null`: no placed order).
   * A failed read tells the customer the team was notified, persists the
   * marker and creates ONE request per sale; a later success clears it.
   */
  async paymentDetails(
    senderId: string,
    trigger: MinimalPaymentTrigger = {},
  ): Promise<MinimalPaymentReply | null> {
    const read = await this.read(senderId);
    const sale = read?.cart.placedSale;
    if (sale === undefined) return null;
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
    if (!(await this.setMarker(senderId, sale.saleId, true))) return reply;
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

  private async read(senderId: string) {
    try {
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      return cart === null ? null : { raw, cart };
    } catch {
      return null;
    }
  }

  /** One CAS attempt on the owned cart slot; `false` never retries. */
  private async setMarker(
    senderId: string,
    saleId: string,
    pending: boolean,
  ): Promise<boolean> {
    if (typeof this.store.commitMinimalCart !== 'function') return false;
    const read = await this.read(senderId);
    const sale = read?.cart.placedSale;
    if (read === null || sale === undefined || sale.saleId !== saleId)
      return false;
    const { paymentPending: _previous, ...rest } = sale;
    void _previous;
    try {
      return await this.store.commitMinimalCart(
        senderId,
        read.raw,
        {
          ...read.cart,
          placedSale: pending ? { ...rest, paymentPending: true } : rest,
        },
        new Date().toISOString(),
      );
    } catch {
      return false;
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
