import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CheckoutContextAddress } from '../../chatbot-api/domain/dtos/checkout-context.dto';
import {
  PACKAGING_DATA_MISSING,
  SHIPPING_QUOTE_UNAVAILABLE,
  type ShippingQuoteResponse,
} from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { MinimalCartService, parseMinimalCart } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalShippingService } from './minimal-shipping.service';
import { minimalShippingDestination } from '../domain/minimal-shipping';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const EXPIRES = '2026-11-05T12:30:00.000Z';
const event = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});
const address: CheckoutContextAddress = {
  id: ADDRESS,
  version: '2026-06-22T00:00:00.000Z',
  label: 'Casa',
  street: 'Juárez',
  exteriorNumber: '10',
  interiorNumber: null,
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: null,
  city: 'Cuauhtémoc',
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
};
const backendQuote = (
  overrides: Partial<ShippingQuoteResponse> = {},
): ShippingQuoteResponse => ({
  quoteId: 'quote-1',
  expiresAt: EXPIRES,
  zoneStatus: 'CARRIER_ONLY',
  option: { carrier: 'Skydropx', service: 'Ground', etaDays: 3 },
  costCents: 20000,
  creditCents: 0,
  customerChargeCents: 20000,
  currency: 'MXN',
  ...overrides,
});

// prettier-ignore
async function setup(price = 1500) {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async () => [{ productId: PRODUCT, name: 'Producto', price: { priceCents: price }, variants: [] }]),
    getStock: jest.fn(async () => ({ productId: PRODUCT, name: 'Producto', stock: { status: 'available', quantity: 10 }, variants: [] })),
    evaluateCart: jest.fn(async (items: Array<{ quantity: number }>) => ({
      items: items.map(item => ({ productId: PRODUCT, variantId: null, quantity: item.quantity,
        unitPriceCents: price, originalPriceCents: price * item.quantity, finalPriceCents: price * item.quantity,
        discountAmountCents: 0, appliedPromotionTitle: null })), promotionEvaluationStatus: 'fully_evaluated',
    })),
    getCustomerCheckoutContext: jest.fn(async () => ({ status: 'unique', customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null }, addresses: [address], nextAfterAddressId: null })),
  };
  const client = api as unknown as ChatbotApiClient;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const quotes = new FakeShippingQuoteClient();
  const service = new MinimalShippingService(store, cart, checkout, quotes, () => NOW);
  await store.create(SENDER, { lastMessageAt: new Date().toISOString(), data: {
    minimalCart: { items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: price }], idempotencyKey: '', expectedTotalCents: price * 2 },
    legacy: { untouched: true },
  } });
  const confirm = async () => {
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
    const offer = await checkout.prepareConfirmation(SENDER, event('d1'));
    offer.onSent?.();
    await checkout.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: event('d2') });
  };
  const changeCart = async (patch: Record<string, unknown>) => {
    const state = (await store.get(SENDER))!;
    const ok = await store.commitMinimalCart(SENDER, state.data.minimalCart, { ...(state.data.minimalCart as object), ...patch }, new Date().toISOString());
    if (!ok) throw new Error('fixture CAS failed');
  };
  const stored = async () => parseMinimalCart((await store.get(SENDER))?.data.minimalCart)!.shipping;
  return { store, api, cart, checkout, quotes, service, confirm, changeCart, stored };
}

