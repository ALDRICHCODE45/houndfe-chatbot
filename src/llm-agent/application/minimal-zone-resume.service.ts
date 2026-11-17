import { isDeepStrictEqual } from 'node:util';
import type {
  DeliveryZoneCheckoutResume,
  DeliveryZoneCheckoutResumer,
  DeliveryZoneResumeInput,
} from '../../delivery-zones/domain/delivery-zone-resume';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { MinimalCheckoutDraftAddress } from '../../conversation/domain/minimal-checkout-draft';
import {
  ORDER_BUTTONS_PROMPT,
  orderConfirmationButtons,
} from '../domain/customer-reply';
import { MINIMAL_ORDER_SUMMARY_HEADING } from '../domain/minimal-order-confirmation';
import {
  isMinimalPickup,
  minimalShippingDestination,
  minimalZoneResumeShippingSentence,
} from '../domain/minimal-shipping';
import {
  parseMinimalCart,
  type MinimalCartState,
} from './minimal-cart.service';
import type { MinimalCheckoutService } from './minimal-checkout.service';
import type { MinimalOrderService } from './minimal-order.service';
import type { MinimalShippingService } from './minimal-shipping.service';

const zipOf = (address: MinimalCheckoutDraftAddress): string | null =>
  address.kind === 'saved' ? address.snapshot.zipCode : address.fields.zipCode;

/** Same products, variants and quantities (prices are re-verified by the quote). */
function samePinnedLines(
  cart: MinimalCartState,
  pin: ReadonlyArray<{
    productId: string;
    variantId?: string;
    quantity: number;
  }>,
): boolean {
  return (
    cart.items.length === pin.length &&
    pin.every((line) =>
      cart.items.some(
        (item) =>
          item.productId === line.productId &&
          item.variantId === line.variantId &&
          item.quantity === line.quantity,
      ),
    )
  );
}

/**
 * S4: a staff-approved delivery zone resumes the customer's checkout without
 * asking them to request shipping again. It runs OUTSIDE a customer turn (the
 * delivery-zone notifier), so every precondition is re-read from the stored
 * state and any miss returns `null` (the notifier then sends the plain notice):
 *
 *   - FREE / SURCHARGE zone, non-empty cart with no unresolved order attempt;
 *   - the cart still holds the PENDING quote that registered the zone request,
 *     pinned to the same lines and to the same confirmed destination;
 *   - the customer's confirmed delivery data still have the zone's ZIP.
 *
 * It then re-quotes through `MinimalShippingService` (one cart CAS; the quote
 * must be a deliverable FREE / SURCHARGE) and prepares the order summary
 * through `MinimalOrderService`, whose pending summary stays unarmed until the
 * notifier reports the send (`arm`), exactly like a summary sent in a turn.
 */
export class MinimalZoneResumeService implements DeliveryZoneCheckoutResumer {
  constructor(
    private readonly store: ConversationStore,
    private readonly checkout: MinimalCheckoutService,
    private readonly shipping: MinimalShippingService,
    private readonly order: MinimalOrderService,
  ) {}

  async prepare(
    input: DeliveryZoneResumeInput,
  ): Promise<DeliveryZoneCheckoutResume | null> {
    const { senderId } = input;
    try {
      if (input.zoneType !== 'FREE' && input.zoneType !== 'SURCHARGE')
        return null;
      if (!this.order.enabled) return null;
      if (!(await this.stillWaitingForTheZone(input))) return null;
      const quoted = await this.shipping.quote(senderId);
      if (
        quoted.kind !== 'quoted' ||
        (quoted.zoneStatus !== 'FREE' && quoted.zoneStatus !== 'SURCHARGE')
      )
        return null;
      // The notice has no inbound message; a synthetic id can never equal a
      // real wamid, so only a genuine later turn can answer the summary.
      const prepared = await this.order.prepareOrder(senderId, {
        receivingPhoneNumberId: input.receivingPhoneNumberId,
        senderId,
        messageId: `zone-resume:${input.sourceRequestId}`,
      });
      const status = this.order.offerStatus(senderId);
      if (
        prepared.onSent === undefined ||
        status === null ||
        status.armed ||
        !prepared.reply.includes(MINIMAL_ORDER_SUMMARY_HEADING)
      ) {
        this.order.dismiss(senderId);
        return null;
      }
      const arm = prepared.onSent;
      const buttons = orderConfirmationButtons(
        status.reference,
        ORDER_BUTTONS_PROMPT,
      );
      return {
        shippingSentence: minimalZoneResumeShippingSentence(quoted),
        summary: {
          text: prepared.reply,
          buttons: buttons.type === 'buttons' ? buttons.buttons : [],
          prompt: ORDER_BUTTONS_PROMPT,
        },
        arm,
        discard: () => this.order.dismiss(senderId),
      };
    } catch {
      try {
        this.order.dismiss(senderId);
      } catch {
        // Nothing pending to drop.
      }
      return null;
    }
  }

  /** The preconditions that need no backend call. */
  private async stillWaitingForTheZone(
    input: DeliveryZoneResumeInput,
  ): Promise<boolean> {
    const { senderId } = input;
    const cart = parseMinimalCart(
      (await this.store.get(senderId))?.data.minimalCart,
    );
    if (cart === null || cart.items.length === 0 || cart.idempotencyKey !== '')
      return false;
    const pending = cart.shipping;
    if (
      pending === undefined ||
      isMinimalPickup(pending) ||
      pending.zoneStatus !== 'PENDING' ||
      !samePinnedLines(cart, pending.cartPin)
    )
      return false;
    const draft = await this.checkout.confirmedDraft(senderId);
    return (
      draft !== null &&
      zipOf(draft.address) === input.zipCode &&
      isDeepStrictEqual(
        pending.destinationPin,
        minimalShippingDestination(draft.address),
      )
    );
  }
}
