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
  MINIMAL_ORDER_UNRESOLVED_REPLY,
  MinimalOrderService,
} from './minimal-order.service';
import { MINIMAL_ORDER_AMBIGUOUS_REPLY } from '../domain/minimal-order-confirmation';
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

function setup(options: { enabled?: boolean; cashier?: string } = {}) {
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
    createSale: jest.fn(() =>
      Promise.resolve({
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
      }),
    ),
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
    attachReceipt: jest.fn(),
    cancelSale: jest.fn(),
    updateDelivery: jest.fn(),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) => {
      if (key === 'minimalCatalogAgent')
        return { orderEnabled: options.enabled !== false };
      if (key === 'chatbotApi.cashierUserId') return options.cashier ?? CASHIER;
      return undefined;
    },
  } as unknown as ConfigService;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const order = new MinimalOrderService(client, store, cart, checkout, config);
  return {
    store,
    api,
    cart,
    checkout,
    order,
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

describe('MinimalOrderService', () => {
  it('is disabled unless the gate and a cashier are configured', () => {
    expect(setup({ enabled: false }).order.enabled).toBe(false);
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
    expect(h.api.createSale).not.toHaveBeenCalled();

    const placed = await yes(h);
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    const [payload, key] = h.api.createSale.mock.calls[0] as unknown as [
      unknown,
      string,
    ];
    expect(payload).toEqual({
      cashierUserId: CASHIER,
      customerId: CUSTOMER,
      shippingAddressId: ADDRESS,
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
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    expect(h.api.upsertCustomer).not.toHaveBeenCalled();
  });

  it('never creates a sale before the summary was sent', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await h.order.prepareOrder(SENDER, EVENT('wamid.o1'));
    expect(await yes(h)).toEqual({ reply: MINIMAL_ORDER_AMBIGUOUS_REPLY });
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it.each([
    ['delivery_unconfirmed', false, true],
    ['empty_cart', true, false],
  ] as const)(
    'explains %s without creating a sale',
    async (reason, confirm, seed) => {
      const h = setup();
      if (seed) await h.seedCart();
      if (confirm) await confirmSavedDelivery(h);
      expect(await h.order.prepareOrder(SENDER, EVENT('wamid.o1'))).toEqual({
        reply: MINIMAL_ORDER_INELIGIBLE_REPLIES[reason],
      });
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );

  it('refuses a new (unsaved) delivery address in this slice', async () => {
    const h = setup();
    await h.seedCart();
    await h.checkout.updateDetails(SENDER, {
      firstName: 'Ana',
      lastName: null,
      label: null,
      street: 'Calle 5',
      exteriorNumber: 'S/N',
      interiorNumber: null,
      zipCode: '06700',
      neighborhood: 'Roma',
      municipality: null,
      city: 'CDMX',
      state: 'Ciudad de México',
      visualReferences: null,
      carrierPhone: null,
      useNewAddress: true,
    });
    const offer = await h.checkout.prepareConfirmation(
      SENDER,
      EVENT('wamid.d1'),
    );
    offer.onSent?.();
    await h.checkout.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.d2'),
    });
    expect(await h.order.prepareOrder(SENDER, EVENT('wamid.o1'))).toEqual({
      reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.new_address_unsupported,
    });
    expect(h.api.createSale).not.toHaveBeenCalled();
    expect(h.api.upsertCustomer).not.toHaveBeenCalled();
  });

  it('re-presents instead of selling when prices changed after the summary', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.setPrice(1600);
    const result = await yes(h);
    expect(result?.reply.startsWith(MINIMAL_ORDER_CHANGED_REPLY)).toBe(true);
    expect(result?.reply).toContain('Total de productos: $32.00 MXN');
    expect(result?.onSent).toEqual(expect.any(Function));
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('refuses when the delivery draft changed after the summary', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
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
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_INELIGIBLE_REPLIES.delivery_unconfirmed,
    });
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('asks to re-select when the saved address changed upstream', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.getCustomerCheckoutContext.mockImplementation(() =>
      Promise.resolve(
        unique(savedAddress({ version: '2026-10-02T00:00:00.000Z' })),
      ),
    );
    expect(await yes(h)).toEqual({ reply: MINIMAL_CHECKOUT_RESELECT_REPLY });
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('keeps the idempotency key after an ambiguous failure and reuses it', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createSale.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('timeout', 503)),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    const firstKey = (h.api.createSale.mock.calls[0] as unknown[])[1];
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2 }],
      idempotencyKey: firstKey,
    });
    await offerOrder(h, 'wamid.o3');
    await yes(h, 'wamid.o4');
    expect(h.api.createSale).toHaveBeenCalledTimes(2);
    expect((h.api.createSale.mock.calls[1] as unknown[])[1]).toBe(firstKey);
  });

  it('never sends a different payload under an outstanding key', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createSale.mockImplementationOnce(() =>
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
    await offerOrder(h, 'wamid.o3');
    expect(await yes(h, 'wamid.o4')).toEqual({
      reply: MINIMAL_ORDER_HELD_REPLY,
    });
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toEqual(before);
  });

  it('keeps the key when the backend saw it with another payload', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createSale.mockImplementationOnce(() =>
      Promise.reject(
        new ChatbotApiError('conflict', 409, {}, 'IDEMPOTENCY_KEY_CONFLICT'),
      ),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (h.api.createSale.mock.calls[0] as unknown[])[1],
    });
  });

  it.each([
    ['PROMO_RE_QUOTE', 409],
    ['BUSINESS_RULE_VIOLATION', 422],
  ])('rotates the key after a definite %s rejection', async (code, status) => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createSale.mockImplementationOnce(() =>
      Promise.reject(new ChatbotApiError('rejected', status, {}, code)),
    );
    expect(await yes(h)).toEqual({ reply: MINIMAL_ORDER_REJECTED_REPLY });
    expect(await h.minimalCart()).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2 }],
      idempotencyKey: '',
    });
  });

  it('preserves the key while the backend reports the sale in flight', async () => {
    const h = setup();
    await h.seedCart();
    await confirmSavedDelivery(h);
    await offerOrder(h);
    h.api.createSale.mockImplementationOnce(() =>
      Promise.reject(
        new ChatbotApiError('busy', 409, {}, 'IDEMPOTENCY_KEY_IN_FLIGHT'),
      ),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (h.api.createSale.mock.calls[0] as unknown[])[1],
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
    expect(h.api.createSale).not.toHaveBeenCalled();
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
    h.api.createSale.mockImplementationOnce(() =>
      Promise.reject(new UpstreamError('timeout', 503)),
    );
    expect(await yes(h)).toEqual({
      reply: MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
    });
    const firstKey = (h.api.createSale.mock.calls[0] as unknown[])[1];
    await offerOrder(h, 'wamid.o3');
    h.api.createSale.mockImplementationOnce(() =>
      Promise.reject(new ChatbotApiError('unauthorized', 401, {}, null)),
    );
    expect(await yes(h, 'wamid.o4')).toEqual({
      reply: MINIMAL_ORDER_UNRESOLVED_REPLY,
    });
    expect((h.api.createSale.mock.calls[1] as unknown[])[1]).toBe(firstKey);
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
    h.api.createSale.mockImplementationOnce(() =>
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
    h.api.createSale.mockImplementationOnce(async () => {
      seen = await h.minimalCart();
      throw new UpstreamError('timeout', 503);
    });
    await yes(h);
    expect(seen).toMatchObject({ idempotencyAttempts: 1 });
  });
});