// prettier-ignore
describe('MinimalShippingService (U3: backend-signed quote)', () => {
  it('[S1,S3] one createShippingQuote call for a saved address; stores and returns the backend amounts', async () => {
    const h = await setup(); await h.confirm();
    h.quotes.enqueue(backendQuote({ costCents: 30000, creditCents: 24000, customerChargeCents: 6000 }));
    expect(await h.service.quote(SENDER)).toEqual({
      kind: 'quoted', zoneStatus: 'CARRIER_ONLY', costCents: 30000, creditCents: 24000, customerChargeCents: 6000,
      option: { carrier: 'Skydropx', service: 'Ground', etaDays: 3 }, eta: null, zipCode: '06000',
    });
    expect(h.quotes.calls).toEqual([{
      items: [{ productId: PRODUCT, quantity: 2 }],
      phoneCountryCode: '52', phone: '5550001111',
      destination: { shippingAddressId: ADDRESS },
    }]);
    const data = (await h.store.get(SENDER))!.data;
    expect(data.legacy).toEqual({ untouched: true });
    expect(data).not.toHaveProperty('pendingHumanRequest');
    expect(await h.stored()).toEqual({
      quoteId: 'quote-1', expiresAt: EXPIRES, zoneStatus: 'CARRIER_ONLY',
      option: { carrier: 'Skydropx', service: 'Ground', etaDays: 3 },
      costCents: 30000, creditCents: 24000, customerChargeCents: 6000, currency: 'MXN', eta: null,
      destinationPin: { kind: 'saved', addressId: ADDRESS, version: address.version },
      cartPin: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500, finalPriceCents: 3000 }],
    });
  });

  it.each([
    ['FREE', { kind: 'quoted' }],
    ['SURCHARGE', { kind: 'quoted' }],
    ['CARRIER_ONLY', { kind: 'quoted' }],
    ['PENDING', { kind: 'zone_pending', zipCode: '06000' }],
    ['DENIED', { kind: 'zone_denied', zipCode: '06000' }],
  ] as const)('stores the %s quote and returns its kind', async (zoneStatus, expected) => {
    const h = await setup(); await h.confirm();
    const deliverable = zoneStatus !== 'PENDING' && zoneStatus !== 'DENIED';
    h.quotes.enqueue(backendQuote({ zoneStatus, ...(deliverable ? {} : { quoteId: null, option: null }) }));
    expect(await h.service.quote(SENDER)).toMatchObject(expected);
    expect(await h.stored()).toMatchObject({ zoneStatus, quoteId: deliverable ? 'quote-1' : null });
  });

  it('[S7] keeps the STOCK_PENDING eta in the stored quote and the result', async () => {
    const h = await setup(); await h.confirm();
    h.quotes.enqueue(backendQuote({ eta: { days: null, reason: 'STOCK_PENDING' } }));
    expect(await h.service.quote(SENDER)).toMatchObject({ kind: 'quoted', eta: { days: null, reason: 'STOCK_PENDING' } });
    expect(await h.stored()).toMatchObject({ eta: { days: null, reason: 'STOCK_PENDING' } });
  });

  it.each([
    [PACKAGING_DATA_MISSING, 'packaging_missing'],
    [SHIPPING_QUOTE_UNAVAILABLE, 'unavailable'],
    ['SOMETHING_ELSE', 'unavailable'],
  ] as const)('%s → %s without persistence', async (code, kind) => {
    const h = await setup(); await h.confirm();
    h.quotes.enqueue(new ChatbotApiError('quote', 422, {}, code));
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind });
    expect(commit).not.toHaveBeenCalled();
  });

  it('an already expired backend quote is unavailable and not stored', async () => {
    const h = await setup(); await h.confirm();
    h.quotes.enqueue(backendQuote({ expiresAt: new Date(NOW).toISOString() }));
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'unavailable' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('[S2] a requote replaces the stored quote', async () => {
    const h = await setup(); await h.confirm();
    h.quotes.enqueue(backendQuote()).enqueue(backendQuote({ quoteId: 'quote-2', customerChargeCents: 1000 }));
    await h.service.quote(SENDER);
    await h.service.quote(SENDER);
    expect(await h.stored()).toMatchObject({ quoteId: 'quote-2', customerChargeCents: 1000 });
  });

  it('sends the confirmed NEW address as loose fields', async () => {
    const h = await setup(); await h.confirm();
    await h.checkout.updateDetails(SENDER, { ...address, firstName: null, lastName: null, useNewAddress: true });
    const offer = await h.checkout.prepareConfirmation(SENDER, event('n1')); offer.onSent?.();
    await h.checkout.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: event('n2') });
    expect((await h.checkout.confirmedDraft(SENDER))?.address.kind).toBe('new');
    h.quotes.enqueue(backendQuote());
    expect(await h.service.quote(SENDER)).toMatchObject({ kind: 'quoted' });
    expect(h.quotes.calls[0].destination).toEqual({
      street: 'Juárez', exteriorNumber: '10', zipCode: '06000', neighborhood: 'Centro',
      municipality: 'Cuauhtémoc', city: 'Cuauhtémoc', state: 'Ciudad de México',
    });
    expect(await h.stored()).toMatchObject({ destinationPin: { kind: 'new' } });
  });

  it('sends the corrected saved ZIP as loose fields and pins the corrected content', async () => {
    const h = await setup(); await h.confirm();
    await h.checkout.updateDetails(SENDER, {
      label: null, street: null, exteriorNumber: null, interiorNumber: null,
      zipCode: '55635', neighborhood: null, municipality: null, city: null,
      state: null, visualReferences: null, carrierPhone: null,
      firstName: null, lastName: null, useNewAddress: false,
    });
    const offer = await h.checkout.prepareConfirmation(SENDER, event('c1')); offer.onSent?.();
    await h.checkout.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: event('c2') });
    expect((await h.checkout.confirmedDraft(SENDER))?.address.kind).toBe('savedCorrected');
    h.quotes.enqueue(backendQuote());
    await h.service.quote(SENDER);
    expect(h.quotes.calls[0].destination).toMatchObject({ zipCode: '55635' });
    expect(h.quotes.calls[0].destination).not.toHaveProperty('shippingAddressId');
    const { id: _id, version: _version, ...fields } = address; void _id; void _version;
    expect(await h.stored()).toMatchObject({ destinationPin: minimalShippingDestination({ kind: 'new', fields: { ...fields, zipCode: '55635' } }) });
  });

  it('refuses unconfirmed delivery without calling the backend', async () => {
    const h = await setup();
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'delivery_unconfirmed' });
    expect(h.quotes.calls).toHaveLength(0);
  });

  it('refuses an incomplete destination without calling the backend', async () => {
    const h = await setup(); await h.confirm();
    const draft = (await h.checkout.confirmedDraft(SENDER))!;
    jest.spyOn(h.checkout, 'confirmedDraft').mockResolvedValue({ ...draft, address: { kind: 'new', fields: { ...address, label: null, zipCode: null } } });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'unsupported_destination' });
    expect(h.quotes.calls).toHaveLength(0);
  });

  it('refuses an outstanding uncertain-order lock', async () => {
    const h = await setup(); await h.confirm();
    await h.changeCart({ idempotencyKey: CUSTOMER });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'order_unresolved' });
    expect(h.quotes.calls).toHaveLength(0);
  });

  it('refuses fresh price drift before quoting', async () => {
    const h = await setup(); await h.confirm(); await h.changeCart({ items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1499 }] });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    expect(h.quotes.calls).toHaveLength(0);
  });

  it('CAS rejects a concurrent cart edit during the backend call', async () => {
    const h = await setup(); await h.confirm();
    jest.spyOn(h.quotes, 'createShippingQuote').mockImplementationOnce(async () => { await h.changeCart({ expectedTotalCents: 1 }); return backendQuote(); });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
  });

  it('rejects a delivery change during the backend call', async () => {
    const h = await setup(); await h.confirm();
    jest.spyOn(h.quotes, 'createShippingQuote').mockImplementationOnce(async () => {
      await h.checkout.updateDetails(SENDER, { ...address, firstName: 'Changed', lastName: null, useNewAddress: true });
      return backendQuote();
    });
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'address_changed' });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(['reselect', 'unavailable'] as const)('refuses saved address revalidation %s', async result => {
    const h = await setup(); await h.confirm();
    jest.spyOn(h.checkout, 'revalidateSelection').mockResolvedValue(result);
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: result === 'reselect' ? 'address_changed' : 'address_unverified' });
    expect(h.quotes.calls).toHaveLength(0);
  });

  it.each(['empty_cart', 'promotion_review', 'cart_unverified'] as const)('refuses %s', async reason => {
    const h = await setup(); await h.confirm();
    if (reason === 'empty_cart') await h.changeCart({ items: [] });
    if (reason === 'promotion_review') h.api.evaluateCart.mockResolvedValueOnce({ items: [{ productId: PRODUCT, variantId: null, quantity: 2, unitPriceCents: 1500, originalPriceCents: 3000, finalPriceCents: 3000, discountAmountCents: 0, appliedPromotionTitle: null }], promotionEvaluationStatus: 'needs_human_review' });
    if (reason === 'cart_unverified') h.api.getStock.mockRejectedValueOnce(new Error('offline'));
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason });
    expect(h.quotes.calls).toHaveLength(0);
  });
});

