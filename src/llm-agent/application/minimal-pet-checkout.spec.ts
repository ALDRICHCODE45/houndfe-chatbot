import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CreateCheckoutInput } from '../../chatbot-api/domain/dtos/checkout.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import {
  renderMinimalOrderSummary,
  sameMinimalOrder,
  type MinimalOrderSnapshot,
} from '../domain/minimal-order-confirmation';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import {
  MINIMAL_ORDER_UNRESOLVED_REPLY,
  MinimalOrderService,
} from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';
import {
  BO_CROQUETAS,
  BO_PRODUCT,
  BO_SENDER,
  backorderCartLine,
} from './minimal-backorder-checkout.fixtures';

/**
 * Multi-pet T5a (S9, S16, R4): the checkout sends `petId` only on the lines
 * that carry a pet; the summary names the pet; a stale pet (archived, gone,
 * another customer's) never blocks the order: the pets are removed and the
 * same order is resent under a new key. A pet-less cart sends today's bytes.
 */
const SENDER = BO_SENDER;
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const SALE = '55555555-5555-4555-8555-555555555555';
const MAX = { id: 'a0000000-0000-4000-8000-000000000050', name: 'Max' };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATALOG: Record<string, { name: string; price: number }> = {
  [BO_PRODUCT]: { name: 'Ibuprofeno', price: 1500 },
  [BO_CROQUETAS]: { name: 'Croquetas Adulto 18 kg', price: 120000 },
};
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
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
interface Line {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  pet?: { id: string; name: string };
  backorder?: object;
}
const refusal = (status: number, error: string) =>
  new ChatbotApiError(error, status, { statusCode: status, error }, error);

function setup() {
  const store = new InMemoryConversationStore();
  const gateStore = new InMemoryConversationGateStore();
  const api = {
    searchCatalog: jest.fn((name: string) => {
      const [productId, entry] = Object.entries(CATALOG).find(
        ([, v]) => v.name === name,
      )!;
      return Promise.resolve([
        {
          productId,
          name: entry.name,
          price: { priceCents: entry.price },
          variants: [],
        },
      ]);
    }),
    getStock: jest.fn((productId: string) =>
      Promise.resolve({
        productId,
        name: CATALOG[productId].name,
        stock: { status: 'available', quantity: 10 },
        variants: [],
      }),
    ),
    evaluateCart: jest.fn(
      (
        items: Array<{
          productId: string;
          quantity: number;
          unitPriceCents: number;
        }>,
      ) =>
        Promise.resolve({
          items: items.map((item) => ({
            productId: item.productId,
            variantId: null,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            originalPriceCents: item.unitPriceCents * item.quantity,
            finalPriceCents: item.unitPriceCents * item.quantity,
            discountAmountCents: 0,
            appliedPromotionTitle: null,
          })),
          promotionEvaluationStatus: 'fully_evaluated',
        }),
    ),
    getCustomerCheckoutContext: jest.fn(() =>
      Promise.resolve({
        status: 'unique',
        customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
        addresses: [
          {
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
          },
        ],
        nextAfterAddressId: null,
      }),
    ),
    createCheckout: jest.fn(() =>
      Promise.resolve({ status: 'created', sale: placedSale() }),
    ),
    getCheckoutStatus: jest.fn(() =>
      Promise.resolve({ status: 'not_observed', checkout: null }),
    ),
    createSale: jest.fn(),
    upsertCustomer: jest.fn(),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId' ? CASHIER : undefined,
  } as unknown as ConfigService;
  /** One process; `boot()` again is a restart on the same durable stores. */
  const boot = () => {
    const cart = new MinimalCartService(client, store);
    const checkout = new MinimalCheckoutService(client, store);
    const shipping = new MinimalShippingService(
      store,
      cart,
      checkout,
      new FakeShippingQuoteClient(),
      { register: async () => undefined },
    );
    const gates = new ConversationGates(gateStore);
    const order = new MinimalOrderService(
      client,
      store,
      cart,
      checkout,
      config,
      shipping,
      undefined,
      undefined,
      gates,
    );
    return { cart, order, gates };
  };
  const pin = (items: Line[]) =>
    items.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      finalPriceCents: line.unitPriceCents * line.quantity,
      ...(line.backorder === undefined
        ? {}
        : { backorderId: (line.backorder as { id: string }).id }),
    }));
  const seedPickup = (items: Line[], extra: object = {}) =>
    store.commitMinimalCart(
      SENDER,
      undefined,
      {
        items,
        idempotencyKey: '',
        shipping: { mode: 'pickup', cartPin: pin(items) },
        ...extra,
      },
      '2026-10-10T00:00:00.000Z',
    );
  const slot = async () => (await store.get(SENDER))?.data.minimalCart;
  let process = boot();
  const offer = async (id = 'wamid.o1') => {
    const prepared = await process.order.prepareOrder(SENDER, EVENT(id));
    prepared.onSent?.();
    return prepared;
  };
  const yes = (id = 'wamid.o2') =>
    process.order.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT(id),
    });
  return {
    store,
    gateStore,
    api,
    seedPickup,
    slot,
    offer,
    yes,
    settle: () => process.gates.settle(SENDER),
    /** Pending gate writes land, a new process loads them at turn start. */
    restart: async () => {
      await process.gates.settle(SENDER);
      process = boot();
      await process.gates.begin(SENDER);
    },
  };
}
type Harness = ReturnType<typeof setup>;
const calls = (h: Harness) =>
  h.api.createCheckout.mock.calls as unknown as Array<
    [CreateCheckoutInput, string]
  >;
