import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';

/**
 * Lifetime of the durable backorder offer. Long enough for a customer to come
 * back to the estimate message (the WhatsApp service window itself is 24 h);
 * a later «sí» after it expires falls to the normal turn.
 */
export const BACKORDER_OFFER_TTL_MS = 24 * 60 * 60 * 1000;

/** Largest unit count the bot schedules from a chat reply. */
export const BACKORDER_QUANTITY_MAX = 999;

export type BackorderOfferStage = 'offer' | 'ask_quantity' | 'ask_name';

/** What the estimate message offered (the gate payload, without bookkeeping). */
export interface BackorderOfferData {
  /** The RESTOCK decision (`sourceDecisionId`). */
  readonly decisionId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly productName: string;
  /** `resolvedAt + restockDays`, ISO UTC. */
  readonly estimatedAt: string;
  /** The count the customer stated when asking; `null` → ask. */
  readonly statedQuantity: number | null;
}

export interface BackorderOfferState extends BackorderOfferData {
  /** `offer`: waiting for yes/no; the next two collect what is missing. */
  readonly stage: BackorderOfferStage;
  /** The count chosen after asking; `null` until then. */
  readonly quantity: number | null;
  readonly expiresAt: number;
}

const payloadSchema = z.strictObject({
  decisionId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid().nullable(),
  productName: z.string().min(1).max(300),
  estimatedAt: z.iso.datetime(),
  statedQuantity: z
    .number()
    .int()
    .min(1)
    .max(BACKORDER_QUANTITY_MAX)
    .nullable(),
  stage: z.enum(['offer', 'ask_quantity', 'ask_name']),
  quantity: z.number().int().min(1).max(BACKORDER_QUANTITY_MAX).nullable(),
});

/**
 * S4 durable `backorder_offer` gate: the offer sent after a RESTOCK estimate
 * («¿Quiere que se lo apartemos en cuanto llegue?»). It is armed outside a
 * customer turn (the RESTOCK application coordinator), only after Meta
 * accepted the message; the customer's next message answers it (tap or yes /
 * no) or spends it. A restarted process restores it from the durable row.
 */
export class DurableBackorderOffer {
  private readonly offers = new Map<string, BackorderOfferState>();

  constructor(private readonly gates: ConversationGates) {
    gates.register({
      kind: 'backorder_offer',
      read: (senderId) => {
        const offer = this.live(senderId);
        return offer === null
          ? null
          : {
              payload: {
                decisionId: offer.decisionId,
                productId: offer.productId,
                variantId: offer.variantId,
                productName: offer.productName,
                estimatedAt: offer.estimatedAt,
                statedQuantity: offer.statedQuantity,
                stage: offer.stage,
                quantity: offer.quantity,
              },
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
          ...parsed.data,
          expiresAt: state.expiresAt,
        });
        return true;
      },
    });
  }

  /** Arms the offer (stage `offer`); replaces any earlier one of the sender. */
  arm(senderId: string, data: BackorderOfferData): void {
    this.offers.set(senderId, {
      ...data,
      stage: 'offer',
      quantity: null,
      expiresAt: this.gates.now() + BACKORDER_OFFER_TTL_MS,
    });
  }

  /** Moves the live offer to its next stage; the expiry never moves. */
  update(
    senderId: string,
    patch: { stage?: BackorderOfferStage; quantity?: number | null },
  ): void {
    const offer = this.live(senderId);
    if (offer === null) return;
    this.offers.set(senderId, { ...offer, ...patch });
  }

  /** Puts back a state read earlier (a retryable failure re-arms it). */
  restore(senderId: string, state: BackorderOfferState): void {
    if (this.gates.now() >= state.expiresAt) return;
    this.offers.set(senderId, state);
  }

  clear(senderId: string): void {
    this.offers.delete(senderId);
  }

  /** The live offer, or `null` when absent or expired. */
  read(senderId: string): BackorderOfferState | null {
    const offer = this.live(senderId);
    return offer === null ? null : { ...offer };
  }

  private live(senderId: string): BackorderOfferState | null {
    const offer = this.offers.get(senderId);
    if (offer === undefined) return null;
    if (this.gates.now() >= offer.expiresAt) {
      this.offers.delete(senderId);
      return null;
    }
    return offer;
  }
}
