import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';

/**
 * Lifetime of a durable payment offer; mirrors the other short gates (order
 * and delivery summaries, RESTOCK question). It only keeps the customer's
 * next message bound to the payment question across a process restart.
 */
export const MINIMAL_PAYMENT_OFFER_TTL_MS = 5 * 60 * 1000;

const payloadSchema = z.strictObject({ saleId: z.uuid() });

/**
 * S4 durable `payment_offer` gate: the sale the bot's «¿Cómo desea pagar?»
 * question is about. The agent sets it when a turn presents the question and
 * clears it on any other recorded turn; a restarted process restores it from
 * the durable row. The caller still checks the sale against the placed order.
 */
export class DurablePaymentOffer {
  private readonly offers = new Map<
    string,
    { readonly saleId: string; readonly expiresAt: number }
  >();

  constructor(private readonly gates: ConversationGates) {
    gates.register({
      kind: 'payment_offer',
      read: (senderId) => {
        const offer = this.live(senderId);
        return offer === null
          ? null
          : {
              payload: { saleId: offer.saleId },
              expiresAt: offer.expiresAt,
            };
      },
      write: (senderId, state) => {
        if (state === null) {
          this.offers.delete(senderId);
          return true;
        }
        const parsed = payloadSchema.safeParse(state.payload);
        if (!parsed.success) {
          this.offers.delete(senderId);
          return false;
        }
        this.offers.set(senderId, {
          saleId: parsed.data.saleId,
          expiresAt: state.expiresAt,
        });
        return true;
      },
    });
  }

  /** The turn just presented the payment question for `saleId`. */
  offer(senderId: string, saleId: string): void {
    this.offers.set(senderId, {
      saleId,
      expiresAt: this.gates.now() + MINIMAL_PAYMENT_OFFER_TTL_MS,
    });
  }

  clear(senderId: string): void {
    this.offers.delete(senderId);
  }

  /** The live offered sale, or `null` when absent or expired. */
  read(senderId: string): { saleId: string } | null {
    const offer = this.live(senderId);
    return offer === null ? null : { saleId: offer.saleId };
  }

  private live(senderId: string) {
    const offer = this.offers.get(senderId);
    if (offer === undefined) return null;
    if (this.gates.now() >= offer.expiresAt) {
      this.offers.delete(senderId);
      return null;
    }
    return offer;
  }
}