const ibuprofeno = (extra: object = {}): Line => ({
  productId: BO_PRODUCT,
  quantity: 2,
  unitPriceCents: 1500,
  ...extra,
});
const croquetas = (extra: object = {}): Line => ({
  productId: BO_CROQUETAS,
  quantity: 1,
  unitPriceCents: 120000,
  ...extra,
});

describe('T5a pet-less carts are byte-identical (item 3)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('pins the exact checkout body, idempotency fingerprint, summary, stored gate snapshot and pickup pin', async () => {
    const h = setup();
    await h.seedPickup([ibuprofeno(), croquetas()]);
    const offer = await h.offer();
    expect(offer.reply).toBe(
      [
        '*Resumen de su pedido* 🧾',
        '',
        '*Productos*',
        '• Ibuprofeno',
        '   2 × $15.00 = *$30.00*',
        '• Croquetas Adulto 18 kg',
        '   1 × $1,200.00 = *$1,200.00*',
        '',
        '*Datos del cliente*',
        'Ana',
        '',
        '*Envío:* recoge en tienda — sin costo',
        '*Total a pagar: $1,230.00*',
        '',
        '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.',
      ].join('\n'),
    );
    await h.settle();
    const gate = await h.gateStore.get(SENDER, 'order_confirmation');
    expect(
      JSON.stringify((gate?.payload as { snapshot: unknown }).snapshot),
    ).toBe(
      `{"customerId":"${CUSTOMER}","shippingAddressId":"","draft":null,"customer":{"firstName":"Ana","lastName":null},"items":[{"productId":"${BO_PRODUCT}","quantity":2,"unitPriceCents":1500,"name":"Ibuprofeno","finalPriceCents":3000,"appliedPromotionTitle":null,"discountAmountCents":0},{"productId":"${BO_CROQUETAS}","quantity":1,"unitPriceCents":120000,"name":"Croquetas Adulto 18 kg","finalPriceCents":120000,"appliedPromotionTitle":null,"discountAmountCents":0}],"totalCents":123000,"shipping":{"mode":"pickup"}}`,
    );
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
    await h.yes();
    const body = JSON.stringify(calls(h)[0][0]);
    expect(body).toBe(
      `{"phoneCountryCode":"52","phone":"5550001111","customer":{"mode":"existing","customerId":"${CUSTOMER}"},"sale":{"cashierUserId":"${CASHIER}","items":[{"productId":"${BO_PRODUCT}","variantId":null,"productName":"Ibuprofeno","variantName":null,"quantity":2,"unitPriceCents":1500},{"productId":"${BO_CROQUETAS}","variantId":null,"productName":"Croquetas Adulto 18 kg","variantName":null,"quantity":1,"unitPriceCents":120000}],"expectedTotalCents":123000,"shipping":{"mode":"pickup"}}}`,
    );
    const stored = (await h.slot()) as Record<string, unknown>;
    expect(stored.idempotencyFingerprint).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
    expect(stored.shipping).toEqual({
      mode: 'pickup',
      cartPin: [
        {
          productId: BO_PRODUCT,
          quantity: 2,
          unitPriceCents: 1500,
          finalPriceCents: 3000,
        },
        {
          productId: BO_CROQUETAS,
          quantity: 1,
          unitPriceCents: 120000,
          finalPriceCents: 120000,
        },
      ],
    });
  });
});

