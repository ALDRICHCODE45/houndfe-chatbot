import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';

/**
 * The estimate reaches the customer inside the 24 h service window that
 * follows their last message, so a note older than two days can never be
 * used; it only has to outlive the human's answer.
 */
export const BACKORDER_QUANTITY_TTL_MS = 48 * 60 * 60 * 1000;
const ITEMS_MAX = 8;
const COUNT_MIN = 2;
const COUNT_MAX = 999;

const TOPIC = /^(?:variant|product):[0-9a-f-]{36}$/;
const payloadSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        topic: z.string().regex(TOPIC),
        quantity: z.number().int().min(COUNT_MIN).max(COUNT_MAX),
      }),
    )
    .max(ITEMS_MAX),
});

type Notes = {
  items: Array<{ topic: string; quantity: number }>;
  expiresAt: number;
};

const topicOf = (productId: string, variantId: string | null): string =>
  variantId === null ? `product:${productId}` : `variant:${variantId}`;

/**
 * S4 durable `backorder_quantity` gate: the unit count the customer stated
 * when the RESTOCK request was made, per product/variant topic. The RESTOCK
 * request stores no quantity, so this is where the count waits until the
 * team's estimate arrives (hours later) and the bot offers to schedule the
 * order. Only a count of two or more is a stated count («una» is as often an
 * article); anything else makes the bot ask.
 */
export class DurableBackorderQuantity {
  private readonly notes = new Map<string, Notes>();

  constructor(private readonly gates: ConversationGates) {
    gates.register({
      kind: 'backorder_quantity',
      read: (senderId) => {
        const notes = this.live(senderId);
        return notes === null || notes.items.length === 0
          ? null
          : {
              payload: { items: notes.items.map((item) => ({ ...item })) },
              expiresAt: notes.expiresAt,
            };
      },
      write: (senderId, state) => {
        if (state === null) {
          this.notes.delete(senderId);
          return true;
        }
        const parsed = payloadSchema.safeParse(state.payload);
        if (!parsed.success) {
          this.notes.delete(senderId);
          return false;
        }
        this.notes.set(senderId, {
          items: parsed.data.items,
          expiresAt: state.expiresAt,
        });
        return true;
      },
    });
  }

  /** Remembers the stated count; an invalid count is ignored. */
  note(
    senderId: string,
    productId: string,
    variantId: string | null,
    quantity: number,
  ): void {
    if (
      !Number.isInteger(quantity) ||
      quantity < COUNT_MIN ||
      quantity > COUNT_MAX
    )
      return;
    const topic = topicOf(productId, variantId);
    const kept = (this.live(senderId)?.items ?? []).filter(
      (item) => item.topic !== topic,
    );
    this.notes.set(senderId, {
      items: [...kept, { topic, quantity }].slice(-ITEMS_MAX),
      expiresAt: this.gates.now() + BACKORDER_QUANTITY_TTL_MS,
    });
  }

  read(
    senderId: string,
    productId: string,
    variantId: string | null,
  ): number | null {
    const topic = topicOf(productId, variantId);
    return (
      this.live(senderId)?.items.find((item) => item.topic === topic)
        ?.quantity ?? null
    );
  }

  /** Reads and removes the note (the offer carries its own copy). */
  take(
    senderId: string,
    productId: string,
    variantId: string | null,
  ): number | null {
    const quantity = this.read(senderId, productId, variantId);
    if (quantity === null) return null;
    const notes = this.live(senderId);
    if (notes === null) return null;
    const topic = topicOf(productId, variantId);
    const items = notes.items.filter((item) => item.topic !== topic);
    if (items.length === 0) this.notes.delete(senderId);
    else this.notes.set(senderId, { ...notes, items });
    return quantity;
  }

  private live(senderId: string): Notes | null {
    const notes = this.notes.get(senderId);
    if (notes === undefined) return null;
    if (this.gates.now() >= notes.expiresAt) {
      this.notes.delete(senderId);
      return null;
    }
    return notes;
  }
}
