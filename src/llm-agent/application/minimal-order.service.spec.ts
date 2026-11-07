import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  CreateCheckoutInputSchema,
  INVALID_CHECKOUT_REQUEST,
  SHIPPING_QUOTE_ALREADY_USED,
} from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  PACKAGING_DATA_MISSING,
  SHIPPING_QUOTE_EXPIRED,
  SHIPPING_QUOTE_MISMATCH,
  SHIPPING_QUOTE_NOT_FOUND,
  SHIPPING_QUOTE_UNAVAILABLE,
} from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { MinimalShippingService } from './minimal-shipping.service';
import {
  minimalShippingDestination,
  type MinimalShippingQuote,
} from '../domain/minimal-shipping';
import { parseMinimalCart } from './minimal-cart.service';
import type { ConfigService } from '@nestjs/config';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  CheckoutContextAddress,
  CustomerCheckoutContext,
} from '../../chatbot-api/domain/dtos/checkout-context.dto';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import {
  MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
  MINIMAL_ORDER_CHANGED_REPLY,
  MINIMAL_ORDER_HELD_REPLY,
  MINIMAL_ORDER_INELIGIBLE_REPLIES,
  MINIMAL_ORDER_REJECTED_REPLY,
  MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_UNRESOLVED_REPLY,
  MINIMAL_ORDER_VARIANT_CHANGED_REPLY,
  MINIMAL_ORDER_STOCK_CHANGED_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
  MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY,
  MINIMAL_ORDER_SHIPPING_QUOTE_NOT_FOUND_REPLY,
  MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY,
  MINIMAL_ORDER_PACKAGING_MISSING_REPLY,
  MINIMAL_ORDER_PICKUP_NAME_REQUIRED_REPLY,
  MINIMAL_ORDER_PICKUP_CUSTOMER_UNAVAILABLE_REPLY,
  MINIMAL_ORDER_CUSTOMER_RECHECK_REPLY,
  MinimalOrderService,
} from './minimal-order.service';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_DECLINED_REPLY,
} from '../domain/minimal-order-confirmation';
import { MINIMAL_CHECKOUT_RESELECT_REPLY } from './minimal-checkout.service';

const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SALE = '55555555-5555-4555-8555-555555555555';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const savedAddress = (
  overrides: Partial<CheckoutContextAddress> = {},
): CheckoutContextAddress => ({
  id: ADDRESS,
  version: '2026-10-01T00:00:00.000Z',
  label: 'Casa',
  street: 'Av. Juárez',
  exteriorNumber: '10',
  interiorNumber: null,
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: 'Cuauhtémoc',
  city: null,
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
  ...overrides,
});
const unique = (address = savedAddress()): CustomerCheckoutContext => ({
  status: 'unique',
  customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
  addresses: [address],
  nextAfterAddressId: null,
});

const placedSale = () => ({
  saleId: SALE,
  folio: 'B-0042',
  paymentStatus: 'CREDIT',
  channel: 'ONLINE',
  deliveryStatus: 'PENDING',
  totalCents: 3000,
  paidCents: 0,
  debtCents: 3000,
  confirmedAt: '2026-10-13T00:00:00.000Z',
  discountCents: 0,
});

function setup(
  options: {
    cashier?: string;
    /** Delivery-quote tests; every other test seeds store pickup (S9). */
    shipping?: boolean;
    now?: () => number;
  } = {},
) {
  const store = new InMemoryConversationStore();
  let unitPrice = 1500;
  const api = {
    searchCatalog: jest.fn(() =>
      Promise.resolve([
        {
          productId: PRODUCT,
          name: 'Ibuprofeno',
          price: { priceCents: unitPrice },
          variants: [],
        },
      ]),
    ),
    getStock: jest.fn(() =>
      Promise.resolve({
        productId: PRODUCT,
        name: 'Ibuprofeno',
        stock: { status: 'available', quantity: 10 },
        variants: [],
      }),
    ),
    evaluateCart: jest.fn((items: Array<{ quantity: number }>) =>
      Promise.resolve({
        items: items.map((item) => ({
          productId: PRODUCT,
          variantId: null,
          quantity: item.quantity,
          unitPriceCents: unitPrice,
          originalPriceCents: unitPrice * item.quantity,
          finalPriceCents: unitPrice * item.quantity,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }),
    ),
    getCustomerCheckoutContext: jest.fn(() => Promise.resolve(unique())),
    // The legacy POST /sales path is gone; it must never be called.
    createSale: jest.fn(),
    createCheckout: jest.fn(),
    getCheckoutStatus: jest.fn(),
    getPaymentDetails: jest.fn(() =>
      Promise.resolve({
        id: 'pd',
        bankName: 'BBVA',
        beneficiary: 'HoundFe SA de CV',
        clabe: '012180001234567891',
        accountNumber: '0123456789',
        isActive: true,
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    ),
    upsertCustomer: jest.fn(),
    cancelSale: jest.fn(),
    updateDelivery: jest.fn(),
  };
  api.createCheckout.mockImplementation(() =>
    Promise.resolve({ status: 'created', sale: placedSale() }),
  );
  api.getCheckoutStatus.mockResolvedValue({
    status: 'not_observed',
    checkout: null,
  });
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) => {
      if (key === 'chatbotApi.cashierUserId') return options.cashier ?? CASHIER;
      return undefined;
    },
  } as unknown as ConfigService;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const quotes = new FakeShippingQuoteClient();
  const shipping = new MinimalShippingService(store, cart, checkout, quotes, {
    register: async () => undefined,
  });
  const order = new MinimalOrderService(
    client,
    store,
    cart,
    checkout,
    config,
    shipping,
    options.now,
  );
  return {
    store,
    api,
    cart,
    checkout,
    order,
    quotes,
    shipping,
    setPrice: (cents: number) => {
      unitPrice = cents;
    },
    seedCart: (quantity = 2) =>
      store.create(SENDER, {
        lastMessageAt: '2026-10-10T00:00:00.000Z',
        data: {
          minimalCart: {
            items: [{ productId: PRODUCT, quantity, unitPriceCents: 1500 }],
            idempotencyKey: '',
            expectedTotalCents: 1500 * quantity,
            ...(options.shipping === true
              ? {}
              : {
                  shipping: {
                    mode: 'pickup',
                    cartPin: [
                      {
                        productId: PRODUCT,
                        quantity,
                        unitPriceCents: 1500,
                        finalPriceCents: 1500 * quantity,
                      },
                    ],
                  },
                }),
          },
          cart: { legacy: 'preserved' },
        },
      }),
    minimalCart: async () => (await store.get(SENDER))?.data.minimalCart,
  };
}

type Harness = ReturnType<typeof setup>;

async function confirmSavedDelivery(h: Harness) {
  const lookup = await h.checkout.lookup(SENDER, null);
  if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
  await h.checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
  const offer = await h.checkout.prepareConfirmation(SENDER, EVENT('wamid.d1'));
  offer.onSent?.();
  const confirmed = await h.checkout.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('wamid.d2'),
  });
  if (confirmed === null) throw new Error('delivery not confirmed');
}

async function offerOrder(h: Harness, id = 'wamid.o1') {
  const offer = await h.order.prepareOrder(SENDER, EVENT(id));
  offer.onSent?.();
  return offer;
}

const yes = (h: Harness, id = 'wamid.o2') =>
  h.order.consume({ senderId: SENDER, text: 'SÍ', inboundEvent: EVENT(id) });

/** Stores a backend-signed quote pinned to the current cart and saved address. */
async function shippingRecord(
  h: Harness,
  overrides: Partial<MinimalShippingQuote> = {},
) {
  const raw = await h.minimalCart();
  const cart = raw as { items: MinimalShippingQuote['cartPin'] };
  const shipping: MinimalShippingQuote = {
    quoteId: 'quote-1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    zoneStatus: 'CARRIER_ONLY',
    option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
    costCents: 5000,
    creditCents: 0,
    customerChargeCents: 5000,
    currency: 'MXN',
    eta: null,
    destinationPin: {
      kind: 'saved',
      addressId: ADDRESS,
      version: savedAddress().version,
    },
    cartPin: cart.items.map((line) => ({
      ...line,
      finalPriceCents: line.unitPriceCents * line.quantity,
    })),
    ...overrides,
  };
  await h.store.commitMinimalCart(
    SENDER,
    raw,
    { ...(raw as object), shipping },
    new Date().toISOString(),
  );
  return shipping;
}

async function confirmNewDelivery(
  h: Harness,
  overrides: Record<string, string> = {},
) {
  await h.checkout.updateDetails(SENDER, {
    label: null,
    firstName: 'Ana',
    lastName: null,
    street: 'Calle 5',
    exteriorNumber: 'S/N',
    interiorNumber: null,
    zipCode: '06700',
    neighborhood: 'Roma',
    municipality: null,
    city: 'CDMX',
    state: 'CDMX',
    visualReferences: null,
    carrierPhone: null,
    useNewAddress: true,
    ...overrides,
  });
  const offer = await h.checkout.prepareConfirmation(SENDER, EVENT('new1'));
  offer.onSent?.();
  await h.checkout.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('new2'),
  });
}

async function newShipping(h: Harness, free = false) {
  const draft = (await h.checkout.confirmedDraft(SENDER))!;
  await shippingRecord(h, {
    destinationPin: minimalShippingDestination(draft.address),
    ...(free ? { creditCents: 5000, customerChargeCents: 0 } : {}),
  });
}

async function correctSavedDelivery(h: Harness, zipCode = '55635') {
  const fields = Object.fromEntries(
    Object.keys(savedAddress())
      .filter((key) => key !== 'id' && key !== 'version')
      .map((key) => [key, null]),
  );
  await h.checkout.updateDetails(SENDER, {
    ...fields,
    firstName: null,
    lastName: null,
    zipCode,
    useNewAddress: false,
  } as Parameters<MinimalCheckoutService['updateDetails']>[1]);
  const offer = await h.checkout.prepareConfirmation(
    SENDER,
    EVENT('correction'),
  );
  offer.onSent?.();
  await h.checkout.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('correction-yes'),
  });
}

