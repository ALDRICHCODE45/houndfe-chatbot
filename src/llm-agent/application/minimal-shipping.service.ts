import { Inject, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import {
  CreateShippingQuoteInputSchema,
  CUSTOMER_PHONE_AMBIGUOUS,
  DUPLICATE_CART_LINE,
  INVALID_SHIPPING_DESTINATION,
  PACKAGING_DATA_MISSING,
  PRICE_OUT_OF_DATE,
  PRODUCT_NOT_FOUND,
  SHIPPING_ADDRESS_INCOMPLETE,
  SHIPPING_ADDRESS_NOT_FOUND,
  VARIANT_NOT_FOUND,
  type CreateShippingQuoteInput,
  type ShippingQuoteResponse,
} from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import type { MinimalCheckoutDraftAddress } from '../../conversation/domain/minimal-checkout-draft';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import { toMexicanState } from '../domain/mexican-state';
import {
  evaluateMinimalOrder,
  type MinimalOrderIneligibleReason,
} from '../domain/minimal-order-confirmation';
import {
  buildMinimalPickup,
  buildMinimalShippingQuote,
  minimalShippingDestination,
  type MinimalShippingCartLine,
  type MinimalShippingQuote,
} from '../domain/minimal-shipping';
import {
  MinimalCartService,
  parseMinimalCart,
  type MinimalCartResult,
  type MinimalCartState,
} from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import {
  DELIVERY_ZONE_INTAKE,
  type DeliveryZoneIntakePort,
  type DeliveryZoneIntakeRequest,
} from '../../delivery-zones/application/delivery-zone-intake.service';

export type MinimalShippingRefusal =
  | MinimalOrderIneligibleReason
  | 'order_unresolved'
  | 'cart_changed'
  | 'address_changed'
  | 'address_unverified'
  | 'unsupported_destination';
export type MinimalShippingResult =
  | {
      kind: 'quoted';
      zoneStatus: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY';
      costCents: number;
      creditCents: number;
      customerChargeCents: number;
      option: ShippingQuoteResponse['option'];
      eta: MinimalShippingQuote['eta'];
      zipCode: string | null;
    }
  | { kind: 'zone_pending'; zipCode: string | null }
  | { kind: 'zone_denied'; zipCode: string | null }
  | MinimalShippingRejection
  | { kind: 'refused'; reason: MinimalShippingRefusal };
export type MinimalPickupResult =
  | { kind: 'pickup' }
  | {
      kind: 'refused';
      reason: Extract<
        MinimalShippingRefusal,
        | 'cart_unverified'
        | 'empty_cart'
        | 'promotion_review'
        | 'order_unresolved'
        | 'cart_changed'
      >;
    };
/** Backend quote rejections; nothing was stored on either side. */
type MinimalShippingRejection = {
  kind:
    | 'prices_changed'
    | 'cart_invalid'
    | 'address_invalid'
    | 'phone_ambiguous'
    | 'packaging_missing'
    | 'unavailable';
};
const REJECTION_KINDS: Readonly<
  Record<string, MinimalShippingRejection['kind']>
> = {
  [PRICE_OUT_OF_DATE]: 'prices_changed',
  [PRODUCT_NOT_FOUND]: 'cart_invalid',
  [VARIANT_NOT_FOUND]: 'cart_invalid',
  [DUPLICATE_CART_LINE]: 'cart_invalid',
  [SHIPPING_ADDRESS_NOT_FOUND]: 'address_invalid',
  [SHIPPING_ADDRESS_INCOMPLETE]: 'address_invalid',
  [INVALID_SHIPPING_DESTINATION]: 'address_invalid',
  [CUSTOMER_PHONE_AMBIGUOUS]: 'phone_ambiguous',
  [PACKAGING_DATA_MISSING]: 'packaging_missing',
};

/** Known codes map to a reply; NO_SHIPPING_BOX_FITS, missing origin, 503 and the rest are `unavailable`. */
function rejectionOf(error: unknown): MinimalShippingRejection {
  const code = error instanceof ChatbotApiError ? error.errorCode : null;
  return {
    kind:
      code !== null && Object.hasOwn(REJECTION_KINDS, code)
        ? REJECTION_KINDS[code]
        : 'unavailable',
  };
}

const refuse = (reason: MinimalShippingRefusal): MinimalShippingResult => ({
  kind: 'refused',
  reason,
});

/** Fresh prices must still describe these exact stored lines and total. */
function sameStoredLines(
  stored: MinimalCartState,
  quote: Extract<MinimalCartResult, { ok: true }>,
): boolean {
  return (
    stored.items.length === quote.items.length &&
    stored.items.every((line, index) => {
      const fresh = quote.items[index];
      return (
        line.productId === fresh.productId &&
        line.variantId === fresh.variantId &&
        line.quantity === fresh.quantity &&
        line.unitPriceCents === fresh.unitPriceCents
      );
    }) &&
    (stored.expectedTotalCents === undefined ||
      stored.expectedTotalCents === quote.totalCents)
  );
}

function pinLines(
  quote: Extract<MinimalCartResult, { ok: true }>,
): MinimalShippingCartLine[] {
  return quote.items.map(
    ({ productId, variantId, quantity, unitPriceCents, finalPriceCents }) => ({
      productId,
      ...(variantId ? { variantId } : {}),
      quantity,
      unitPriceCents,
      finalPriceCents,
    }),
  );
}

function zipOf(address: MinimalCheckoutDraftAddress): string | null {
  return address.kind === 'saved'
    ? address.snapshot.zipCode
    : address.fields.zipCode;
}

/**
 * Saved address by id; new or corrected content as exactly the four zone
 * fields the backend accepts (street and numbers are not sent).
 */
function quoteDestination(
  address: MinimalCheckoutDraftAddress,
): CreateShippingQuoteInput['destination'] {
  if (address.kind === 'saved')
    return { shippingAddressId: address.snapshot.id };
  const f = address.fields;
  const fields = {
    zipCode: f.zipCode,
    state: f.state === null ? null : (toMexicanState(f.state) ?? f.state),
    municipality: f.municipality ?? f.city,
    neighborhood: f.neighborhood,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as CreateShippingQuoteInput['destination'];
}

/** Zone validation destination: the same address the quote used (S5). */
function zoneDestination(
  senderId: string,
  address: MinimalCheckoutDraftAddress,
): DeliveryZoneIntakeRequest {
  const f = address.kind === 'saved' ? address.snapshot : address.fields;
  return {
    senderId,
    zipCode: f.zipCode,
    state: f.state === null ? null : (toMexicanState(f.state) ?? f.state),
    municipality: f.municipality ?? f.city,
    neighborhood: f.neighborhood,
  };
}

/**
 * One `createShippingQuote` call for the verified cart and confirmed
 * destination. The backend picks the carrier, computes the credit and signs
 * the quote (S1-S3); the answer is stored verbatim in `minimalCart.shipping`
 * under one cart CAS. No human approval gates it (S2).
 */
@Injectable()
export class MinimalShippingService {
  constructor(
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    private readonly cart: MinimalCartService,
    private readonly checkout: MinimalCheckoutService,
    @Inject(CHATBOT_API_CLIENT)
    private readonly api: Pick<ChatbotApiClient, 'createShippingQuote'>,
    @Inject(DELIVERY_ZONE_INTAKE)
    private readonly zones: DeliveryZoneIntakePort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async quote(senderId: string): Promise<MinimalShippingResult> {
    try {
      if (!this.store.commitMinimalCart) return refuse('cart_unverified');
      // Keep the EXACT raw slot for CAS, never the zod-parsed reconstruction.
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const stored = parseMinimalCart(raw);
      if (stored === null) return refuse('cart_unverified');
      if (stored.idempotencyKey !== '') return refuse('order_unresolved');
      const quote = await this.cart.view(senderId);
      const draft = await this.checkout.confirmedDraft(senderId);
      const eligibility = evaluateMinimalOrder({
        quote: quote.ok ? quote : null,
        confirmedDraft: draft,
      });
      // Shipping accepts either confirmed destination; new-address ORDER eligibility
      // remains separately gated by the order service.
      if (!eligibility.ok && eligibility.reason !== 'new_address_unsupported')
        return refuse(eligibility.reason);
      if (!quote.ok || draft === null) return refuse('cart_unverified');
      if (!sameStoredLines(stored, quote)) return refuse('cart_changed');
      const revalidation = await this.checkout.revalidateSelection(
        senderId,
        draft,
      );
      if (revalidation === 'reselect') return refuse('address_changed');
      if (revalidation === 'unavailable') return refuse('address_unverified');
      if (
        !isDeepStrictEqual(
          raw,
          (await this.store.get(senderId))?.data.minimalCart,
        )
      )
        return refuse('cart_changed');
      const phone = parseMexicanWhatsAppPhone(senderId);
      if (phone === null) return refuse('cart_unverified');
      const request = CreateShippingQuoteInputSchema.safeParse({
        items: quote.items.map(({ productId, variantId, quantity }) => ({
          productId,
          ...(variantId ? { variantId } : {}),
          quantity,
        })),
        phoneCountryCode: phone.phoneCountryCode,
        phone: phone.phone,
        destination: quoteDestination(draft.address),
      });
      if (!request.success) return refuse('unsupported_destination');
      let response: ShippingQuoteResponse;
      try {
        response = await this.api.createShippingQuote(request.data);
      } catch (error) {
        return rejectionOf(error);
      }
      const shipping = buildMinimalShippingQuote({
        response,
        cartLines: pinLines(quote),
        destination: minimalShippingDestination(draft.address),
      });
      // PENDING/DENIED carry no expiresAt: nothing to expire.
      if (
        shipping === null ||
        (shipping.expiresAt !== null &&
          this.now() >= Date.parse(shipping.expiresAt))
      )
        return { kind: 'unavailable' };
      // Delivery is a separate slot: reject changes during backend latency.
      if (
        !isDeepStrictEqual(draft, await this.checkout.confirmedDraft(senderId))
      )
        return refuse('address_changed');
      const committed = await this.store.commitMinimalCart(
        senderId,
        raw,
        structuredClone({ ...stored, shipping }),
        new Date(this.now()).toISOString(),
      );
      if (!committed) return refuse('cart_changed');
      const zipCode = zipOf(draft.address);
      if (shipping.zoneStatus === 'PENDING') {
        // Register for the DELIVERY_ZONE decision; never blocks the reply.
        await this.zones
          .register(zoneDestination(senderId, draft.address))
          .catch(() => undefined);
        return { kind: 'zone_pending', zipCode };
      }
      if (shipping.zoneStatus === 'DENIED')
        return { kind: 'zone_denied', zipCode };
      return {
        kind: 'quoted',
        zoneStatus: shipping.zoneStatus,
        costCents: shipping.costCents,
        creditCents: shipping.creditCents,
        customerChargeCents: shipping.customerChargeCents,
        option: shipping.option,
        eta: shipping.eta,
        zipCode,
      };
    } catch {
      return refuse('cart_unverified');
    }
  }

  /**
   * Record store pickup (S4) for the verified cart under one cart CAS. Needs
   * no delivery data or backend quote and replaces any stored quote; a cart
   * change drops it like a quote.
   */
  async chooseStorePickup(senderId: string): Promise<MinimalPickupResult> {
    const refused = (
      reason: Extract<MinimalPickupResult, { kind: 'refused' }>['reason'],
    ): MinimalPickupResult => ({ kind: 'refused', reason });
    try {
      if (!this.store.commitMinimalCart) return refused('cart_unverified');
      // Keep the EXACT raw slot for CAS, never the zod-parsed reconstruction.
      const raw: unknown = (await this.store.get(senderId))?.data.minimalCart;
      const stored = parseMinimalCart(raw);
      if (stored === null) return refused('cart_unverified');
      if (stored.idempotencyKey !== '') return refused('order_unresolved');
      const quote = await this.cart.view(senderId);
      if (!quote.ok) return refused('cart_unverified');
      if (quote.items.length === 0) return refused('empty_cart');
      if (quote.promotionEvaluationStatus !== 'fully_evaluated')
        return refused('promotion_review');
      if (!sameStoredLines(stored, quote)) return refused('cart_changed');
      const pickup = buildMinimalPickup(pinLines(quote));
      if (pickup === null) return refused('cart_unverified');
      const committed = await this.store.commitMinimalCart(
        senderId,
        raw,
        structuredClone({ ...stored, shipping: pickup }),
        new Date(this.now()).toISOString(),
      );
      return committed ? { kind: 'pickup' } : refused('cart_changed');
    } catch {
      return refused('cart_unverified');
    }
  }
}
