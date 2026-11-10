import { z } from 'zod';
import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MinimalOrderConfirmation,
  type MinimalOrderConsumeResult,
  type MinimalOrderPrepareResult,
  type MinimalOrderSnapshot,
  type MinimalOrderStatus,
} from '../../domain/minimal-order-confirmation';
import { normalizeMinimalCheckoutDraft } from '../../../conversation/domain/minimal-checkout-draft';

const cents = z.number().int().nonnegative();
const line = z.strictObject({
  productId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  name: z.string(),
  variantName: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPriceCents: cents,
  finalPriceCents: cents,
  appliedPromotionTitle: z.string().nullable().optional(),
  discountAmountCents: cents.optional(),
});
const shipping = z.union([
  z.strictObject({
    quoteId: z.string().min(1),
    customerChargeCents: cents,
    creditCents: cents.optional(),
    option: z
      .strictObject({ carrier: z.string(), service: z.string() })
      .nullable()
      .optional(),
    eta: z
      .strictObject({
        days: z.number().int().nonnegative().nullable(),
        reason: z.literal('STOCK_PENDING').optional(),
      })
      .nullable()
      .optional(),
  }),
  z.strictObject({ mode: z.literal('pickup') }),
]);
const snapshot = z.strictObject({
  customerId: z.string(),
  shippingAddressId: z.string(),
  // Validated against the sender with the draft normalizer below.
  draft: z.unknown(),
  customer: z
    .strictObject({ firstName: z.string(), lastName: z.string().nullable() })
    .optional(),
  items: z.array(line).min(1).max(100),
  totalCents: cents,
  shipping: shipping.optional(),
});
const payloadSchema = z.strictObject({
  reference: z.uuid(),
  snapshot,
  receivingPhoneNumberId: z.string().min(1),
  originMessageId: z.string().min(1),
  armed: z.boolean(),
});

/**
 * S4 durable `order_confirmation` gate: the same one-shot consent as
 * `MinimalOrderConfirmation`, persisted through `ConversationGates` so a
 * pending summary survives a restart with its original five-minute expiry.
 * A SÍ that yields a candidate also spends the durable row atomically; if
 * another process already spent it, the turn gets the ambiguous reply and no
 * order is created.
 */
export class DurableOrderConfirmation {
  private readonly confirmation: MinimalOrderConfirmation;

  constructor(private readonly gates: ConversationGates) {
    this.confirmation = new MinimalOrderConfirmation({ now: gates.now });
    gates.register({
      kind: 'order_confirmation',
      read: (senderId) => {
        const state = this.confirmation.exportPending(senderId);
        if (state === null) return null;
        const { expiresAt, ...payload } = state;
        return { payload, expiresAt };
      },
      write: (senderId, state) => {
        if (state === null) {
          this.confirmation.restorePending(senderId, null);
          return true;
        }
        const parsed = payloadSchema.safeParse(state.payload);
        if (
          !parsed.success ||
          (parsed.data.snapshot.draft !== null &&
            normalizeMinimalCheckoutDraft(
              parsed.data.snapshot.draft,
              senderId,
            ) === null)
        ) {
          this.confirmation.restorePending(senderId, null);
          return false;
        }
        this.confirmation.restorePending(senderId, {
          ...parsed.data,
          snapshot: parsed.data.snapshot as MinimalOrderSnapshot,
          expiresAt: state.expiresAt,
        });
        return true;
      },
    });
  }

  status(senderId: string): MinimalOrderStatus | null {
    return this.confirmation.status(senderId);
  }

  cancel(senderId: string): void {
    this.confirmation.cancel(senderId);
    this.gates.touch(senderId);
  }

  prepare(
    input: Parameters<MinimalOrderConfirmation['prepare']>[0],
  ): MinimalOrderPrepareResult {
    const result = this.confirmation.prepare(input);
    this.gates.touch(input.senderId);
    return result.kind === 'offer'
      ? { ...result, onSent: this.persisting(input.senderId, result.onSent) }
      : result;
  }

  async consume(
    input: Parameters<MinimalOrderConfirmation['consume']>[0],
  ): Promise<MinimalOrderConsumeResult> {
    const { senderId } = input;
    const result = this.confirmation.consume(input);
    if (result?.kind === 'candidate') {
      const won = await this.gates.claim(senderId, 'order_confirmation', {
        reference: result.reference,
      });
      return won
        ? result
        : { kind: 'handled', reply: MINIMAL_ORDER_AMBIGUOUS_REPLY };
    }
    this.gates.touch(senderId);
    return result?.kind === 'reoffer'
      ? { ...result, onSent: this.persisting(senderId, result.onSent) }
      : result;
  }

  /** Arms in memory, then persists the arming. */
  private persisting(senderId: string, onSent: () => void): () => void {
    return () => {
      onSent();
      this.gates.touch(senderId);
    };
  }
}
