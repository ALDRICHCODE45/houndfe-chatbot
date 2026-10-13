import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CheckoutContextAddress } from '../../chatbot-api/domain/dtos/checkout-context.dto';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { MeasuredDemoShippingConfig } from '../../shipping/application/measured-demo-shipping-config';
import type { ShippingQuoteProviderResult } from '../../shipping/domain/shipping-quote.port';
import type { ShippingQuoteRequest } from '../../shipping/domain/shipping-quote.request';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalShippingService } from './minimal-shipping.service';

const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
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
const config: MeasuredDemoShippingConfig = {
  origin: {
    postalCode: '06000',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Centro',
  },
  profile: {
    version: 1,
    items: [
      {
        productId: PRODUCT,
        variantId: null,
        quantity: 2,
        measurement: {
          weightGrams: 100,
          lengthCm: 10,
          widthCm: 10,
          heightCm: 10,
        },
      },
    ],
    parcel: { weightGrams: 200, lengthCm: 20, widthCm: 20, heightCm: 20 },
  },
};
const quoted: ShippingQuoteProviderResult = {
  kind: 'quoted',
  quoteId: 'q1',
  expiresAt: null,
  rates: [
    {
      rateId: 'r1',
      carrierName: 'Carrier',
      serviceName: 'Ground',
      priceCents: 20000,
      currency: 'MXN',
      estimatedDeliveryDays: 3,
      validUntil: null,
    },
  ],
};
// prettier-ignore
async function setup(price = 1500, measured: MeasuredDemoShippingConfig | null = config) {
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
  const provider = { quote: jest.fn((request: ShippingQuoteRequest): Promise<ShippingQuoteProviderResult> => { void request; return Promise.resolve(quoted); }) };
  const handoff = { create: jest.fn(async () => {
    const date = new Date().toISOString();
    await store.setPendingHumanRequest(SENDER, { requestId: 'abcdef123456', ref: 'HF-abcdef123456', createdAt: date, customerNotifiedAt: date }, date);
    return { ok: true as const, requestId: 'abcdef123456', ref: 'HF-abcdef123456', customerNotified: true as const };
  }) };
  const service = new MinimalShippingService(store, cart, checkout, provider, measured, handoff);
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
  return { store, api, cart, checkout, provider, service, handoff, confirm, changeCart };
}