describe('T5a R4/R5: petId per line and «(para Max)» (S16)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends petId only on the tagged line and names the pet in the summary, across a restart', async () => {
    const h = setup();
    await h.seedPickup([ibuprofeno({ pet: MAX }), croquetas()], {
      currentPet: MAX,
    });
    const offer = await h.offer();
    expect(offer.reply).toContain(
      '• Ibuprofeno (para Max)\n   2 × $15.00 = *$30.00*\n• Croquetas Adulto 18 kg\n   1 × $1,200.00 = *$1,200.00*\n',
    );
    // The pending summary (with the pet) survives a restart.
    await h.restart();
    const placed = await h.yes();
    expect(placed?.reply).toContain('folio B-0042');
    expect(calls(h)).toHaveLength(1);
    expect(JSON.stringify(calls(h)[0][0].sale.items)).toBe(
      `[{"productId":"${BO_PRODUCT}","variantId":null,"productName":"Ibuprofeno","variantName":null,"quantity":2,"unitPriceCents":1500,"petId":"${MAX.id}"},{"productId":"${BO_CROQUETAS}","variantId":null,"productName":"Croquetas Adulto 18 kg","variantName":null,"quantity":1,"unitPriceCents":120000}]`,
    );
    // The placed order clears the cart and its current pet.
    expect(await h.slot()).toEqual({
      items: [],
      idempotencyKey: '',
      placedSale: { saleId: SALE, folio: 'B-0042', totalCents: 3000 },
    });
  });

  it('a backorder line keeps its backorderId next to a tagged ordinary line of the same product', async () => {
    const h = setup();
    await h.seedPickup([backorderCartLine(), croquetas({ pet: MAX })]);
    const offer = await h.offer();
    expect(offer.reply).toContain('(pedido apartado BO-000012)');
    expect(offer.reply).toContain(
      '• Croquetas Adulto 18 kg (para Max)\n   1 × $1,200.00 = *$1,200.00*',
    );
    await h.yes();
    const items = calls(h)[0][0].sale.items;
    expect(items[0].backorderId).toEqual(backorderCartLine().backorder.id);
    expect(items[0]).not.toHaveProperty('petId');
    expect(items[1]).toMatchObject({ petId: MAX.id });
    expect(items[1]).not.toHaveProperty('backorderId');
  });

  it('the snapshot binds the pet: the same order for another pet is not the same order', () => {
    const base: MinimalOrderSnapshot = {
      customerId: CUSTOMER,
      shippingAddressId: '',
      draft: null,
      customer: { firstName: 'Ana', lastName: null },
      items: [
        {
          productId: BO_PRODUCT,
          name: 'Ibuprofeno',
          quantity: 2,
          unitPriceCents: 1500,
          finalPriceCents: 3000,
        },
      ],
      totalCents: 3000,
      shipping: { mode: 'pickup' },
    };
    const tagged = { ...base, items: [{ ...base.items[0], pet: MAX }] };
    expect(sameMinimalOrder(base, structuredClone(base))).toBe(true);
    expect(sameMinimalOrder(tagged, structuredClone(tagged))).toBe(true);
    expect(sameMinimalOrder(base, tagged)).toBe(false);
    expect(renderMinimalOrderSummary(tagged)).toContain(
      '• Ibuprofeno (para Max)\n   2 × $15.00 = *$30.00*',
    );
  });

  it.each([
    [422, 'PET_ARCHIVED'],
    [404, 'PET_NOT_FOUND'],
    [422, 'PET_CUSTOMER_MISMATCH'],
  ])(
    '%s %s: the pets are removed and the same order is resent under a new key',
    async (status, code) => {
      const h = setup();
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await h.seedPickup([ibuprofeno({ pet: MAX }), croquetas()], {
        currentPet: MAX,
      });
      await h.offer();
      h.api.createCheckout.mockRejectedValueOnce(refusal(status, code));
      const placed = await h.yes();
      expect(placed?.reply).toContain('folio B-0042');
      const [first, second] = calls(h);
      expect(calls(h)).toHaveLength(2);
      expect(first[0].sale.items[0]).toMatchObject({ petId: MAX.id });
      expect(second[1]).toMatch(UUID);
      expect(second[1]).not.toBe(first[1]);
      // Same products and prices, no pet.
      const { petId: _gone, ...rest } = first[0].sale.items[0];
      void _gone;
      expect(second[0]).toEqual({
        ...first[0],
        sale: {
          ...first[0].sale,
          items: [rest, first[0].sale.items[1]],
        },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`checkout pet refusal code=${code}`),
      );
      expect(await h.slot()).toMatchObject({
        items: [],
        placedSale: { saleId: SALE },
      });
    },
  );

  it('a pet refusal after an earlier uncertain attempt reads the key first: absent → resent without pets', async () => {
    const h = setup();
    await h.seedPickup([ibuprofeno({ pet: MAX })]);
    await h.offer();
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
    await h.yes();
    await h.offer('wamid.o3');
    h.api.createCheckout.mockRejectedValueOnce(refusal(422, 'PET_ARCHIVED'));
    const placed = await h.yes('wamid.o4');
    expect(placed?.reply).toContain('folio B-0042');
    expect(calls(h)).toHaveLength(3);
    expect(calls(h)[1][1]).toBe(calls(h)[0][1]);
    expect(calls(h)[2][1]).not.toBe(calls(h)[1][1]);
    expect(calls(h)[2][0].sale.items[0]).not.toHaveProperty('petId');
  });

  it('a pet refusal after an uncertain attempt whose key cannot be read keeps the key and resends nothing', async () => {
    const h = setup();
    await h.seedPickup([ibuprofeno({ pet: MAX })]);
    await h.offer();
    h.api.createCheckout.mockRejectedValueOnce(new Error('lost response'));
    await h.yes();
    await h.offer('wamid.o3');
    // The SÍ turn's recovery read sees nothing; the read after the refusal
    // fails.
    h.api.getCheckoutStatus
      .mockResolvedValueOnce({ status: 'not_observed', checkout: null })
      .mockRejectedValueOnce(new Error('status down'));
    h.api.createCheckout.mockRejectedValueOnce(refusal(422, 'PET_ARCHIVED'));
    const reply = await h.yes('wamid.o4');
    expect(reply?.reply).toBe(MINIMAL_ORDER_UNRESOLVED_REPLY);
    expect(calls(h)).toHaveLength(2);
    expect(await h.slot()).toMatchObject({
      idempotencyKey: calls(h)[0][1],
      items: [{ pet: MAX }],
    });
  });
});
