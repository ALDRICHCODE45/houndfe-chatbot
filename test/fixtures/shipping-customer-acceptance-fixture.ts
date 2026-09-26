/**
 * SCA-2a test-only shared builder for the committed exact SCA-1a1
 * `shippingCustomerOffer` + `shippingCustomerAcceptance` marker pair.
 *
 * Offline: plain object literals only — no store, network, clock or provider.
 * Defaults pin the measured 60_000 merchandise + 6_900 freight charge on the
 * shared 12:00 draft/approval pin, with a realistically ordered 12:06 offer and
 * 12:07 acceptance (after the 12:05 revalidation approval `decidedAt`) inside
 * the 12:30 draft window. Charged pure-spec cases override the merchandise
 * total (and, when needed, the charge/pin/window) so the pair matches their
 * cart.
 */
import {
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY,
} from '../../src/shipping/application/shipping-customer-acceptance';

const DEFAULTS = {
  requestId: 'abcdef123456',
  draftCreatedAt: '2026-06-23T12:00:00.000Z',
  offeredAt: '2026-06-23T12:06:00.000Z',
  expiresAt: '2026-06-23T12:30:00.000Z',
  acceptedAt: '2026-06-23T12:07:00.000Z',
  merchandiseCents: 60_000,
  chargeCents: 6_900,
  providerMessageId: 'wamid.HBgLc2NhLW9mZmVyPQ==',
  inboundMessageId: 'wamid.HBgLc2NhLXllcz0=',
};

/** Caller overrides for the charged pure-spec cases and boundary amounts. */
export type ShippingAcceptanceOverrides = Partial<typeof DEFAULTS>;

/** The exact committed `shippingCustomerOffer` marker shape. */
export function shippingCustomerOffer(
  over: ShippingAcceptanceOverrides = {},
): Record<string, unknown> {
  const v = { ...DEFAULTS, ...over };
  return {
    schemaVersion: 1,
    requestId: v.requestId,
    draftCreatedAt: v.draftCreatedAt,
    offeredAt: v.offeredAt,
    expiresAt: v.expiresAt,
    merchandiseCents: v.merchandiseCents,
    chargeCents: v.chargeCents,
    expectedTotalCents: v.merchandiseCents + v.chargeCents,
    providerMessageId: v.providerMessageId,
  };
}

/** The exact committed `shippingCustomerAcceptance` marker shape. */
export function shippingCustomerAcceptance(
  over: ShippingAcceptanceOverrides = {},
): Record<string, unknown> {
  const v = { ...DEFAULTS, ...over };
  return {
    schemaVersion: 1,
    requestId: v.requestId,
    draftCreatedAt: v.draftCreatedAt,
    merchandiseCents: v.merchandiseCents,
    chargeCents: v.chargeCents,
    expectedTotalCents: v.merchandiseCents + v.chargeCents,
    acceptedAt: v.acceptedAt,
    inboundMessageId: v.inboundMessageId,
  };
}

/** Both committed marker keys, ready to spread into a persisted data bag. */
export function shippingAcceptancePair(
  over: ShippingAcceptanceOverrides = {},
): Record<string, unknown> {
  return {
    [SHIPPING_CUSTOMER_OFFER_KEY]: shippingCustomerOffer(over),
    [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: shippingCustomerAcceptance(over),
  };
}