describe('corrected saved address checkout', () => {
  it.each([
    ['55635', 'existingUpdated'],
    ['06000', 'existing'],
  ])(
    'places %s using %s without changing unspecified snapshot fields',
    async (zipCode, mode) => {
      const h = setup();
      await h.seedCart();
      await confirmSavedDelivery(h);
      await correctSavedDelivery(h, zipCode);
      await newShipping(h);
      const offered = await offerOrder(h);
      expect(offered.reply).toContain(`C.P. ${zipCode}`);
      if (mode === 'existingUpdated')
        expect(offered.reply).toContain(
          'Actualizaremos su dirección guardada con estos datos.',
        );
      await yes(h);
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      const [payload] = h.api.createCheckout.mock.calls[0] as unknown as [
        { deliveryAddress: unknown },
      ];
      const { id, version, ...address } = savedAddress();
      expect(payload.deliveryAddress).toEqual({
        mode,
        addressId: id,
        expectedVersion: version,
        ...(mode === 'existingUpdated'
          ? {
              address: Object.fromEntries(
                Object.entries({ ...address, zipCode }).filter(
                  ([, value]) => value !== null,
                ),
              ),
            }
          : {}),
      });
      expect(h.api.createSale).not.toHaveBeenCalled();
      expect(await h.minimalCart()).toMatchObject({
        placedSale: { saleId: SALE },
      });
      await yes(h, 'duplicate');
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [409, 'ADDRESS_VERSION_CONFLICT'],
    [404, 'SHIPPING_ADDRESS_NOT_FOUND'],
  ] as const)(
    'clears the selection after %s %s and never retries',
    async (status, code) => {
      const h = setup();
      await h.seedCart();
      await confirmSavedDelivery(h);
      await correctSavedDelivery(h);
      await newShipping(h);
      await offerOrder(h);
      const draft = (await h.checkout.confirmedDraft(SENDER))!;
      h.api.createCheckout.mockRejectedValueOnce(
        new ChatbotApiError('private', status, undefined, code),
      );
      expect((await yes(h))?.reply).toBe(MINIMAL_CHECKOUT_RESELECT_REPLY);
      expect(await h.checkout.revalidateSelection(SENDER, draft)).toBe(
        'reselect',
      );
      expect(await h.checkout.confirmedDraft(SENDER)).toBeNull();
      await offerOrder(h, 'retry');
      await yes(h, 'retry-yes');
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );

  it('fingerprints the corrected payload and holds a changed correction after uncertainty', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await correctSavedDelivery(h);
    await newShipping(h);
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(new Error('network'));
    await yes(h);
    const [payload] = h.api.createCheckout.mock.calls[0] as unknown as [
      unknown,
    ];
    expect(await h.minimalCart()).toMatchObject({
      idempotencyFingerprint: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    });
    await correctSavedDelivery(h, '55636');
    await newShipping(h);
    await offerOrder(h, 'changed');
    expect((await yes(h, 'changed-yes'))?.reply).toBe(MINIMAL_ORDER_HELD_REPLY);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('new customer checkout S2/S3/S4/S6', () => {
  it.each(['expired', 'PENDING', 'DENIED'] as const)(
    'new shipping %s blocks the summary',
    async (status) => {
      const h = setup({ shipping: true });
      await h.seedCart();
      await confirmNewDelivery(h);
      await newShipping(h);
      const raw = await h.minimalCart();
      const cart = parseMinimalCart(raw)!;
      const record = cart.shipping!;
      await h.store.commitMinimalCart(
        SENDER,
        raw,
        {
          ...cart,
          shipping: {
            ...record,
            ...(status === 'expired'
              ? { expiresAt: new Date(Date.now() - 1).toISOString() }
              : { zoneStatus: status, quoteId: null, option: null }),
          },
        },
        new Date().toISOString(),
      );
      expect((await offerOrder(h)).onSent).toBeUndefined();
      expect(h.api.createCheckout).not.toHaveBeenCalled();
    },
  );
  it('not_observed retries the identical new checkout and key under fresh consent', async () => {
    const h = setup();
    await h.seedCart();
    await confirmNewDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost'));
    await yes(h);
    const first = h.api.createCheckout.mock.calls[0] as unknown as [
      unknown,
      string,
    ];
    await offerOrder(h, 'retry-new');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect((await yes(h, 'retry-new-yes'))?.reply).toContain('B-0042');
    expect(h.api.getCheckoutStatus).toHaveBeenCalledWith(first[1]);
    expect(h.api.createCheckout.mock.calls[1]).toEqual(first);
  });
  it('offers a new address for saving with the order', async () => {
    const h = setup();
    await h.seedCart();
    await confirmNewDelivery(h);
    await newShipping(h);
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Guardaremos esta dirección con su pedido.');
  });
  it.each([false, true])(
    'exact new payload with free shipping %s passes real schema',
    async (free) => {
      const h = setup({ shipping: true });
      await h.seedCart();
      if (free) {
        const raw = await h.minimalCart();
        await h.store.commitMinimalCart(
          SENDER,
          raw,
          {
            items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 60000 }],
            idempotencyKey: '',
            expectedTotalCents: 120000,
          },
          new Date().toISOString(),
        );
        h.setPrice(60000);
      }
      await confirmNewDelivery(h);
      await newShipping(h, free);
      await offerOrder(h);
      await yes(h);
      const payload = (
        h.api.createCheckout.mock.calls[0] as unknown as [unknown]
      )[0];
      expect(CreateCheckoutInputSchema.safeParse(payload).success).toBe(true);
      expect(payload).toMatchObject({
        phoneCountryCode: '52',
        phone: '5550001111',
        customer: { mode: 'createIfAbsent', firstName: 'Ana' },
        deliveryAddress: {
          mode: 'newSaved',
          address: {
            street: 'Calle 5',
            exteriorNumber: 'S/N',
            zipCode: '06700',
            neighborhood: 'Roma',
            city: 'CDMX',
            state: 'Ciudad de México',
          },
        },
        sale: { expectedTotalCents: free ? 120000 : 8000 },
      });
      const parsed = CreateCheckoutInputSchema.parse(payload);
      expect(parsed.customer).not.toHaveProperty('lastName');
      if (parsed.deliveryAddress?.mode !== 'newSaved')
        throw new Error('payload');
      for (const key of [
        'label',
        'interiorNumber',
        'municipality',
        'visualReferences',
        'carrierPhone',
      ])
        expect(parsed.deliveryAddress.address).not.toHaveProperty(key);
      expect(parsed.sale.shipping).toEqual({ quoteId: 'quote-1' });
      expect(h.api.createSale).not.toHaveBeenCalled();
      expect(h.api.upsertCustomer).not.toHaveBeenCalled();
    },
  );
  it('unique registered customer with NEW uses createIfAbsent', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await confirmNewDelivery(h);
    await newShipping(h);
    await offerOrder(h);
    await yes(h);
    expect(h.api.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: { mode: 'createIfAbsent', firstName: 'Ana' },
        deliveryAddress: expect.objectContaining({
          mode: 'newSaved',
        }) as unknown,
      }),
      expect.any(String),
    );
  });
  it('invalid state blocks delivery offer and correction requires reconfirmation', async () => {
    const h = setup();
    await h.seedCart();
    await confirmNewDelivery(h, { state: 'Texas' });
    const blocked = await h.checkout.prepareConfirmation(SENDER, EVENT('bad'));
    expect(blocked.onSent).toBeUndefined();
    expect(blocked.reply).toContain('estado válido de México');
    expect(await h.checkout.confirmedDraft(SENDER)).toBeNull();
    await confirmNewDelivery(h, { state: 'Queretaro' });
    expect((await offerOrder(h)).onSent).toBeDefined();
  });
  it.each([1, 2])(
    'ambiguous phone attempt %s preserves rotation rules',
    async (attempt) => {
      const h = setup();
      await h.seedCart();
      await confirmNewDelivery(h);
      await offerOrder(h);
      if (attempt === 2) {
        h.api.createCheckout.mockRejectedValueOnce(new Error('lost'));
        await yes(h);
        await offerOrder(h, 'retry');
      }
      h.api.createCheckout.mockRejectedValueOnce(
        new ChatbotApiError(
          'ambiguous',
          409,
          undefined,
          'CUSTOMER_PHONE_AMBIGUOUS',
        ),
      );
      const reply = await yes(h, 'answer');
      expect(reply?.reply).toContain('comuníquese con la tienda');
      expect(reply?.reply).not.toContain('quedó registrado');
      expect(
        ((await h.minimalCart()) as { idempotencyKey: string })
          .idempotencyKey === '',
      ).toBe(attempt === 1);
    },
  );
  it('new checkout recovers status first after stock exhaustion', async () => {
    const h = setup();
    await h.seedCart();
    await confirmNewDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost'));
    await yes(h);
    h.api.getStock.mockResolvedValue({
      productId: PRODUCT,
      name: 'Ibuprofeno',
      stock: { status: 'out_of_stock', quantity: 0 },
      variants: [],
    });
    h.api.getStock.mockClear();
    h.api.getCheckoutStatus.mockResolvedValueOnce({
      status: 'succeeded',
      checkout: { sale: placedSale() },
    });
    expect(
      (await h.order.prepareOrder(SENDER, EVENT('recover'))).reply,
    ).toContain('B-0042');
    expect(h.api.getStock).not.toHaveBeenCalled();
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
  it.each([
    'label',
    'street',
    'exteriorNumber',
    'interiorNumber',
    'zipCode',
    'neighborhood',
    'municipality',
    'city',
    'state',
    'visualReferences',
    'carrierPhone',
    'firstName',
    'lastName',
  ])('exact payload fingerprint changes with %s', async (field) => {
    const h = setup();
    await h.seedCart();
    await confirmNewDelivery(h);
    await newShipping(h);
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost'));
    await yes(h);
    const locked = (await h.minimalCart()) as {
      idempotencyFingerprint: string;
    };
    const first = (
      h.api.createCheckout.mock.calls[0] as unknown as [unknown]
    )[0];
    expect(locked.idempotencyFingerprint).toBe(
      createHash('sha256').update(JSON.stringify(first)).digest('hex'),
    );
    await confirmNewDelivery(h, {
      [field]: field === 'state' ? 'Jalisco' : 'Otro',
    });
    await newShipping(h);
    await offerOrder(h, 'edited');
    expect((await yes(h, 'editedYes'))?.reply).toBe(MINIMAL_ORDER_HELD_REPLY);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('NEW shipping freshness only (T1)', () => {
  it('accepts a current NEW-address quote, rejects edits and PENDING zones, and requires a persisted quote', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await h.checkout.updateDetails(SENDER, {
      ...savedAddress(),
      firstName: null,
      lastName: null,
      useNewAddress: true,
    });
    const offer = await h.checkout.prepareConfirmation(SENDER, EVENT('new1'));
    offer.onSent?.();
    await h.checkout.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('new2'),
    });
    const draft = (await h.checkout.confirmedDraft(SENDER))!;
    expect(draft.address.kind).toBe('new');
    const shipping = await shippingRecord(h, {
      destinationPin: minimalShippingDestination(draft.address),
    });
    const cart = parseMinimalCart(await h.minimalCart())!;
    const quote = await h.cart.view(SENDER);
    if (!quote.ok) throw new Error('cart fixture');
    const snapshot = {
      customerId: CUSTOMER,
      shippingAddressId: '',
      draft,
      items: quote.items,
      totalCents: quote.totalCents,
    };
    expect(h.order['currentShipping']({ ...cart, shipping }, snapshot)).toEqual(
      {
        quoteId: 'quote-1',
        customerChargeCents: 5000,
        creditCents: 0,
        option: { carrier: 'Skydropx', service: 'Ground' },
        eta: { days: 2 },
      },
    );
    if (draft.address.kind !== 'new') throw new Error('new fixture');
    expect(
      h.order['currentShipping'](
        { ...cart, shipping },
        {
          ...snapshot,
          draft: {
            ...draft,
            address: {
              kind: 'new',
              fields: { ...draft.address.fields, street: 'Edited' },
            },
          },
        },
      ),
    ).toBeNull();
    expect(
      h.order['currentShipping'](
        {
          ...cart,
          shipping: {
            ...shipping,
            zoneStatus: 'PENDING',
            quoteId: null,
          },
        },
        snapshot,
      ),
    ).toBeNull();
    await h.store.commitMinimalCart(
      SENDER,
      await h.minimalCart(),
      { ...cart, shipping: undefined },
      new Date().toISOString(),
    );
    expect((await h.order.prepareOrder(SENDER, EVENT('order-new'))).reply).toBe(
      MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY,
    );
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
});

describe('atomic checkout order S1–S5', () => {
  async function ready(shipping = false) {
    const h = setup({ shipping });
    await h.seedCart();
    await confirmSavedDelivery(h);
    if (shipping) await shippingRecord(h);
    await offerOrder(h);
    return h;
  }

  it.each(['stock', 'shipping', 'consume', 'unarmed consume'])(
    'S5 recovers before fresh %s gates',
    async (gate) => {
      const h = await ready(gate === 'shipping');
      h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
      await yes(h);
      const locked = await h.minimalCart();
      if (gate === 'consume') await offerOrder(h, 'wamid.retry');
      const clock =
        gate === 'shipping'
          ? jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000)
          : undefined;
      if (gate !== 'shipping')
        h.api.getStock.mockResolvedValue({
          productId: PRODUCT,
          name: 'Ibuprofeno',
          stock: { status: 'out_of_stock', quantity: 0 },
          variants: [],
        });
      h.api.getStock.mockClear();
      h.api.getCheckoutStatus.mockClear();
      h.api.getCheckoutStatus.mockResolvedValueOnce({
        status: 'succeeded',
        checkout: { sale: placedSale() },
      });
      const result = gate.includes('consume')
        ? await yes(h, 'wamid.retryyes')
        : await h.order.prepareOrder(SENDER, EVENT('wamid.recover'));
      clock?.mockRestore();
      expect(result?.reply).toContain('B-0042');
      expect(result?.reply).toContain('CLABE');
      expect(result?.onSent).toBeUndefined();
      expect(h.api.getCheckoutStatus).toHaveBeenCalledWith(
        (locked as { idempotencyKey: string }).idempotencyKey,
      );
      expect(h.api.getStock).not.toHaveBeenCalled();
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      expect(await h.minimalCart()).toMatchObject({
        items: [],
        idempotencyKey: '',
        placedSale: { saleId: SALE },
      });
    },
  );

  it.each(['not_observed', 'failure', 'invalid'])(
    'S5 %s with exhausted stock keeps uncertainty and lock',
    async (status) => {
      const h = await ready();
      h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
      await yes(h);
      const locked = await h.minimalCart();
      h.api.getStock.mockResolvedValue({
        productId: PRODUCT,
        name: 'Ibuprofeno',
        stock: { status: 'out_of_stock', quantity: 0 },
        variants: [],
      });
      h.api.getStock.mockClear();
      if (status === 'failure')
        h.api.getCheckoutStatus.mockRejectedValueOnce(new Error('down'));
      if (status === 'invalid')
        h.api.getCheckoutStatus.mockResolvedValueOnce({
          status: 'succeeded',
          checkout: null,
        });
      const result = await h.order.prepareOrder(SENDER, EVENT('wamid.recover'));
      expect(result.reply).toBe(
        status === 'not_observed'
          ? MINIMAL_ORDER_UNRESOLVED_REPLY
          : MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
      );
      expect(result.reply).not.toContain('No se creó ningún pedido');
      expect(await h.minimalCart()).toEqual(locked);
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      if (status !== 'not_observed')
        expect(h.api.getStock).not.toHaveBeenCalled();
    },
  );

  it('S5 not_observed in consume preserves lock when fresh stock fails', async () => {
    const h = await ready();
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
    await yes(h);
    await offerOrder(h, 'wamid.retry');
    const locked = await h.minimalCart();
    h.api.getCheckoutStatus.mockClear();
    h.api.getStock.mockImplementation(async () => {
      expect(h.api.getCheckoutStatus).toHaveBeenCalledWith(
        (locked as { idempotencyKey: string }).idempotencyKey,
      );
      return {
        productId: PRODUCT,
        name: 'Ibuprofeno',
        stock: { status: 'out_of_stock', quantity: 0 },
        variants: [],
      };
    });
    expect((await yes(h, 'wamid.retryyes'))?.reply).toBe(
      MINIMAL_ORDER_UNRESOLVED_REPLY,
    );
    expect(await h.minimalCart()).toEqual(locked);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('S5 recovery discloses success even when its exact raw cart CAS fails', async () => {
    const h = await ready();
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
    await yes(h);
    const locked = await h.minimalCart();
    h.api.getCheckoutStatus.mockResolvedValueOnce({
      status: 'succeeded',
      checkout: { sale: placedSale() },
    });
    const commit = jest
      .spyOn(h.store, 'commitMinimalCart')
      .mockResolvedValueOnce(false);
    const result = await h.order.prepareOrder(SENDER, EVENT('wamid.recover'));
    expect(commit.mock.calls[0][0]).toBe(SENDER);
    expect(commit.mock.calls[0][1]).toEqual(locked);
    expect(commit.mock.calls[0][2]).toMatchObject({
      placedSale: { saleId: SALE },
    });
    expect(result.reply).toContain('B-0042');
    expect(result.reply).toContain('CLABE');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toEqual(locked);
  });

  it('S2/S3/S4 sends trusted identity, saved snapshot and exact fingerprint', async () => {
    const h = await ready(true);
    h.api.createCheckout.mockRejectedValueOnce(new Error('network'));
    expect((await yes(h))?.reply).toBe(MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY);
    const [payload, key] = h.api.createCheckout.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(payload).toEqual({
      phoneCountryCode: '52',
      phone: '5550001111',
      customer: { mode: 'existing', customerId: CUSTOMER },
      deliveryAddress: {
        mode: 'existing',
        addressId: ADDRESS,
        expectedVersion: savedAddress().version,
      },
      sale: {
        cashierUserId: CASHIER,
        expectedTotalCents: 8000,
        shipping: { quoteId: 'quote-1' },
        items: [
          {
            productId: PRODUCT,
            variantId: null,
            productName: 'Ibuprofeno',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1500,
          },
        ],
      },
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: key,
      idempotencyAttempts: 1,
      idempotencyFingerprint: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    });
    expect(h.api.createSale).not.toHaveBeenCalled();
    expect(h.api.getCheckoutStatus).not.toHaveBeenCalled();
  });

  it('S2 free shipping still sends its quoteId with a product-only total', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    const raw = await h.minimalCart();
    await h.store.commitMinimalCart(
      SENDER,
      raw,
      {
        items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 60000 }],
        idempotencyKey: '',
        expectedTotalCents: 120000,
      },
      new Date().toISOString(),
    );
    h.setPrice(60000);
    await shippingRecord(h, { creditCents: 5000, customerChargeCents: 0 });
    await offerOrder(h);
    expect((await yes(h))?.reply).toContain('Envío sin costo para usted');
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0];
    expect(payload.sale).toMatchObject({
      expectedTotalCents: 120000,
      shipping: { quoteId: 'quote-1' },
    });
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it.each([null, {}, { sale: { saleId: SALE, totalCents: '3000' } }])(
    'S4 malformed checkout success %# retains lock',
    async (body) => {
      const h = await ready();
      h.api.createCheckout.mockResolvedValueOnce(body);
      expect((await yes(h))?.reply).toBe(MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY);
      expect(await h.minimalCart()).toMatchObject({ idempotencyAttempts: 1 });
      expect(
        await h.cart.setItem(
          SENDER,
          { productId: PRODUCT, quantity: 1 },
          new Set([PRODUCT]),
        ),
      ).toEqual({ ok: false, error: 'order_unresolved' });
    },
  );

  it('S4 changed checkout fingerprint checks status but holds without POST', async () => {
    const h = await ready();
    h.api.createCheckout.mockRejectedValueOnce(new Error('network'));
    await yes(h);
    h.api.getCustomerCheckoutContext.mockResolvedValue(
      unique(savedAddress({ version: '2026-10-02T00:00:00.000Z' })),
    );
    await confirmSavedDelivery(h);
    await newShipping(h);
    await offerOrder(h, 'wamid.changed1');
    expect((await yes(h, 'wamid.changed2'))?.reply).toBe(
      MINIMAL_ORDER_HELD_REPLY,
    );
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.api.getCheckoutStatus).toHaveBeenCalled();
    expect(await h.minimalCart()).toMatchObject({ idempotencyAttempts: 1 });
  });

  it.each([
    [409, 'IDEMPOTENCY_KEY_IN_FLIGHT'],
    [409, 'IDEMPOTENCY_KEY_CONFLICT'],
    [503, 'CHECKOUT_RETRY_REQUIRED'],
    [500, 'CHECKOUT_CREATE_FAILED'],
    [408, null],
    [429, null],
    [502, null],
    [500, 'PROMO_RE_QUOTE'],
    [null, null],
  ])('S4 uncertain %s %s retains key', async (status, code) => {
    const h = await ready();
    h.api.createCheckout.mockRejectedValueOnce(
      new ChatbotApiError('raw secret', status, undefined, code),
    );
    expect((await yes(h))?.reply).toBe(MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY);
    expect(await h.minimalCart()).toMatchObject({
      idempotencyAttempts: 1,
      idempotencyKey: expect.stringMatching(UUID) as unknown,
    });
  });

  it.each([
    'ADDRESS_VERSION_CONFLICT',
    'PRICE_OUT_OF_DATE',
    'PROMO_RE_QUOTE',
    'STOCK_INSUFFICIENT_AT_CONFIRM',
    'CUSTOMER_PHONE_AMBIGUOUS',
    'CUSTOMER_NOT_FOUND',
    'SHIPPING_ADDRESS_NOT_FOUND',
    'CASHIER_NOT_FOUND',
    'INVALID_CHECKOUT_REQUEST',
    'INVALID_IDEMPOTENCY_KEY',
    'TYPED_RULE',
  ])('S4 rejection %s rotates first but keeps later', async (code) => {
    const h = await ready();
    const status = code.startsWith('INVALID_')
      ? 400
      : code.endsWith('_NOT_FOUND')
        ? 404
        : code === 'TYPED_RULE'
          ? 422
          : 409;
    const rejection = new ChatbotApiError(
      'raw secret',
      status,
      undefined,
      code,
    );
    h.api.createCheckout.mockRejectedValueOnce(rejection);
    const reply = (await yes(h))?.reply;
    expect(reply).not.toContain('raw secret');
    if (
      code === 'ADDRESS_VERSION_CONFLICT' ||
      code === 'SHIPPING_ADDRESS_NOT_FOUND'
    ) {
      expect(reply).toBe(MINIMAL_CHECKOUT_RESELECT_REPLY);
      await confirmSavedDelivery(h);
    }
    expect(await h.minimalCart()).toMatchObject({ idempotencyKey: '' });
    await offerOrder(h, 'wamid.r1');
    h.api.createCheckout.mockRejectedValueOnce(new Error('network'));
    await yes(h, 'wamid.r2');
    const locked = await h.minimalCart();
    await offerOrder(h, 'wamid.r3');
    h.api.createCheckout.mockRejectedValueOnce(rejection);
    expect((await yes(h, 'wamid.r4'))?.reply).toBe(
      code === 'CUSTOMER_PHONE_AMBIGUOUS'
        ? MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY
        : MINIMAL_ORDER_UNRESOLVED_REPLY,
    );
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (locked as { idempotencyKey: string }).idempotencyKey,
      idempotencyAttempts: 2,
    });
  });

  it.each(['succeeded', 'not_observed', 'failure'])(
    'S5 recovers %s before POST',
    async (status) => {
      const h = await ready();
      h.api.createCheckout.mockRejectedValueOnce(new Error('network'));
      await yes(h);
      const before = await h.minimalCart();
      const [payload, key] = h.api.createCheckout.mock.calls[0] as unknown as [
        unknown,
        string,
      ];
      if (status === 'failure')
        h.api.getCheckoutStatus.mockRejectedValueOnce(
          new Error('status unavailable'),
        );
      if (status === 'succeeded')
        h.api.getCheckoutStatus.mockResolvedValueOnce({
          status,
          checkout: { sale: placedSale() },
        });
      const offered = await offerOrder(h, 'wamid.status1');
      const reply =
        status === 'not_observed'
          ? (await yes(h, 'wamid.status2'))?.reply
          : offered.reply;
      expect(h.api.getCheckoutStatus).toHaveBeenCalledWith(key);
      if (status === 'failure') {
        expect(reply).toBe(MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY);
        expect(await h.minimalCart()).toEqual(before);
        expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      } else {
        expect(reply).toContain('B-0042');
        expect(reply).toContain('CLABE');
        expect(await h.minimalCart()).toMatchObject({
          items: [],
          placedSale: { saleId: SALE },
        });
        expect(h.api.createCheckout).toHaveBeenCalledTimes(
          status === 'succeeded' ? 1 : 2,
        );
        if (status === 'not_observed') {
          expect(h.api.createCheckout.mock.calls[1]).toEqual([payload, key]);
          expect(
            h.api.getCheckoutStatus.mock.invocationCallOrder[0],
          ).toBeLessThan(h.api.createCheckout.mock.invocationCallOrder[1]);
        }
      }
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );
});

describe('minimal shipping order safety', () => {
  it('[S2] sends the stored quoteId and products+customerChargeCents in the exact fingerprinted payload', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    h.api.createCheckout.mockRejectedValueOnce(new Error('uncertain'));
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Envío con Skydropx (Ground): $50.00 MXN');
    expect(offer.reply).toContain('Llega en aproximadamente 2 días hábiles.');
    expect(offer.reply).toContain('Total a pagar: $80.00 MXN');
    await yes(h);
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [unknown]
    )[0];
    expect(payload).toMatchObject({
      sale: {
        expectedTotalCents: 8000,
        shipping: { quoteId: 'quote-1' },
      },
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyAttempts: 1,
      idempotencyFingerprint: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    });
    const firstKey = (
      h.api.createCheckout.mock.calls[0] as unknown as [unknown, string]
    )[1];
    h.api.createCheckout.mockRejectedValueOnce(new Error('still uncertain'));
    await offerOrder(h, 'wamid.retry1');
    await yes(h, 'wamid.retry2');
    expect(
      h.api.createCheckout.mock.calls[1] as unknown as [unknown, string],
    ).toEqual([payload, firstKey]);
    expect(await h.minimalCart()).toMatchObject({ idempotencyAttempts: 2 });
  });

  it('[S2,S3] covered shipping sends only its quoteId and omits the disclaimer', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    const raw = await h.minimalCart();
    await h.store.commitMinimalCart(
      SENDER,
      raw,
      {
        items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 60000 }],
        idempotencyKey: '',
        expectedTotalCents: 120000,
      },
      new Date().toISOString(),
    );
    h.setPrice(60000);
    await shippingRecord(h, { creditCents: 5000, customerChargeCents: 0 });
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('sin costo para usted');
    expect(offer.reply).not.toContain('Total a pagar');
    expect(offer.reply).not.toContain('no está incluido');
    const result = await yes(h);
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0];
    expect(payload.sale).toMatchObject({
      expectedTotalCents: 120000,
      shipping: { quoteId: 'quote-1' },
    });
    expect(result?.reply).not.toContain('no está incluido');
  });

  it.each([
    'missing',
    'PENDING',
    'DENIED',
    'expired',
    'clock',
    'cart',
    'address',
    'version',
  ] as const)(
    '[S2] refuses %s shipping before summary and sale',
    async (state) => {
      const clock = { now: Date.now() };
      const h = setup({ shipping: true, now: () => clock.now });
      await h.seedCart();
      await confirmSavedDelivery(h);
      const record = await shippingRecord(h);
      await offerOrder(h);
      const raw = await h.minimalCart();
      const next = { ...(raw as Record<string, unknown>) };
      if (state === 'missing') delete next.shipping;
      if (state === 'PENDING' || state === 'DENIED')
        next.shipping = {
          ...record,
          zoneStatus: state,
          quoteId: null,
          expiresAt: null,
          costCents: 0,
          creditCents: 0,
          customerChargeCents: 0,
        };
      if (state === 'expired')
        next.shipping = {
          ...record,
          expiresAt: new Date(clock.now - 1).toISOString(),
        };
      // The stored quote is untouched; only the injected clock passes expiresAt.
      if (state === 'clock') clock.now = Date.parse(record.expiresAt!);
      if (state === 'cart')
        next.shipping = {
          ...record,
          cartPin: record.cartPin.map((line) => ({
            ...line,
            finalPriceCents: 2900,
          })),
        };
      if (state === 'address')
        next.shipping = {
          ...record,
          destinationPin: { ...record.destinationPin, addressId: CUSTOMER },
        };
      if (state === 'version')
        next.shipping = {
          ...record,
          destinationPin: {
            ...record.destinationPin,
            version: '2026-10-02T00:00:00.000Z',
          },
        };
      await h.store.commitMinimalCart(
        SENDER,
        raw,
        next,
        new Date().toISOString(),
      );
      expect(parseMinimalCart(await h.minimalCart())).not.toBeNull();
      const refusal = await yes(h);
      expect(refusal?.reply).toBe(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY);
      const offer = await offerOrder(h, 'wamid.recheck');
      expect(offer.reply).toBe(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY);
      expect(offer.onSent).toBeUndefined();
      await yes(h);
      expect(h.api.createCheckout).not.toHaveBeenCalled();
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );

  it('S4: freight changes spend consent and re-present the summary', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    await offerOrder(h);
    await shippingRecord(h, {
      quoteId: 'quote-2',
      costCents: 6000,
      customerChargeCents: 6000,
    });
    const result = await yes(h);
    expect(result?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(result?.reply).toContain('Total a pagar: $90.00 MXN');
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    result?.onSent?.();
    await yes(h, 'wamid.o3');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      await h.order.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('wamid.o4'),
      }),
    ).toBeNull();
  });

  it('S4/order S5/S7: holds an outstanding key when freight changes', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    h.api.createCheckout.mockRejectedValueOnce(new Error('uncertain'));
    await offerOrder(h);
    await yes(h);
    const before = await h.minimalCart();
    await shippingRecord(h, {
      quoteId: 'quote-2',
      costCents: 6000,
      customerChargeCents: 6000,
    });
    await offerOrder(h, 'wamid.retry1');
    expect(await yes(h, 'wamid.retry2')).toEqual({
      reply: MINIMAL_ORDER_HELD_REPLY,
    });
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (before as { idempotencyKey: string }).idempotencyKey,
      idempotencyAttempts: 1,
    });
  });
});