// prettier-ignore
describe('MinimalShippingService.chooseStorePickup (U4, S4)', () => {
  const pin = [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500, finalPriceCents: 3000 }];
  it('[S4] stores a pickup choice pinned to the verified cart without calling the quote backend', async () => {
    const h = await setup();
    expect(await h.service.chooseStorePickup(SENDER)).toEqual({ kind: 'pickup' });
    expect(await h.stored()).toEqual({ mode: 'pickup', cartPin: pin });
    expect(h.quotes.calls).toHaveLength(0);
    expect((await h.store.get(SENDER))!.data.legacy).toEqual({ untouched: true });
  });
  it('[S4,S5] replaces a DENIED or PENDING zone answer', async () => {
    const h = await setup(); await h.confirm();
    h.quotes.enqueue(backendQuote({ zoneStatus: 'DENIED', quoteId: null, option: null }));
    await h.service.quote(SENDER);
    expect(await h.service.chooseStorePickup(SENDER)).toEqual({ kind: 'pickup' });
    expect(await h.stored()).toEqual({ mode: 'pickup', cartPin: pin });
  });
  it('[S4] a cart change drops the pickup choice', async () => {
    const h = await setup();
    await h.service.chooseStorePickup(SENDER);
    const changed = await h.cart.setItem(SENDER, { productId: PRODUCT, quantity: 3 }, new Set([PRODUCT]));
    expect(changed.ok).toBe(true);
    expect(await h.stored()).toBeUndefined();
  });
  it('refuses an outstanding uncertain-order lock', async () => {
    const h = await setup();
    await h.changeCart({ idempotencyKey: CUSTOMER });
    expect(await h.service.chooseStorePickup(SENDER)).toEqual({ kind: 'refused', reason: 'order_unresolved' });
  });
  it('refuses fresh price drift and an empty cart', async () => {
    const h = await setup();
    await h.changeCart({ items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1499 }] });
    expect(await h.service.chooseStorePickup(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    await h.changeCart({ items: [], expectedTotalCents: 0 });
    expect(await h.service.chooseStorePickup(SENDER)).toEqual({ kind: 'refused', reason: 'empty_cart' });
    expect(await h.stored()).toBeUndefined();
  });
  it('CAS rejects a concurrent cart edit while verifying prices', async () => {
    const h = await setup();
    h.api.evaluateCart.mockImplementationOnce(async (items: Array<{ quantity: number }>) => {
      await h.changeCart({ expectedTotalCents: 1 });
      return { items: items.map(item => ({ productId: PRODUCT, variantId: null, quantity: item.quantity, unitPriceCents: 1500, originalPriceCents: 1500 * item.quantity, finalPriceCents: 1500 * item.quantity, discountAmountCents: 0, appliedPromotionTitle: null })), promotionEvaluationStatus: 'fully_evaluated' };
    });
    expect(await h.service.chooseStorePickup(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    expect(await h.stored()).toBeUndefined();
  });
});
