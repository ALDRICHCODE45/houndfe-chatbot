import { createHash } from 'node:crypto';
import { CreateCheckoutInputSchema } from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  minimalShippingDestination,
  type MinimalShipping,
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

function setup(
  options: {
    enabled?: boolean;
    cashier?: string;
    shipping?: boolean;
    atomic?: unknown;
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
    attachReceipt: jest.fn(),
    cancelSale: jest.fn(),
    updateDelivery: jest.fn(),
  };
  api.createCheckout.mockImplementation(async () => ({
    status: 'created',
    sale: await api.createSale.getMockImplementation()!(),
  }));
  api.getCheckoutStatus.mockResolvedValue({
    status: 'not_observed',
    checkout: null,
  });
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) => {
      if (key === 'minimalCatalogAgent')
        return {
          orderEnabled: options.enabled !== false,
          shippingEnabled: options.shipping === true,
          atomicCheckoutEnabled: options.atomic,
        };
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

async function shippingRecord(
  h: Harness,
  overrides: Partial<MinimalShipping> = {},
) {
  const raw = await h.minimalCart();
  const cart = raw as { items: MinimalShipping['cartLines'] };
  const now = Date.now();
  const shipping: MinimalShipping = {
    quoteId: 'quote-1',
    rateId: 'rate-1',
    carrierName: 'Carrier',
    serviceName: 'Ground',
    estimatedDeliveryDays: 2,
    bestRateCents: 5000,
    totalCreditCents: 0,
    customerPaysCents: 5000,
    cartLines: cart.items.map((line) => ({
      ...line,
      finalPriceCents: line.unitPriceCents * line.quantity,
    })),
    addressId: ADDRESS,
    addressVersion: savedAddress().version,
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    approval: {
      state: 'approved',
      requestId: 'approval-1',
      decidedAt: new Date(now).toISOString(),
    },
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
  const legacy = await shippingRecord(h);
  if (!('addressId' in legacy)) throw new Error('fixture');
  const { addressId, addressVersion, ...record } = legacy;
  void addressId;
  void addressVersion;
  const draft = (await h.checkout.confirmedDraft(SENDER))!;
  const raw = await h.minimalCart();
  await h.store.commitMinimalCart(
    SENDER,
    raw,
    {
      ...(raw as object),
      shipping: {
        ...record,
        destination: minimalShippingDestination(draft.address),
        ...(free ? { totalCreditCents: 24000, customerPaysCents: 0 } : {}),
      },
    },
    new Date().toISOString(),
  );
}

describe('new customer checkout S2/S3/S4/S6', () => {
  it.each(['expired', 'rejected'])(
    'new shipping %s blocks the summary',
    async (status) => {
      const h = setup({ atomic: true, shipping: true });
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
              : {
                  approval: {
                    state: 'rejected',
                    requestId: 'approval-1',
                    decidedAt: new Date().toISOString(),
                  },
                }),
          },
        },
        new Date().toISOString(),
      );
      expect((await offerOrder(h)).onSent).toBeUndefined();
      expect(h.api.createCheckout).not.toHaveBeenCalled();
    },
  );
  it('not_observed retries the identical new checkout and key under fresh consent', async () => {
    const h = setup({ atomic: true });
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
  it.each([false, true])('atomic switch %s', async (atomic) => {
    const h = setup({ atomic });
    await h.seedCart();
    await confirmNewDelivery(h);
    const offer = await offerOrder(h);
    if (!atomic)
      expect(offer.reply).toBe(
        MINIMAL_ORDER_INELIGIBLE_REPLIES.new_address_unsupported,
      );
    else
      expect(offer.reply).toContain(
        'Guardaremos esta dirección con su pedido.',
      );
  });
  it.each([false, true])(
    'exact new payload with free shipping %s passes real schema',
    async (free) => {
      const h = setup({ atomic: true, shipping: true });
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
      if (parsed.deliveryAddress.mode !== 'newSaved')
        throw new Error('payload');
      for (const key of [
        'label',
        'interiorNumber',
        'municipality',
        'visualReferences',
        'carrierPhone',
      ])
        expect(parsed.deliveryAddress.address).not.toHaveProperty(key);
      expect(parsed.sale.shipping).toEqual(
        free
          ? undefined
          : { chargeCents: 5000, approvalId: 'approval-1', quoteId: 'quote-1' },
      );
      expect(h.api.createSale).not.toHaveBeenCalled();
      expect(h.api.upsertCustomer).not.toHaveBeenCalled();
    },
  );
  it('unique registered customer with NEW uses createIfAbsent', async () => {
    const h = setup({ atomic: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await confirmNewDelivery(h);
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
    const h = setup({ atomic: true });
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
      const h = setup({ atomic: true });
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
    const h = setup({ atomic: true });
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
      checkout: { sale: await h.api.createSale.getMockImplementation()!() },
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
    const h = setup({ atomic: true });
    await h.seedCart();
    await confirmNewDelivery(h);
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
    await offerOrder(h, 'edited');
    expect((await yes(h, 'editedYes'))?.reply).toBe(MINIMAL_ORDER_HELD_REPLY);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('NEW shipping freshness only (T1)', () => {
  it('accepts approved current NEW shipping, rejects edits, and requires a persisted quote', async () => {
    const h = setup({ atomic: true, shipping: true });
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
    const legacy = await shippingRecord(h);
    if (!('addressId' in legacy)) throw new Error('legacy fixture');
    const { addressId, addressVersion, ...rest } = legacy;
    void addressId;
    void addressVersion;
    const shipping = {
      ...rest,
      destination: minimalShippingDestination(draft.address),
    };
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
        classification: 'charged',
        chargeCents: 5000,
        approvalId: 'approval-1',
        quoteId: 'quote-1',
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
            approval: { state: 'pending', requestId: 'approval-1' },
          },
        },
        snapshot,
      ),
    ).toBeNull();
    expect((await h.order.prepareOrder(SENDER, EVENT('order-new'))).reply).toBe(
      'Antes de crear el pedido, solicite y confirme el envío con una cotización vigente aprobada por el equipo. No se creó ningún pedido.',
    );
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
});

describe('atomic checkout order S1–S5', () => {
  async function ready(shipping = false) {
    const h = setup({ atomic: true, shipping });
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
        checkout: { sale: await h.api.createSale.getMockImplementation()!() },
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
      checkout: { sale: await h.api.createSale.getMockImplementation()!() },
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
        shipping: {
          chargeCents: 5000,
          approvalId: 'approval-1',
          quoteId: 'quote-1',
        },
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

  it('S3/S4 approved free shipping omits freight in checkout', async () => {
    const h = setup({ atomic: true, shipping: true });
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
    await shippingRecord(h, { totalCreditCents: 24000, customerPaysCents: 0 });
    await offerOrder(h);
    expect((await yes(h))?.reply).toContain('envío cubierto por su compra');
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0];
    expect(payload.sale).toMatchObject({ expectedTotalCents: 120000 });
    expect(payload.sale).not.toHaveProperty('shipping');
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
    await offerOrder(h, 'wamid.changed1');
    expect((await yes(h, 'wamid.changed2'))?.reply).toBe(
      MINIMAL_ORDER_HELD_REPLY,
    );
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.api.getCheckoutStatus).toHaveBeenCalled();
    expect(await h.minimalCart()).toMatchObject({ idempotencyAttempts: 1 });
  });

  it.each([false, undefined, 'true'])(
    'S2 gate %s preserves legacy path',
    async (atomic) => {
      const h = setup({ atomic });
      await h.seedCart();
      await confirmSavedDelivery(h);
      await offerOrder(h);
      await yes(h);
      expect(h.api.createSale).toHaveBeenCalledTimes(1);
      expect(h.api.createCheckout).not.toHaveBeenCalled();
      expect(h.api.getCheckoutStatus).not.toHaveBeenCalled();
    },
  );

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
    'SHIPPING_APPROVAL_ALREADY_USED',
    'SHIPPING_CHARGE_UNAVAILABLE',
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
    if (code === 'ADDRESS_VERSION_CONFLICT')
      expect(reply).toContain('confirme');
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
          checkout: { sale: await h.api.createSale.getMockImplementation()!() },
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
  it('S1/S4: sends approved freight in the exact fingerprinted payload', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    h.api.createSale.mockRejectedValueOnce(new Error('uncertain'));
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('Envío: $50.00 MXN');
    expect(offer.reply).toContain('Total a pagar: $80.00 MXN');
    await yes(h);
    const payload = (h.api.createSale.mock.calls[0] as unknown as [unknown])[0];
    expect(payload).toMatchObject({
      expectedTotalCents: 8000,
      shipping: {
        chargeCents: 5000,
        approvalId: 'approval-1',
        quoteId: 'quote-1',
      },
    });
    expect(await h.minimalCart()).toMatchObject({
      idempotencyAttempts: 1,
      idempotencyFingerprint: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    });
    const firstKey = (
      h.api.createSale.mock.calls[0] as unknown as [unknown, string]
    )[1];
    h.api.createSale.mockRejectedValueOnce(new Error('still uncertain'));
    await offerOrder(h, 'wamid.retry1');
    await yes(h, 'wamid.retry2');
    expect(
      h.api.createSale.mock.calls[1] as unknown as [unknown, string],
    ).toEqual([payload, firstKey]);
    expect(await h.minimalCart()).toMatchObject({ idempotencyAttempts: 2 });
  });

  it('S2: approved covered shipping omits the shipping payload and disclaimer', async () => {
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
    await shippingRecord(h, { totalCreditCents: 24000, customerPaysCents: 0 });
    const offer = await offerOrder(h);
    expect(offer.reply).toContain('envío cubierto por su compra');
    expect(offer.reply).not.toContain('Envío:');
    expect(offer.reply).not.toContain('no está incluido');
    const result = await yes(h);
    expect(
      (h.api.createSale.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({ expectedTotalCents: 120000 });
    expect(
      (h.api.createSale.mock.calls[0] as unknown as [unknown])[0],
    ).not.toHaveProperty('shipping');
    expect(result?.reply).not.toContain('no está incluido');
  });

  it.each([
    'missing',
    'not_requested',
    'pending',
    'rejected',
    'expired',
    'ttl',
    'cart',
    'address',
    'version',
  ] as const)(
    'S1/S6: refuses %s shipping before summary and sale',
    async (state) => {
      const h = setup({ shipping: true });
      await h.seedCart();
      await confirmSavedDelivery(h);
      await shippingRecord(h);
      await offerOrder(h);
      if (state === 'missing') {
        const raw = await h.minimalCart();
        const next = { ...(raw as Record<string, unknown>) };
        delete next.shipping;
        await h.store.commitMinimalCart(
          SENDER,
          raw,
          next,
          new Date().toISOString(),
        );
      } else {
        const record = await shippingRecord(h);
        const changes: Partial<
          Extract<MinimalShipping, { addressId: string }>
        > = {};
        if (state === 'not_requested' || state === 'expired')
          changes.approval = { state };
        if (state === 'pending')
          changes.approval = { state, requestId: 'approval-1' };
        if (state === 'rejected')
          changes.approval = {
            state,
            requestId: 'approval-1',
            decidedAt: record.createdAt,
          };
        if (state === 'ttl') {
          changes.createdAt = new Date(Date.now() - 120000).toISOString();
          changes.expiresAt = new Date(Date.now() - 60000).toISOString();
          changes.approval = {
            state: 'approved',
            requestId: 'approval-1',
            decidedAt: changes.createdAt,
          };
        }
        if (state === 'cart')
          changes.cartLines = record.cartLines.map((line) => ({
            ...line,
            finalPriceCents: 2900,
          }));
        if (state === 'address') changes.addressId = CUSTOMER;
        if (state === 'version')
          changes.addressVersion = '2026-10-02T00:00:00.000Z';
        await shippingRecord(h, { ...record, ...changes });
      }
      const refusal = await yes(h);
      expect(refusal?.reply).toMatch(/solicite.*confirme.*envío/);
      const offer = await offerOrder(h, 'wamid.recheck');
      expect(offer.reply).toMatch(/solicite.*confirme.*envío/);
      expect(offer.onSent).toBeUndefined();
      await yes(h);
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );

  it('S4: freight changes spend consent and re-present the summary', async () => {
    const h = setup({ shipping: true });
    await h.seedCart();
    await confirmSavedDelivery(h);
    await shippingRecord(h);
    await offerOrder(h);
    await shippingRecord(h, { bestRateCents: 6000, customerPaysCents: 6000 });
    const result = await yes(h);
    expect(result?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(result?.reply).toContain('Total a pagar: $90.00 MXN');
    expect(h.api.createSale).not.toHaveBeenCalled();
    result?.onSent?.();
    await yes(h, 'wamid.o3');
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
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
    h.api.createSale.mockRejectedValueOnce(new Error('uncertain'));
    await offerOrder(h);
    await yes(h);
    const before = await h.minimalCart();
    await shippingRecord(h, { bestRateCents: 6000, customerPaysCents: 6000 });
    await offerOrder(h, 'wamid.retry1');
    expect(await yes(h, 'wamid.retry2')).toEqual({
      reply: MINIMAL_ORDER_HELD_REPLY,
    });
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    expect(await h.minimalCart()).toMatchObject({
      idempotencyKey: (before as { idempotencyKey: string }).idempotencyKey,
      idempotencyAttempts: 1,
    });
  });
});

describe('MinimalOrderService', () => {
  it.each([false, true])(
    '[S5] discounted display leaves the exact payload, fingerprint and retry key unchanged (atomic %s)',
    async (atomic) => {
      const h = setup({ atomic });
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
        customerId: CUSTOMER,
        shippingAddressId: ADDRESS,
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
      };
      const expectedPayload = atomic
        ? CreateCheckoutInputSchema.parse({
            phoneCountryCode: '52',
            phone: '5550001111',
            customer: { mode: 'existing', customerId: CUSTOMER },
            deliveryAddress: {
              mode: 'existing',
              addressId: ADDRESS,
              expectedVersion: savedAddress().version,
            },
            sale: {
              cashierUserId: sale.cashierUserId,
              expectedTotalCents: sale.expectedTotalCents,
              items: sale.items,
            },
          })
        : sale;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(expectedPayload))
        .digest('hex');
      for (const attempt of [1, 2]) {
        const offer = await offerOrder(h, `promo-offer-${attempt}`);
        expect(offer.reply).toContain(
          `• Ibuprofeno: 2 × $15.00 MXN; importe $27.00 MXN (promoción: ${title}, ahorro $3.00 MXN)`,
        );
        if (atomic)
          h.api.createCheckout.mockRejectedValueOnce(
            new Error('lost response'),
          );
        else h.api.createSale.mockRejectedValueOnce(new Error('lost response'));
        await yes(h, `promo-yes-${attempt}`);
        expect(await h.minimalCart()).toMatchObject({
          idempotencyFingerprint: fingerprint,
          idempotencyAttempts: attempt,
        });
        title = 'Renamed offer';
      }
      const calls = atomic
        ? h.api.createCheckout.mock.calls
        : h.api.createSale.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([expectedPayload, expect.stringMatching(UUID)]);
      expect(calls[1]).toEqual(calls[0]);
    },
  );

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