describe('MinimalOrderService', () => {
  it('[T1c] places the customer-priced cart using backend unit prices and final totals', async () => {
    const h = setup();
    h.setPrice(1000);
    h.api.evaluateCart.mockImplementation(async (items) => ({
      items: items.map((item) => ({
        productId: PRODUCT,
        variantId: null,
        quantity: item.quantity,
        unitPriceCents: 800,
        originalPriceCents: 800 * item.quantity,
        finalPriceCents: 800 * item.quantity - 100,
        discountAmountCents: 100,
        appliedPromotionTitle: null,
      })),
      promotionEvaluationStatus: 'fully_evaluated',
    }));
    expect(
      await h.cart.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 2 },
        new Set([PRODUCT]),
      ),
    ).toMatchObject({ ok: true, totalCents: 1500 });
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 800 }],
      expectedTotalCents: 1500,
    });
    await confirmSavedDelivery(h);
    // The customer price changed the lines, so store pickup is re-chosen.
    await h.shipping.chooseStorePickup(SENDER);
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('2 × $8.00 MXN');
    expect(offer.reply).toContain('Total de productos: $15.00 MXN');
    const sale = {
      ...placedSale(),
      totalCents: 1500,
      debtCents: 1500,
      discountCents: 100,
    };
    h.api.createCheckout.mockResolvedValue({ status: 'created', sale });
    expect((await yes(h))?.reply).toContain('B-0042');
    const expectedSale = {
      cashierUserId: CASHIER,
      expectedTotalCents: 1500,
      items: [
        {
          productId: PRODUCT,
          variantId: null,
          productName: 'Ibuprofeno',
          variantName: null,
          quantity: 2,
          unitPriceCents: 800,
        },
      ],
      shipping: { mode: 'pickup' },
    };
    expect(h.api.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ sale: expectedSale }),
      expect.stringMatching(UUID),
    );
    expect(h.api.createSale).not.toHaveBeenCalled();
    for (const args of h.api.evaluateCart.mock
      .calls as unknown as unknown[][]) {
      expect(args[1]).toEqual({
        phoneCountryCode: '52',
        phone: '5550001111',
      });
    }
  });

  it('[S5] discounted display leaves the exact payload, fingerprint and retry key unchanged', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    let title = 'Oferta';
    const evaluateCart = h.api.evaluateCart as unknown as jest.MockedFunction<
      ChatbotApiClient['evaluateCart']
    >;
    evaluateCart.mockImplementation(async (items) => ({
      items: items.map((item) => ({
        productId: PRODUCT,
        variantId: null,
        quantity: item.quantity,
        unitPriceCents: 1500,
        originalPriceCents: 1500 * item.quantity,
        finalPriceCents: 1350 * item.quantity,
        discountAmountCents: 150 * item.quantity,
        appliedPromotionTitle: title,
      })),
      promotionEvaluationStatus: 'fully_evaluated',
    }));
    const sale = {
      cashierUserId: CASHIER,
      expectedTotalCents: 2700,
      items: [
        {
          productId: PRODUCT,
          variantId: null,
          productName: 'Ibuprofeno',
          variantName: null,
          quantity: 2,
          unitPriceCents: 1500,
        },
      ],
      shipping: { mode: 'pickup' as const },
    };
    const expectedPayload = CreateCheckoutInputSchema.parse({
      phoneCountryCode: '52',
      phone: '5550001111',
      customer: { mode: 'existing', customerId: CUSTOMER },
      sale,
    });
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(expectedPayload))
      .digest('hex');
    // The promotion changed the line totals, so the store pickup choice is
    // pinned to the discounted lines.
    const raw = await h.minimalCart();
    await h.store.commitMinimalCart(
      SENDER,
      raw,
      {
        ...(raw as object),
        shipping: {
          mode: 'pickup',
          cartPin: [
            {
              productId: PRODUCT,
              quantity: 2,
              unitPriceCents: 1500,
              finalPriceCents: 2700,
            },
          ],
        },
      },
      new Date().toISOString(),
    );
    for (const attempt of [1, 2]) {
      const offer = await offerOrder(h, `promo-offer-${attempt}`);
      expect(offer.reply).toContain(
        `• Ibuprofeno: 2 × $15.00 MXN; importe $27.00 MXN (promoción: ${title}, ahorro $3.00 MXN)`,
      );
      h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
      await yes(h, `promo-yes-${attempt}`);
      expect(await h.minimalCart()).toMatchObject({
        idempotencyFingerprint: fingerprint,
        idempotencyAttempts: attempt,
      });
      title = 'Renamed offer';
    }
    const calls = h.api.createCheckout.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([expectedPayload, expect.stringMatching(UUID)]);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('is enabled whenever a cashier is configured', () => {
    expect(setup({ cashier: '' }).order.enabled).toBe(false);
    expect(setup().order.enabled).toBe(true);
  });

  it('creates exactly one sale for a strict armed SÍ and sends payment details', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Resumen de su pedido:');
    expect(offer.reply).toContain('Total de productos: $30.00 MXN');
    expect(h.api.createCheckout).not.toHaveBeenCalled();

    const placed = await yes(h);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const [payload, key] = h.api.createCheckout.mock.calls[0] as unknown as [
      unknown,
      string,
    ];
    expect(payload).toEqual({
      phoneCountryCode: '52',
      phone: '5550001111',
      customer: { mode: 'existing', customerId: CUSTOMER },
      sale: {
        cashierUserId: CASHIER,
        expectedTotalCents: 3000,
        items: [
          {
            productId: PRODUCT,
            variantId: null,
            productName: 'Ibuprofeno',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1500,
          },
        ],
        shipping: { mode: 'pickup' },
      },
    });
    expect(key).toMatch(UUID);
    expect(placed?.reply).toContain('folio B-0042');
    expect(placed?.reply).toContain('$30.00 MXN');
    expect(placed?.reply).toContain('CLABE: 012180001234567891');
    expect(placed?.onSent).toBeUndefined();
    expect(await h.minimalCart()).toEqual({
      items: [],
      idempotencyKey: '',
      placedSale: { saleId: SALE, folio: 'B-0042', totalCents: 3000 },
    });
    expect((await h.store.get(SENDER))?.data.cart).toEqual({
      legacy: 'preserved',
    });
    expect(await yes(h, 'wamid.o3')).toBeNull();
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.api.upsertCustomer).not.toHaveBeenCalled();
  });

  it('never creates a sale before the summary was sent', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await h.order.prepareOrder(SENDER, EVENT('wamid.o1'));
    expect(await yes(h)).toEqual({ reply: MINIMAL_ORDER_AMBIGUOUS_REPLY });
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('[S3] a natural "Sí, por favor 🙏" after the summary creates the order once', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    const say = (text: string, id: string) =>
      h.order.consume({ senderId: SENDER, text, inboundEvent: EVENT(id) });
    const placed = await say('Sí, por favor 🙏', 'wamid.o2');
    expect(placed?.reply).toContain('folio B-0042');
    expect(await say('Sí, por favor 🙏', 'wamid.o3')).toBeNull();
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('[S3] "no gracias" declines the summary without creating the order', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    expect(
      await h.order.consume({
        senderId: SENDER,
        text: 'no gracias',
        inboundEvent: EVENT('wamid.o2'),
      }),
    ).toEqual({ reply: MINIMAL_ORDER_DECLINED_REPLY });
    expect(await yes(h, 'wamid.o3')).toBeNull();
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('[S3] "sí, pero quite uno" is not consent and creates nothing', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    expect(
      await h.order.consume({
        senderId: SENDER,
        text: 'sí, pero quite uno',
        inboundEvent: EVENT('wamid.o2'),
      }),
    ).toBeNull();
    expect(await yes(h, 'wamid.o3')).toBeNull();
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['delivery_unconfirmed', false, true],
    ['empty_cart', true, false],
  ] as const)(
    'explains %s without creating a sale',
    async (reason, confirm, seed) => {
      // A delivery cart: store pickup needs no delivery data (C1).
      const h = setup({ shipping: true });
      if (seed) await h.seedCart();
      if (confirm) await confirmSavedDelivery(h);
      expect(await h.order.prepareOrder(SENDER, EVENT('wamid.o1'))).toEqual({
        reply: MINIMAL_ORDER_INELIGIBLE_REPLIES[reason],
      });
      expect(h.api.createCheckout).not.toHaveBeenCalled();
    },
  );

  it('re-presents instead of selling when prices changed after the summary', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.setPrice(1600);
    // L13: same products and quantities keep the pickup choice; only the
    // prices changed, so the customer sees the updated summary, not the
    // shipping-required question.
    const result = await yes(h);
    expect(result?.reply.startsWith(MINIMAL_ORDER_CHANGED_REPLY)).toBe(true);
    expect(result?.reply).toContain('Total de productos: $32.00 MXN');
    expect(result?.onSent).toEqual(expect.any(Function));
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('a SÍ on the re-presented prices-changed summary places the order at the new prices', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.setPrice(1600);
    const changed = await yes(h);
    expect(changed?.reply.startsWith(MINIMAL_ORDER_CHANGED_REPLY)).toBe(true);
    // The stored cart now carries the prices the customer was shown; the
    // pickup choice survives because it ignores prices.
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1600 }],
      expectedTotalCents: 3200,
      shipping: { mode: 'pickup' },
    });
    changed?.onSent?.();
    const placed = await yes(h, 'wamid.o3');
    expect(placed?.reply).toContain('folio B-0042');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({
      sale: {
        items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1600 }],
        expectedTotalCents: 3200,
        shipping: { mode: 'pickup' },
      },
    });
  });

  it('a price change before the first summary is stored so its SÍ places the order', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    h.setPrice(1600);
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Total de productos: $32.00 MXN');
    await yes(h);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({ sale: { expectedTotalCents: 3200 } });
  });

  it('a cart edit racing the re-price loses the CAS like any cart write and creates nothing', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.setPrice(1600);
    const before = await h.minimalCart();
    const commit = h.store.commitMinimalCart.bind(h.store);
    jest
      .spyOn(h.store, 'commitMinimalCart')
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementation(commit);
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified,
    });
    expect(h.store.commitMinimalCart).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toEqual(before);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    // Not a dead end: asking again re-prices and the next SÍ places it.
    const offer = await offerOrder(h, 'wamid.again');
    expect(offer.reply).toContain('Total de productos: $32.00 MXN');
    await yes(h, 'wamid.again-yes');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({ sale: { expectedTotalCents: 3200 } });
  });

  it('a delivery quote pinned to the old prices is re-quoted in the same turn', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    await offerOrder(h);
    h.setPrice(1600);
    h.quotes.enqueue({
      quoteId: 'quote-2',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      zoneStatus: 'CARRIER_ONLY',
      option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
      costCents: 5000,
      creditCents: 0,
      customerChargeCents: 5000,
      currency: 'MXN',
      eta: { days: 2, reason: null },
    });
    const changed = await yes(h);
    expect(changed?.reply.startsWith(MINIMAL_ORDER_CHANGED_REPLY)).toBe(true);
    expect(changed?.reply).toContain('Total a pagar: $82.00 MXN');
    expect(h.quotes.calls).toHaveLength(1);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    changed?.onSent?.();
    await yes(h, 'wamid.o3');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({
      sale: {
        items: [{ unitPriceCents: 1600 }],
        expectedTotalCents: 8200,
        shipping: { quoteId: 'quote-2' },
      },
    });
  });

  it('a failed re-quote after a price change asks for shipping again and a new quote then works', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    await offerOrder(h);
    h.setPrice(1600);
    // Nothing queued: the fake shipping client rejects the re-quote.
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
    });
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    expect(await h.minimalCart()).toMatchObject({
      items: [{ unitPriceCents: 1600 }],
      expectedTotalCents: 3200,
    });
    h.quotes.enqueue({
      quoteId: 'quote-3',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      zoneStatus: 'CARRIER_ONLY',
      option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
      costCents: 5000,
      creditCents: 0,
      customerChargeCents: 5000,
      currency: 'MXN',
      eta: { days: 2, reason: null },
    });
    expect(await h.shipping.quote(SENDER)).toMatchObject({ kind: 'quoted' });
    await offerOrder(h, 'wamid.quoted');
    await yes(h, 'wamid.quoted-yes');
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({
      sale: { expectedTotalCents: 8200, shipping: { quoteId: 'quote-3' } },
    });
  });

  it('reoffers delivery confirmation without selling when the delivery draft changed after the summary', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await newShipping(h);
    await offerOrder(h);
    await h.checkout.updateDetails(SENDER, {
      firstName: 'Ana María',
      lastName: null,
      label: null,
      street: null,
      exteriorNumber: null,
      interiorNumber: null,
      zipCode: null,
      neighborhood: null,
      municipality: null,
      city: null,
      state: null,
      visualReferences: null,
      carrierPhone: null,
      useNewAddress: false,
    });
    const result = await yes(h);
    expect(result?.reply).toMatch(/^Confirme sus datos de entrega:/);
    expect(result?.reply).toContain('Nombre: Ana María');
    expect(result?.onSent).toEqual(expect.any(Function));
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('asks to re-select when the saved address changed upstream', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await newShipping(h);
    await offerOrder(h);
    h.api.getCustomerCheckoutContext.mockImplementation(() =>
      Promise.resolve(
        unique(savedAddress({ version: '2026-10-02T00:00:00.000Z' })),
      ),
    );
    expect(await yes(h)).toEqual({ reply: MINIMAL_CHECKOUT_RESELECT_REPLY });
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('keeps the idempotency key after an ambiguous failure and reuses it', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('timeout', 503)),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    const firstKey = (h.api.createCheckout.mock.calls[0] as unknown[])[1];
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2 }],
      idempotencyKey: firstKey,
    });
    await offerOrder(h, 'wamid.o3');
    await yes(h, 'wamid.o4');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(2);
    expect((h.api.createCheckout.mock.calls[1] as unknown[])[1]).toBe(firstKey);
  });

  it('never sends a different payload under an outstanding key', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('timeout', 503)),
    );
    await yes(h);
    const before = await h.minimalCart();
    // A promotion moves the total while the cart lines stay the same.
    h.api.evaluateCart.mockImplementation(
      (items: Array<{ quantity: number }>) =>
        Promise.resolve({
          items: items.map((item) => ({
            productId: PRODUCT,
            variantId: null,
            quantity: item.quantity,
            unitPriceCents: 1500,
            originalPriceCents: 1500 * item.quantity,
            finalPriceCents: 1250 * item.quantity,
            discountAmountCents: 250 * item.quantity,
            appliedPromotionTitle: null,
          })),
          promotionEvaluationStatus: 'fully_evaluated',
        }),
    );
    // The pickup choice survives a price change (L13), so the new summary is
    // shown, but its SÍ is held: nothing is sent under the outstanding key.
    await offerOrder(h, 'wamid.o3');
    expect(await yes(h, 'wamid.o4')).toEqual({
      reply: MINIMAL_ORDER_HELD_REPLY,
    });
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toEqual(before);
  });

  it('keeps the key when the backend saw it with another payload', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(
        new ChatbotApiError('conflict', 409, {}, 'IDEMPOTENCY_KEY_CONFLICT'),
      ),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (h.api.createCheckout.mock.calls[0] as unknown[])[1],
    });
  });

  it.each([['BUSINESS_RULE_VIOLATION', 422]])(
    'rotates the key after a definite %s rejection',
    async (code, status) => {
      const h = setup();
      await h.seedCart();
      await confirmSavedDelivery(h);
      await offerOrder(h);
      h.api.createCheckout.mockImplementationOnce(() =>
        Promise.reject(new ChatbotApiError('rejected', status, {}, code)),
      );
      expect(await yes(h)).toEqual({ reply: MINIMAL_ORDER_REJECTED_REPLY });
      expect(await h.minimalCart()).toMatchObject({
        items: [{ productId: PRODUCT, quantity: 2 }],
        idempotencyKey: '',
      });
    },
  );

  it.each([
    'BOT_ITEM_VARIANT_REQUIRED',
    'BOT_ITEM_VARIANT_NOT_ALLOWED',
    'BOT_ITEM_VARIANT_MISMATCH',
  ])(
    '%s asks to choose the presentation again and rotates the key',
    async (code) => {
      const h = setup();
      await h.seedCart();
      await confirmSavedDelivery(h);
      await offerOrder(h);
      const rejection = new ChatbotApiError(code, 422, { error: code }, code);
      h.api.createCheckout.mockRejectedValueOnce(rejection);
      expect(await yes(h)).toEqual({
        reply: MINIMAL_ORDER_VARIANT_CHANGED_REPLY,
      });
      expect(await h.minimalCart()).toMatchObject({
        items: [{ productId: PRODUCT, quantity: 2 }],
        idempotencyKey: '',
      });
    },
  );

  it('STOCK_INSUFFICIENT_AT_CONFIRM says stock ran out and rotates the key', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    const code = 'STOCK_INSUFFICIENT_AT_CONFIRM';
    const rejection = new ChatbotApiError(code, 409, { error: code }, code);
    h.api.createCheckout.mockRejectedValueOnce(rejection);
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_STOCK_CHANGED_REPLY,
    });
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2 }],
      idempotencyKey: '',
    });
  });

  it.each([
    [
      SHIPPING_QUOTE_NOT_FOUND,
      404,
      MINIMAL_ORDER_SHIPPING_QUOTE_NOT_FOUND_REPLY,
    ],
    [PACKAGING_DATA_MISSING, 422, MINIMAL_ORDER_PACKAGING_MISSING_REPLY],
    [SHIPPING_QUOTE_UNAVAILABLE, 422, MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY],
    // G3: a 503 with this code is still a definite "nothing written".
    [SHIPPING_QUOTE_UNAVAILABLE, 503, MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY],
  ])(
    '[S6] %s gives its specific reply, creates nothing and rotates the key',
    async (code, status, reply) => {
      const h = setup({ shipping: true });
      await h.seedCart();
      await confirmSavedDelivery(h);
      await shippingRecord(h);
      await offerOrder(h);
      h.api.createCheckout.mockRejectedValueOnce(
        new ChatbotApiError(code, status, { error: code }, code),
      );
      expect(await yes(h)).toEqual({ reply });
      expect(await h.minimalCart()).toMatchObject({
        items: [{ productId: PRODUCT, quantity: 2 }],
        idempotencyKey: '',
      });
      expect(h.quotes.calls).toHaveLength(0);
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );

  it.each([SHIPPING_QUOTE_EXPIRED, SHIPPING_QUOTE_MISMATCH])(
    '[S6] %s re-quotes and shows the new total for a fresh SÍ',
    async (code) => {
      const h = setup({ shipping: true });
      await h.seedCart();
      await confirmSavedDelivery(h);
      await shippingRecord(h);
      await offerOrder(h);
      h.api.createCheckout.mockRejectedValueOnce(
        new ChatbotApiError(code, 409, { error: code }, code),
      );
      h.quotes.enqueue({
        quoteId: 'quote-2',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        zoneStatus: 'CARRIER_ONLY',
        option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
        costCents: 7000,
        creditCents: 0,
        customerChargeCents: 7000,
        currency: 'MXN',
        eta: { days: 2, reason: null },
      });
      const requoted = await yes(h);
      expect(requoted?.reply).toContain(MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY);
      expect(requoted?.reply).toContain('Total a pagar: $100.00 MXN');
      expect(h.quotes.calls).toHaveLength(1);
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      requoted?.onSent?.();
      await yes(h, 'wamid.fresh');
      expect(h.api.createCheckout).toHaveBeenCalledTimes(2);
      expect(
        (h.api.createCheckout.mock.calls[1] as unknown as [unknown])[0],
      ).toMatchObject({
        sale: { expectedTotalCents: 10000, shipping: { quoteId: 'quote-2' } },
      });
    },
  );

  describe('G3: SHIPPING_QUOTE_* after an earlier uncertain attempt', () => {
    const quoteRejection = (code: string, status: number) =>
      new ChatbotApiError(code, status, { error: code }, code);
    /** Attempt 1 times out (key kept), then the same summary is offered again. */
    const uncertainThenReoffer = async () => {
      const h = setup({ shipping: true });
      await h.seedCart();
      await confirmSavedDelivery(h);
      await shippingRecord(h);
      await offerOrder(h);
      h.api.createCheckout.mockImplementationOnce(() =>
        Promise.reject(new UpstreamError('timeout', 503)),
      );
      expect(await yes(h)).toEqual({
        reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
      });
      const key = (h.api.createCheckout.mock.calls[0] as unknown[])[1];
      await offerOrder(h, 'wamid.o3');
      return { h, key };
    };

    it('status shows no sale: clears the key and re-quotes for a fresh SÍ', async () => {
      const { h, key } = await uncertainThenReoffer();
      h.api.createCheckout.mockRejectedValueOnce(
        quoteRejection(SHIPPING_QUOTE_EXPIRED, 409),
      );
      h.quotes.enqueue({
        quoteId: 'quote-2',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        zoneStatus: 'CARRIER_ONLY',
        option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
        costCents: 7000,
        creditCents: 0,
        customerChargeCents: 7000,
        currency: 'MXN',
        eta: { days: 2, reason: null },
      });
      const requoted = await yes(h, 'wamid.o4');
      expect((h.api.createCheckout.mock.calls[1] as unknown[])[1]).toBe(key);
      expect(h.api.getCheckoutStatus).toHaveBeenLastCalledWith(key);
      expect(requoted?.reply).toContain(MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY);
      expect(h.quotes.calls).toHaveLength(1);
      expect(await h.minimalCart()).toMatchObject({ idempotencyKey: '' });
      // The re-quoted summary places under a NEW key, never held.
      requoted?.onSent?.();
      const placed = await yes(h, 'wamid.o5');
      expect(placed?.reply).toContain('folio B-0042');
      const third = (h.api.createCheckout.mock.calls[2] as unknown[])[1];
      expect(third).not.toBe(key);
    });

    it('status shows no sale: UNAVAILABLE clears the key with its specific reply', async () => {
      const { h } = await uncertainThenReoffer();
      h.api.createCheckout.mockRejectedValueOnce(
        quoteRejection(SHIPPING_QUOTE_UNAVAILABLE, 503),
      );
      expect(await yes(h, 'wamid.o4')).toEqual({
        reply: MINIMAL_ORDER_SHIPPING_UNAVAILABLE_REPLY,
      });
      expect(await h.minimalCart()).toMatchObject({
        items: [{ productId: PRODUCT, quantity: 2 }],
        idempotencyKey: '',
      });
    });

    it('status shows a sale under the key: completes it instead', async () => {
      const { h, key } = await uncertainThenReoffer();
      h.api.createCheckout.mockImplementationOnce(() => {
        h.api.getCheckoutStatus.mockResolvedValueOnce({
          status: 'succeeded',
          checkout: { status: 'created', sale: placedSale() },
        });
        return Promise.reject(quoteRejection(SHIPPING_QUOTE_UNAVAILABLE, 503));
      });
      const reply = await yes(h, 'wamid.o4');
      expect(h.api.getCheckoutStatus).toHaveBeenLastCalledWith(key);
      expect(reply?.reply).toContain('folio B-0042');
      expect(h.quotes.calls).toHaveLength(0);
      expect(await h.minimalCart()).toMatchObject({
        items: [],
        placedSale: { saleId: SALE },
      });
    });

    it('a failed status read keeps the key and stays unresolved', async () => {
      const { h, key } = await uncertainThenReoffer();
      h.api.createCheckout.mockImplementationOnce(() => {
        h.api.getCheckoutStatus.mockRejectedValueOnce(new Error('down'));
        return Promise.reject(quoteRejection(SHIPPING_QUOTE_EXPIRED, 409));
      });
      expect(await yes(h, 'wamid.o4')).toEqual({
        reply: MINIMAL_ORDER_UNRESOLVED_REPLY,
      });
      expect(h.quotes.calls).toHaveLength(0);
      expect(await h.minimalCart()).toMatchObject({
        idempotencyKey: key,
        idempotencyAttempts: 2,
      });
    });
  });

  it('[S6] a failed re-quote falls back to asking for a new quote', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    await offerOrder(h);
    const code = SHIPPING_QUOTE_EXPIRED;
    h.api.createCheckout.mockRejectedValueOnce(
      new ChatbotApiError(code, 409, { error: code }, code),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_SHIPPING_REQUOTE_REPLY,
    });
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('preserves the key while the backend reports the sale in flight', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(
        new ChatbotApiError('busy', 409, {}, 'IDEMPOTENCY_KEY_IN_FLIGHT'),
      ),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (h.api.createCheckout.mock.calls[0] as unknown[])[1],
    });
  });

  it('still reports the created order when payment details are unavailable', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.getPaymentDetails.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('down', 503)),
    );
    const placed = await yes(h);
    expect(placed?.reply).toContain('folio B-0042');
    expect(placed?.reply).not.toContain('CLABE');
    expect(placed?.reply).toContain(
      'No pude obtener los datos para la transferencia',
    );
  });

  it('refuses when the cart changed between presentation and the key write', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    const commit = h.store.commitMinimalCart.bind(h.store);
    jest
      .spyOn(h.store, 'commitMinimalCart')
      .mockImplementationOnce(() => Promise.resolve(false))
      .mockImplementation(commit);
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.cart_unverified,
    });
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('keeps the cart usable after an order was placed', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    await yes(h);
    const added = await h.cart.setItem(
      SENDER,
      { productId: PRODUCT, quantity: 1 },
      new Set([PRODUCT]),
    );
    expect(added).toMatchObject({ ok: true, totalCents: 1500 });
    expect(await h.minimalCart()).toEqual({
      items: [{ productId: PRODUCT, quantity: 1, unitPriceCents: 1500 }],
      idempotencyKey: '',
      expectedTotalCents: 1500,
    });
  });

  it('never rotates a key whose earlier attempt was uncertain', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('timeout', 503)),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    const firstKey = (h.api.createCheckout.mock.calls[0] as unknown[])[1];
    await offerOrder(h, 'wamid.o3');
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(new ChatbotApiError('unauthorized', 401, {}, null)),
    );
    expect(await yes(h, 'wamid.o4')).toEqual({
      reply: MINIMAL_ORDER_UNRESOLVED_REPLY,
    });
    expect((h.api.createCheckout.mock.calls[1] as unknown[])[1]).toBe(firstKey);
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2 }],
      idempotencyKey: firstKey,
      idempotencyAttempts: 2,
    });
  });

  it('refuses cart changes while an attempt is unresolved', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('timeout', 503)),
    );
    await yes(h);
    const before = await h.minimalCart();
    expect(
      await h.cart.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 2 },
        new Set([PRODUCT]),
      ),
    ).toEqual({ ok: false, error: 'order_unresolved' });
    expect(await h.minimalCart()).toEqual(before);
  });

  it('records the first attempt before calling the backend', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    let seen: unknown;
    h.api.createCheckout.mockImplementationOnce(async () => {
      seen = await h.minimalCart();
      throw new UpstreamError('timeout', 503);
    });
    await yes(h);
    expect(seen).toMatchObject({ idempotencyAttempts: 1 });
  });
});

