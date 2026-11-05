import { Inject, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../../chatbot-api/domain/chatbot-api.client';
import {
  CreateShippingQuoteInputSchema,
  PACKAGING_DATA_MISSING,
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
  buildMinimalShippingQuote,
  minimalShippingDestination,
} from '../domain/minimal-shipping';
import { MinimalCartService, parseMinimalCart } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';

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
      eta: NonNullable<ShippingQuoteResponse['eta']> | null;
    }
  | { kind: 'zone_pending' }
  | { kind: 'zone_denied' }
  | { kind: 'packaging_missing' }
  | { kind: 'unavailable' }
  | { kind: 'refused'; reason: MinimalShippingRefusal };
const refuse = (reason: MinimalShippingRefusal): MinimalShippingResult => ({
  kind: 'refused',
  reason,
});

/** Saved address by id; new or corrected content as loose fields. */
function quoteDestination(
  address: MinimalCheckoutDraftAddress,
): CreateShippingQuoteInput['destination'] {
  if (address.kind === 'saved')
    return { shippingAddressId: address.snapshot.id };
  const f = address.fields;
  const fields = {
    street: f.street,
    exteriorNumber: f.exteriorNumber,
    interiorNumber: f.interiorNumber,
    zipCode: f.zipCode,
    neighborhood: f.neighborhood,
    municipality: f.municipality ?? f.city,
    city: f.city,
    state: f.state === null ? null : (toMexicanState(f.state) ?? f.state),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  ) as CreateShippingQuoteInput['destination'];
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
      // Fresh prices must still describe these exact stored lines and total.
      if (
        stored.items.length !== quote.items.length ||
        !stored.items.every((line, index) => {
          const fresh = quote.items[index];
          return (
            line.productId === fresh.productId &&
            line.variantId === fresh.variantId &&
            line.quantity === fresh.quantity &&
            line.unitPriceCents === fresh.unitPriceCents
          );
        }) ||
        (stored.expectedTotalCents !== undefined &&
          stored.expectedTotalCents !== quote.totalCents)
      )
        return refuse('cart_changed');
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
        return error instanceof ChatbotApiError &&
          error.errorCode === PACKAGING_DATA_MISSING
          ? { kind: 'packaging_missing' }
          : { kind: 'unavailable' };
      }
      const shipping = buildMinimalShippingQuote({
        response,
        cartLines: quote.items.map(
          ({
            productId,
            variantId,
            quantity,
            unitPriceCents,
            finalPriceCents,
          }) => ({
            productId,
            ...(variantId ? { variantId } : {}),
            quantity,
            unitPriceCents,
            finalPriceCents,
          }),
        ),
        destination: minimalShippingDestination(draft.address),
      });
      if (shipping === null || this.now() >= Date.parse(shipping.expiresAt))
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
      if (shipping.zoneStatus === 'PENDING') return { kind: 'zone_pending' };
      if (shipping.zoneStatus === 'DENIED') return { kind: 'zone_denied' };
      return {
        kind: 'quoted',
        zoneStatus: shipping.zoneStatus,
        costCents: shipping.costCents,
        creditCents: shipping.creditCents,
        customerChargeCents: shipping.customerChargeCents,
        option: shipping.option,
        eta: shipping.eta,
      };
    } catch {
      return refuse('cart_unverified');
    }
  }
}
