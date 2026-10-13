import { Inject, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  MEASURED_DEMO_SHIPPING_CONFIG,
  type MeasuredDemoShippingConfig,
} from '../../shipping/application/measured-demo-shipping-config';
import { matchMeasuredDemoParcelProfile } from '../../shipping/application/measured-demo-parcel-profile';
import {
  ShippingQuoteOrchestrator,
  type ShippingQuoteOrchestrationUnavailableReason,
  type ShippingQuoteOrchestrationHandoffReason,
} from '../../shipping/application/shipping-quote-orchestrator';
import {
  SHIPPING_QUOTE_PROVIDER,
  type ShippingQuoteProviderPort,
} from '../../shipping/domain/shipping-quote.port';
import {
  evaluateMinimalOrder,
  type MinimalOrderIneligibleReason,
} from '../domain/minimal-order-confirmation';
import {
  buildMinimalShipping,
  classifyMinimalShipping,
} from '../domain/minimal-shipping';
import { MinimalCartService, parseMinimalCart } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';

export type MinimalShippingRefusal =
  | MinimalOrderIneligibleReason
  | ShippingQuoteOrchestrationUnavailableReason
  | ShippingQuoteOrchestrationHandoffReason
  | 'order_unresolved'
  | 'cart_changed'
  | 'address_changed'
  | 'address_unverified'
  | 'unsupported_destination'
  | 'measurements_unavailable'
  | 'manual_packing_required'
  | 'quote_expired';
export type MinimalShippingResult =
  | { kind: 'quoted'; classification: 'free' | 'charged' }
  | { kind: 'refused'; reason: MinimalShippingRefusal };
const refuse = (reason: MinimalShippingRefusal): MinimalShippingResult => ({
  kind: 'refused',
  reason,
});

/** Internal quote only. T4 owns handoff/disclosure; this service returns no money.
 * Not registered or activated here (T7). Uses only the measured legacy profile;
 * arbitrary carts cannot be packed by inference. One provider call, one cart CAS.
 */
@Injectable()
export class MinimalShippingService {
  private readonly orchestrator: ShippingQuoteOrchestrator;

  constructor(
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    private readonly cart: MinimalCartService,
    private readonly checkout: MinimalCheckoutService,
    @Inject(SHIPPING_QUOTE_PROVIDER) provider: ShippingQuoteProviderPort,
    @Inject(MEASURED_DEMO_SHIPPING_CONFIG)
    private readonly measured: MeasuredDemoShippingConfig | null,
  ) {
    this.orchestrator = new ShippingQuoteOrchestrator(provider);
  }

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
      if (!eligibility.ok) return refuse(eligibility.reason);
      if (!quote.ok || draft === null || draft.address.kind !== 'saved')
        return refuse('cart_unverified');
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
      if (this.measured === null) return refuse('measurements_unavailable');
      const prepared = matchMeasuredDemoParcelProfile(
        this.measured.profile,
        quote.items,
      );
      if (prepared === null) return refuse('measurements_unavailable');
      const address = draft.address.snapshot;
      const createdAt = new Date().toISOString();
      const outcome = await this.orchestrator.quote({
        requestInput: {
          origin: this.measured.origin,
          destination: {
            zipCode: address.zipCode,
            state: address.state,
            municipality: address.municipality ?? address.city,
            neighborhood: address.neighborhood,
          },
          items: prepared.items,
          parcels: prepared.parcels,
        },
      });
      if (outcome.kind !== 'draft')
        return refuse(
          outcome.reason === 'invalid_destination'
            ? 'unsupported_destination'
            : outcome.reason,
        );
      const shipping = buildMinimalShipping({
        quote: {
          kind: 'quoted',
          quoteId: outcome.draft.quoteId,
          rates: [outcome.draft.selectedRate],
          expiresAt: outcome.draft.providerExpiresAt,
        },
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
        addressId: address.id,
        addressVersion: address.version,
        createdAt,
      });
      if (shipping === null || Date.now() >= Date.parse(shipping.expiresAt))
        return refuse('quote_expired');
      // Delivery is a separate slot: reject changes during provider latency.
      if (
        !isDeepStrictEqual(draft, await this.checkout.confirmedDraft(senderId))
      )
        return refuse('address_changed');
      const next = structuredClone({ ...stored, shipping });
      const committed = await this.store.commitMinimalCart(
        senderId,
        raw,
        next,
        new Date().toISOString(),
      );
      return committed
        ? { kind: 'quoted', classification: classifyMinimalShipping(shipping) }
        : refuse('cart_changed');
    } catch {
      return refuse('cart_unverified');
    }
  }
}