describe('minimal store pickup order (U4, S4)', () => {
  it('[S4] pickup sends shipping {mode: pickup} with a products-only total', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    expect(await h.shipping.chooseStorePickup(SENDER)).toEqual({
      kind: 'pickup',
    });
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Recoge en tienda (sin costo de envío)');
    expect(offer.reply).toContain('Total de productos: $30.00 MXN');
    expect(offer.reply).not.toContain('Total a pagar');
    const result = await yes(h);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0];
    expect(payload.sale).toMatchObject({
      expectedTotalCents: 3000,
      shipping: { mode: 'pickup' },
    });
    expect(CreateCheckoutInputSchema.safeParse(payload).success).toBe(true);
    expect(result?.reply).toContain('Recoge en tienda (sin costo de envío)');
    expect(result?.reply).not.toContain('no está incluido');
  });

  it('[S4] a cart change invalidates the pickup choice', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await h.shipping.chooseStorePickup(SENDER);
    const changed = await h.cart.setItem(
      SENDER,
      { productId: PRODUCT, quantity: 3 },
      new Set([PRODUCT]),
    );
    expect(changed.ok).toBe(true);
    const offer = await offerOrder(h);
    expect(offer.reply).toBe(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY);
    await yes(h);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('[S4] a pickup pinned to older prices of the same lines backs the current summary', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    const raw = await h.minimalCart();
    await h.store.commitMinimalCart(
      SENDER,
      raw,
      {
        ...(raw as object),
        shipping: {
          mode: 'pickup',
          cartPin: [
            {
              productId: PRODUCT,
              quantity: 2,
              unitPriceCents: 1400,
              finalPriceCents: 2800,
            },
          ],
        },
      },
      new Date().toISOString(),
    );
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Recoge en tienda (sin costo de envío)');
    expect(offer.reply).toContain('Total de productos: $30.00 MXN');
  });

  it('[S4] a pickup pinned to other quantities does not back an order', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    const raw = await h.minimalCart();
    await h.store.commitMinimalCart(
      SENDER,
      raw,
      {
        ...(raw as object),
        shipping: {
          mode: 'pickup',
          cartPin: [
            {
              productId: PRODUCT,
              quantity: 3,
              unitPriceCents: 1500,
              finalPriceCents: 4500,
            },
          ],
        },
      },
      new Date().toISOString(),
    );
    expect((await offerOrder(h)).reply).toBe(
      MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY,
    );
  });

  it('[S4] the shipping-required reply offers a quote for the confirmed address or store pickup', () => {
    expect(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY).toContain(
      'dirección confirmada',
    );
    expect(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY).toContain(
      'recoger en tienda',
    );
    expect(MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY).toContain(
      'no se creó ningún pedido',
    );
  });
});