// prettier-ignore
describe('MinimalShippingService (T3)', () => {
  it('[S1,S2,S4] successful quote connects to human approval without returning money', async () => {
    const h = await setup(50001); await h.confirm();
    const handoff = { create: jest.fn(async () => ({ ok: true as const, requestId: 'abcdef123456', ref: 'HF-abcdef123456', customerNotified: true as const })) };
    const service = new MinimalShippingService(h.store, h.cart, h.checkout, h.provider, config, handoff);
    expect(await service.quote(SENDER)).toEqual({ kind: 'quoted', classification: 'free' });
    expect(handoff.create).toHaveBeenCalledTimes(1);
    expect((await h.store.get(SENDER))!.data.minimalCart).toMatchObject({ shipping: { approval: { state: 'pending', requestId: 'abcdef123456' } } });
  });
  it.each([[1500, 'charged', 20000], [50001, 'free', 0]] as const)('[S1,S2,S5,S6] quotes %s with pending approval and no money disclosure', async (price, classification, customerPaysCents) => {
    const h = await setup(price); await h.confirm();
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'quoted', classification });
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
    expect(h.provider.quote.mock.calls[0]?.[0]).toEqual({
      origin: { countryCode: 'MX', ...config.origin },
      destination: { countryCode: 'MX', postalCode: '06000', state: address.state, municipality: address.city, neighborhood: address.neighborhood },
      parcels: [config.profile.parcel],
    });
    expect(commit).toHaveBeenCalledTimes(2);
    const data = (await h.store.get(SENDER))!.data;
    expect(data.minimalCart).toMatchObject({ shipping: { customerPaysCents, approval: { state: 'pending', requestId: 'abcdef123456' } } });
    expect(data.legacy).toEqual({ untouched: true });
    expect(data.pendingHumanRequest).toMatchObject({ requestId: 'abcdef123456' });
    expect(data).not.toHaveProperty('shippingApproval');
  });
  it('[S4] supplies the identical raw stored value as CAS expectation', async () => {
    const h = await setup(); await h.confirm();
    const get = jest.spyOn(h.store, 'get'); const commit = jest.spyOn(h.store, 'commitMinimalCart');
    await h.service.quote(SENDER);
    const first = await get.mock.results[0].value as Awaited<ReturnType<typeof h.store.get>>;
    expect(commit.mock.calls[0][1]).toBe(first!.data.minimalCart);
  });
  it('[S4] refuses fresh price drift', async () => {
    const h = await setup(); await h.confirm(); await h.changeCart({ items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1499 }] });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S1,S6] refuses expired provider quote without persistence', async () => {
    const h = await setup(); await h.confirm();
    if (quoted.kind !== 'quoted') throw new Error('fixture');
    h.provider.quote.mockResolvedValueOnce({ ...quoted, expiresAt: '2020-01-01T00:00:00.000Z' });
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'quote_expired' });
    expect(commit).not.toHaveBeenCalled();
  });
  it('[S4] rejects delivery drift during provider latency', async () => {
    const h = await setup(); await h.confirm();
    h.provider.quote.mockImplementationOnce(async () => {
      await h.checkout.updateDetails(SENDER, { ...address, firstName: 'Changed', lastName: null, useNewAddress: true });
      return quoted;
    });
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'address_changed' });
    expect(commit).not.toHaveBeenCalled();
  });
  it('[S1,S5] refuses a mismatched measured profile', async () => {
    const h = await setup(1500, { ...config, profile: { ...config.profile, items: [{ ...config.profile.items[0], productId: CUSTOMER }] } }); await h.confirm();
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'measurements_unavailable' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S1] refuses unconfirmed delivery', async () => {
    const h = await setup();
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'delivery_unconfirmed' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S1] refuses a confirmed new address', async () => {
    const h = await setup(); await h.confirm();
    await h.checkout.updateDetails(SENDER, { ...address, firstName: null, lastName: null, useNewAddress: true });
    const offer = await h.checkout.prepareConfirmation(SENDER, event('n1')); offer.onSent?.();
    await h.checkout.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: event('n2') });
    expect((await h.checkout.confirmedDraft(SENDER))?.address.kind).toBe('new');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'new_address_unsupported' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S4] refuses outstanding uncertain-order lock', async () => {
    const h = await setup(); await h.confirm();
    await h.changeCart({ idempotencyKey: CUSTOMER });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'order_unresolved' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it.each(['provider_failure', 'no_rates'] as const)('[S1,S5] fails closed on %s', async reason => {
    const h = await setup(); await h.confirm();
    if (reason === 'provider_failure') h.provider.quote.mockRejectedValueOnce(new Error('secret'));
    else h.provider.quote.mockResolvedValueOnce({ kind: 'error', error: { kind: 'no_rates' } });
    const commit = jest.spyOn(h.store, 'commitMinimalCart');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason });
    expect(commit).not.toHaveBeenCalled();
  });
  it('[S4] CAS false never retries or requotes', async () => {
    const h = await setup(); await h.confirm();
    const commit = jest.spyOn(h.store, 'commitMinimalCart').mockResolvedValue(false);
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    expect(commit).toHaveBeenCalledTimes(1); expect(h.provider.quote).toHaveBeenCalledTimes(1);
  });
  it('[S4] rejects cart drift before provider call', async () => {
    const h = await setup(); await h.confirm();
    const view = h.cart.view.bind(h.cart);
    jest.spyOn(h.cart, 'view').mockImplementationOnce(async sender => {
      const quote = await view(sender); await h.changeCart({ items: [{ productId: PRODUCT, quantity: 1, unitPriceCents: 1500 }] }); return quote;
    });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S4] CAS rejects a concurrent edit during provider call', async () => {
    const h = await setup(); await h.confirm();
    h.provider.quote.mockImplementationOnce(async () => { await h.changeCart({ expectedTotalCents: 1 }); return quoted; });
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'cart_changed' });
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
  });
  it.each(['empty_cart', 'promotion_review', 'cart_unverified'] as const)('[S1,S4] refuses %s', async reason => {
    const h = await setup(); await h.confirm();
    if (reason === 'empty_cart') await h.changeCart({ items: [] });
    if (reason === 'promotion_review') h.api.evaluateCart.mockResolvedValueOnce({ items: [{ productId: PRODUCT, variantId: null, quantity: 2, unitPriceCents: 1500, originalPriceCents: 3000, finalPriceCents: 3000, discountAmountCents: 0, appliedPromotionTitle: null }], promotionEvaluationStatus: 'needs_human_review' });
    if (reason === 'cart_unverified') h.api.getStock.mockRejectedValueOnce(new Error('offline'));
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S1] refuses unsupported destination without provider call', async () => {
    const h = await setup(); await h.confirm();
    const draft = (await h.checkout.confirmedDraft(SENDER))!;
    jest.spyOn(h.checkout, 'confirmedDraft').mockResolvedValue({ ...draft, address: { kind: 'saved', snapshot: { ...address, zipCode: null } } });
    jest.spyOn(h.checkout, 'revalidateSelection').mockResolvedValue('ok');
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'unsupported_destination' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it('[S1,S5] requires the exact measured profile', async () => {
    const h = await setup(1500, null); await h.confirm();
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: 'measurements_unavailable' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
  it.each(['reselect', 'unavailable'] as const)('[S4] refuses saved address revalidation %s', async result => {
    const h = await setup(); await h.confirm();
    jest.spyOn(h.checkout, 'revalidateSelection').mockResolvedValue(result);
    expect(await h.service.quote(SENDER)).toEqual({ kind: 'refused', reason: result === 'reselect' ? 'address_changed' : 'address_unverified' });
    expect(h.provider.quote).not.toHaveBeenCalled();
  });
});