describe('store pickup without delivery data (C1)', () => {
  const nameOnly = (firstName: string, lastName: string | null = null) => ({
    label: null,
    firstName,
    lastName,
    street: null,
    exteriorNumber: null,
    interiorNumber: null,
    zipCode: null,
    neighborhood: null,
    municipality: null,
    city: null,
    state: null,
    visualReferences: null,
    carrierPhone: null,
    useNewAddress: false,
  });
  const location = {
    name: 'Sucursal Centro',
    address: {
      addressLine1: 'Av. Juárez 123',
      addressLine2: null,
      neighborhood: 'Centro',
      municipality: 'Cuauhtémoc',
      state: 'Ciudad de México',
      postalCode: '06000',
      formatted:
        'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
    },
    hours: {
      timeZone: 'America/Mexico_City',
      days: [],
      summary: 'Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
    },
  };
  const pickupCreated = (pickupLocation: unknown = location) => ({
    status: 'created',
    customer: {
      resolution: 'existing',
      customerId: CUSTOMER,
      firstName: 'Ana',
      lastName: null,
    },
    address: null,
    sale: { ...placedSale(), fulfillmentMode: 'PICKUP' },
    pickupLocation,
  });
  const payloadOf = (h: Harness, call = 0) =>
    (
      h.api.createCheckout.mock.calls[call] as unknown as [
        Record<string, unknown>,
      ]
    )[0];

  it('an existing customer orders pickup with no delivery confirmation and no deliveryAddress', async () => {
    const h = setup();
    await h.seedCart();
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Datos del cliente: Ana');
    expect(offer.reply).toContain('Recoge en tienda (sin costo de envío)');
    h.api.createCheckout.mockResolvedValueOnce(pickupCreated());
    await yes(h);
    const payload = payloadOf(h);
    expect(payload).not.toHaveProperty('deliveryAddress');
    expect(payload).toMatchObject({
      phoneCountryCode: '52',
      customer: { mode: 'existing', customerId: CUSTOMER },
      sale: { expectedTotalCents: 3000, shipping: { mode: 'pickup' } },
    });
    expect(CreateCheckoutInputSchema.safeParse(payload).success).toBe(true);
  });

  it('a new customer needs only a name and is sent as createIfAbsent', async () => {
    const h = setup();
    h.api.getCustomerCheckoutContext.mockResolvedValue({
      status: 'not_found',
      customer: null,
      addresses: [],
      nextAfterAddressId: null,
    } as unknown as CustomerCheckoutContext);
    await h.seedCart();
    expect((await offerOrder(h)).reply).toBe(
      MINIMAL_ORDER_PICKUP_NAME_REQUIRED_REPLY,
    );
    await h.checkout.updateDetails(SENDER, nameOnly('Luis', 'Pérez'));
    const offer = await offerOrder(h, 'wamid.o3');
    expect(offer.reply).toContain('Datos del cliente: Luis Pérez');
    await yes(h, 'wamid.o4');
    const payload = payloadOf(h);
    expect(payload).not.toHaveProperty('deliveryAddress');
    expect(payload).toMatchObject({
      phoneCountryCode: '52',
      customer: {
        mode: 'createIfAbsent',
        firstName: 'Luis',
        lastName: 'Pérez',
      },
      sale: { expectedTotalCents: 3000, shipping: { mode: 'pickup' } },
    });
    expect(CreateCheckoutInputSchema.safeParse(payload).success).toBe(true);
  });

  it('an ambiguous phone or a failed lookup offers no pickup summary', async () => {
    const h = setup();
    await h.seedCart();
    h.api.getCustomerCheckoutContext.mockResolvedValueOnce({
      status: 'ambiguous',
      customer: null,
      addresses: [],
      nextAfterAddressId: null,
    } as unknown as CustomerCheckoutContext);
    expect((await offerOrder(h)).reply).toBe(
      MINIMAL_ORDER_PHONE_AMBIGUOUS_REPLY,
    );
    h.api.getCustomerCheckoutContext.mockRejectedValueOnce(new Error('down'));
    expect((await offerOrder(h, 'wamid.o5')).reply).toBe(
      MINIMAL_ORDER_PICKUP_CUSTOMER_UNAVAILABLE_REPLY,
    );
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    [
      'address and hours',
      location,
      'Recójalo en Sucursal Centro: Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000.',
      'Horario: Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
    ],
    [
      'no hours',
      { ...location, hours: null },
      'Recójalo en Sucursal Centro: Av. Juárez 123',
      null,
    ],
    [
      'no address',
      { ...location, address: null },
      'Recójalo en Sucursal Centro.',
      'Horario:',
    ],
  ])(
    'the order-created reply shows the pickup location (%s)',
    async (_name, pickupLocation, place, hours) => {
      const h = setup();
      await h.seedCart();
      await offerOrder(h);
      h.api.createCheckout.mockResolvedValueOnce(pickupCreated(pickupLocation));
      const reply = (await yes(h))?.reply ?? '';
      expect(reply).toContain('folio B-0042');
      expect(reply).toContain(place);
      if (hours === null) expect(reply).not.toContain('Horario');
      else expect(reply).toContain(hours);
    },
  );

  it('omits the location when the response has none', async () => {
    const h = setup();
    await h.seedCart();
    await offerOrder(h);
    const reply = (await yes(h))?.reply ?? '';
    expect(reply).toContain('folio B-0042');
    expect(reply).not.toContain('Recójalo');
  });
});

describe('checkout quote errors (C1)', () => {
  const alreadyUsed = () =>
    new ChatbotApiError(
      'used',
      409,
      {
        statusCode: 409,
        error: SHIPPING_QUOTE_ALREADY_USED,
        message: SHIPPING_QUOTE_ALREADY_USED,
      },
      SHIPPING_QUOTE_ALREADY_USED,
    );
  async function deliveryOffer() {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    await offerOrder(h);
    return h;
  }
  const newQuote = {
    quoteId: 'quote-2',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    zoneStatus: 'CARRIER_ONLY' as const,
    option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
    costCents: 7000,
    creditCents: 0,
    customerChargeCents: 7000,
    currency: 'MXN' as const,
    eta: { days: 2, reason: null },
  };

  it('ALREADY_USED recovers our own sale through /checkouts/status', async () => {
    const h = await deliveryOffer();
    h.api.createCheckout.mockRejectedValueOnce(alreadyUsed());
    h.api.getCheckoutStatus.mockResolvedValueOnce({
      status: 'succeeded',
      checkout: { status: 'created', sale: placedSale() },
    });
    const reply = await yes(h);
    const key = (h.api.createCheckout.mock.calls[0] as unknown[])[1];
    expect(h.api.getCheckoutStatus).toHaveBeenLastCalledWith(key);
    expect(reply?.reply).toContain('folio B-0042');
    expect(h.quotes.calls).toHaveLength(0);
    expect(await h.minimalCart()).toMatchObject({
      items: [],
      placedSale: { saleId: SALE },
    });
  });

  it('ALREADY_USED without our sale re-quotes once and shows the new summary', async () => {
    const h = await deliveryOffer();
    h.api.createCheckout.mockRejectedValueOnce(alreadyUsed());
    h.quotes.enqueue(newQuote);
    const requoted = await yes(h);
    expect(requoted?.reply).toContain(MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY);
    expect(requoted?.reply).toContain('Total a pagar: $100.00 MXN');
    expect(h.quotes.calls).toHaveLength(1);
    expect(await h.minimalCart()).toMatchObject({ idempotencyKey: '' });
  });

  it('MISMATCH on CUSTOMER re-checks the customer instead of re-quoting', async () => {
    const h = await deliveryOffer();
    const code = SHIPPING_QUOTE_MISMATCH;
    h.api.createCheckout.mockRejectedValueOnce(
      new ChatbotApiError(
        code,
        409,
        {
          statusCode: 409,
          error: code,
          message: code,
          mismatches: ['CUSTOMER', 'LINES'],
        },
        code,
      ),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_CUSTOMER_RECHECK_REPLY,
    });
    expect(h.quotes.calls).toHaveLength(0);
    expect(h.checkout.confirmationStatus(SENDER)).toBeNull();
    // The quote has no customer pin: kept, it would be resent after the
    // customer re-selects the same address and fail the same way.
    const cart = await h.minimalCart();
    expect(cart).toMatchObject({ idempotencyKey: '' });
    expect(cart).not.toHaveProperty('shipping');
  });

  it('an invalid 201 recovers our sale through /checkouts/status at once (R3-strict-receipt)', async () => {
    const h = setup();
    await h.seedCart();
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(
      new UpstreamError('invalid', 201, {}, null),
    );
    h.api.getCheckoutStatus.mockResolvedValueOnce({
      status: 'succeeded_unverified',
      checkout: {
        sale: { saleId: SALE, folio: 'B-0042', totalCents: 3000 },
      },
    });
    const reply = await yes(h);
    expect(reply?.reply).toContain('folio B-0042');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toMatchObject({
      items: [],
      placedSale: { saleId: SALE, folio: 'B-0042', totalCents: 3000 },
    });
  });

  it('an invalid 201 with a failed status read recovers on the next turn, without a second POST', async () => {
    const h = setup();
    await h.seedCart();
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(
      new UpstreamError('invalid', 201, {}, null),
    );
    h.api.getCheckoutStatus.mockRejectedValueOnce(new Error('down'));
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    h.api.getCheckoutStatus.mockResolvedValueOnce({
      status: 'succeeded_unverified',
      checkout: {
        sale: { saleId: SALE, folio: 'B-0042', totalCents: 3000 },
      },
    });
    const next = await h.order.consume({ senderId: SENDER, text: 'hola' });
    expect(next?.reply).toContain('folio B-0042');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  describe('PROMO_RE_QUOTE (F5): a promotion changed between the summary and the SÍ', () => {
    const promoReQuote = () =>
      new ChatbotApiError(
        'PROMO_RE_QUOTE',
        409,
        { statusCode: 409, error: 'PROMO_RE_QUOTE' },
        'PROMO_RE_QUOTE',
      );
    /** The promotion now prices each unit at $12.50 instead of $15.00. */
    const promotionChanges = (h: Harness) =>
      h.api.evaluateCart.mockImplementation(
        (items: Array<{ quantity: number }>) =>
          Promise.resolve({
            items: items.map((item) => ({
              productId: PRODUCT,
              variantId: null,
              quantity: item.quantity,
              unitPriceCents: 1500,
              originalPriceCents: 1500 * item.quantity,
              finalPriceCents: 1250 * item.quantity,
              discountAmountCents: 250 * item.quantity,
              appliedPromotionTitle: null,
            })),
            promotionEvaluationStatus: 'fully_evaluated',
          }),
      );

    it('pickup: re-prices and re-presents the summary for a fresh SÍ under a new key', async () => {
      const h = setup();
      await h.seedCart();
      await offerOrder(h);
      h.api.createCheckout.mockImplementationOnce(() => {
        // The promotion ends while the POST is verified.
        promotionChanges(h);
        return Promise.reject(promoReQuote());
      });
      const reply = await yes(h);
      expect(reply?.reply.startsWith(MINIMAL_ORDER_CHANGED_REPLY)).toBe(true);
      expect(reply?.reply).toContain('$25.00');
      expect(reply?.onSent).toBeDefined();
      const firstKey = (h.api.createCheckout.mock.calls[0] as unknown[])[1];
      expect(await h.minimalCart()).toMatchObject({ idempotencyKey: '' });
      reply?.onSent?.();
      h.api.createCheckout.mockResolvedValueOnce({
        status: 'created',
        customer: {
          resolution: 'existing',
          customerId: CUSTOMER,
          firstName: 'Ana',
          lastName: null,
        },
        address: null,
        sale: { ...placedSale(), fulfillmentMode: 'PICKUP' },
        pickupLocation: null,
      });
      expect((await yes(h, 'wamid.o9'))?.reply).toContain('folio B-0042');
      const [payload, key] = h.api.createCheckout.mock.calls[1] as unknown as [
        { sale: { expectedTotalCents: number } },
        string,
      ];
      expect(payload.sale.expectedTotalCents).toBe(2500);
      expect(key).not.toBe(firstKey);
    });

    it('delivery: re-prices, re-quotes the shipping once and re-presents the summary', async () => {
      const h = await deliveryOffer();
      h.api.createCheckout.mockImplementationOnce(() => {
        // The promotion ends while the POST is verified.
        promotionChanges(h);
        return Promise.reject(promoReQuote());
      });
      h.quotes.enqueue(newQuote);
      const reply = await yes(h);
      expect(reply?.reply.startsWith(MINIMAL_ORDER_CHANGED_REPLY)).toBe(true);
      expect(reply?.reply).toContain('Total a pagar: $95.00 MXN');
      expect(reply?.onSent).toBeDefined();
      expect(h.quotes.calls).toHaveLength(1);
      expect(await h.minimalCart()).toMatchObject({
        idempotencyKey: '',
        shipping: { quoteId: 'quote-2' },
      });
    });

    it('after an earlier uncertain attempt the key is held, nothing re-presented', async () => {
      const h = setup();
      await h.seedCart();
      await offerOrder(h);
      h.api.createCheckout.mockRejectedValueOnce(new Error('network'));
      await yes(h);
      h.api.getCheckoutStatus.mockResolvedValue({
        status: 'not_observed',
        checkout: null,
      });
      await offerOrder(h, 'wamid.p1');
      h.api.createCheckout.mockRejectedValueOnce(promoReQuote());
      expect(await yes(h, 'wamid.p2')).toEqual({
        reply: MINIMAL_ORDER_UNRESOLVED_REPLY,
      });
      expect(await h.minimalCart()).toMatchObject({ idempotencyAttempts: 2 });
    });
  });

  it('MISMATCH on LINES re-quotes', async () => {
    const h = await deliveryOffer();
    const code = SHIPPING_QUOTE_MISMATCH;
    h.api.createCheckout.mockRejectedValueOnce(
      new ChatbotApiError(
        code,
        409,
        { statusCode: 409, error: code, message: code, mismatches: ['LINES'] },
        code,
      ),
    );
    h.quotes.enqueue(newQuote);
    expect((await yes(h))?.reply).toContain(
      MINIMAL_ORDER_SHIPPING_REQUOTED_REPLY,
    );
    expect(h.quotes.calls).toHaveLength(1);
  });

  it('INVALID_CHECKOUT_REQUEST is a logged, generic, definite rejection', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = setup();
    await h.seedCart();
    await offerOrder(h);
    h.api.createCheckout.mockRejectedValueOnce(
      new ChatbotApiError(
        'bad',
        400,
        {
          statusCode: 400,
          error: INVALID_CHECKOUT_REQUEST,
          message: 'no deliveryAddress',
        },
        INVALID_CHECKOUT_REQUEST,
      ),
    );
    expect(await yes(h)).toEqual({ reply: MINIMAL_ORDER_REJECTED_REPLY });
    expect(await h.minimalCart()).toMatchObject({ idempotencyKey: '' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(INVALID_CHECKOUT_REQUEST),
    );
    warn.mockRestore();
  });
});
