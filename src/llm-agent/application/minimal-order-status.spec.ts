import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { AskTeamOutcome } from '../../human-requests/application/human-request-create.service';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService, parseMinimalCart } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalPaymentService } from './minimal-payment.service';
import { MinimalShippingService } from './minimal-shipping.service';

const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SALE = '55555555-5555-4555-8555-555555555555';
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const LEAD = 'Pedido con folio B-0042. Total a pagar: $30.00 MXN.';

const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (name: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${name}-${Math.random()}`,
      toolName: name,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Listo.') => step([{ type: 'text', text }], 'stop');

const bankDetails = () => ({
  id: 'pd',
  bankName: 'BBVA',
  beneficiary: 'HoundFe SA de CV',
  clabe: '012180001234567891',
  accountNumber: '0123456789',
  isActive: true,
  updatedAt: '2026-10-01T00:00:00.000Z',
});

function setup() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(() =>
      Promise.resolve([
        {
          productId: PRODUCT,
          name: 'Ibuprofeno',
          price: { priceCents: 1500 },
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
          unitPriceCents: 1500,
          originalPriceCents: 1500 * item.quantity,
          finalPriceCents: 1500 * item.quantity,
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
      Promise.resolve({
        status: 'created',
        sale: {
          saleId: SALE,
          folio: 'B-0042',
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 3000,
          paidCents: 0,
          debtCents: 3000,
          confirmedAt: null,
          discountCents: 0,
        },
      }),
    ),
    getCheckoutStatus: jest.fn(() =>
      Promise.resolve({ status: 'not_observed', checkout: null }),
    ),
    getPaymentDetails: jest.fn(() => Promise.resolve(bankDetails())),
    getOrderHistory: jest.fn((): Promise<unknown> => Promise.resolve([])),
    createSale: jest.fn(),
    upsertCustomer: jest.fn(),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? CASHIER
        : { model: 'm', maxSteps: 5, historyTurns: 12 },
  } as unknown as ConfigService;
  let steps: unknown[] = [];
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = steps;
    let index = 0;
    return generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          const next = script[index++];
          return (
            typeof next === 'function' ? (next as () => unknown)() : next
          ) as Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
        },
      }),
    });
  };
  const team = {
    askTeam: jest.fn(
      (): Promise<AskTeamOutcome> =>
        Promise.resolve({ kind: 'registered', requestId: 'r-1' }),
    ),
  };
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const shipping = new MinimalShippingService(
    store,
    cart,
    checkout,
    new FakeShippingQuoteClient(),
    { register: async () => undefined },
  );
  const order = new MinimalOrderService(
    client,
    store,
    cart,
    checkout,
    config,
    shipping,
  );
  const payment = new MinimalPaymentService(client, store, team);
  const agent = new MinimalCatalogAgentService(
    client,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cart,
    checkout,
    order,
    undefined,
    undefined,
    undefined,
    team,
    payment,
  );
  const turn = (
    text: string,
    script: unknown[] = [say('Inventado')],
    extra: { interactiveReplyId?: string; inboundEvent?: unknown } = {},
  ) => {
    steps = script;
    return agent.tryHandle({
      senderId: SENDER,
      text,
      inboundAt: '2026-11-16T12:00:00.000Z',
      ...extra,
    });
  };
  /** Real flow: cart → delivery confirmed → summary → SÍ → order created. */
  const placeOrder = async () => {
    await store.create(SENDER, {
      lastMessageAt: '2026-10-10T00:00:00.000Z',
      data: {
        minimalCart: {
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
          idempotencyKey: '',
          expectedTotalCents: 3000,
          shipping: {
            mode: 'pickup',
            cartPin: [
              {
                productId: PRODUCT,
                quantity: 2,
                unitPriceCents: 1500,
                finalPriceCents: 3000,
              },
            ],
          },
        },
      },
    });
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
    const delivery = await checkout.prepareConfirmation(
      SENDER,
      EVENT('wamid.d1'),
    );
    delivery.onSent?.();
    await checkout.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.d2'),
    });
    const offer = await turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say('Inventado')],
      { inboundEvent: EVENT('wamid.o1') },
    );
    (offer as { onSent: () => void }).onSent();
    return turn('SÍ', [say('Inventado')], { inboundEvent: EVENT('wamid.o2') });
  };
  /** A placed sale without going through the session offer. */
  const seedPlacedSale = (extra: object = {}) =>
    store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: {
        minimalCart: {
          items: [],
          idempotencyKey: '',
          placedSale: {
            saleId: SALE,
            folio: 'B-0042',
            totalCents: 3000,
            ...extra,
          },
        },
      },
    });
  const placedSale = async () =>
    parseMinimalCart((await store.get(SENDER))?.data.minimalCart)?.placedSale;
  return {
    api,
    store,
    team,
    seen,
    turn,
    placeOrder,
    seedPlacedSale,
    placedSale,
    checkout,
  };
}

type Harness = ReturnType<typeof setup>;
const reply = (decision: unknown) => (decision as { reply: string }).reply;
const PAYMENT_QUESTION = 'Para terminar solo falta el pago. ¿Cómo desea pagar?';

const PAID_REPLY = 'Su pedido ya está pagado.';
const LAST_ORDER = [
  {
    saleId: '77777777-7777-4777-8777-777777777777',
    folio: 'B-0001',
    confirmedAt: '2026-10-01T00:00:00.000Z',
    channel: 'ONLINE',
    deliveryStatus: 'DELIVERED',
    paymentStatus: 'PAID',
    totalCents: 1500,
    paidCents: 1500,
    debtCents: 0,
    items: [
      {
        productId: PRODUCT,
        variantId: null,
        productName: 'Ibuprofeno',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1500,
      },
    ],
    payments: [],
    shippingAddress: null,
  },
];

const interactiveOf = (decision: unknown) =>
  (decision as { interactive?: { buttons?: Array<{ id: string }> } })
    .interactive;
const seedCart = (h: Harness) =>
  h.store.create(SENDER, {
    lastMessageAt: new Date().toISOString(),
    data: {
      minimalCart: {
        items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
        idempotencyKey: '',
      },
    },
  });
/** A pending order summary (pickup), shown and armed. */
const pendingSummary = async (h: Harness) => {
  await h.store.create(SENDER, {
    lastMessageAt: '2026-10-10T00:00:00.000Z',
    data: {
      minimalCart: {
        items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
        idempotencyKey: '',
        expectedTotalCents: 3000,
        shipping: {
          mode: 'pickup',
          cartPin: [
            {
              productId: PRODUCT,
              quantity: 2,
              unitPriceCents: 1500,
              finalPriceCents: 3000,
            },
          ],
        },
      },
    },
  });
  const lookup = await h.checkout.lookup(SENDER, null);
  if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
  await h.checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
  const delivery = await h.checkout.prepareConfirmation(
    SENDER,
    EVENT('wamid.d1'),
  );
  delivery.onSent?.();
  await h.checkout.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('wamid.d2'),
  });
  const offer = await h.turn(
    'Quiero hacer mi pedido',
    [call('prepareOrder'), say('Inventado')],
    { inboundEvent: EVENT('wamid.o1') },
  );
  (offer as { onSent: () => void }).onSent();
  return offer;
};

describe('order summary vs previous order (S5)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['Muéstrame el resumen de mi pedido', 'mi resumen', 'ver mi pedido'])(
    'with a pending order summary, %p shows it again with the confirm button and no model call',
    async (text) => {
      const h = setup();
      await pendingSummary(h);
      const llmCalls = h.seen.length;
      const decision = await h.turn(text, [say('Inventado')], {
        inboundEvent: EVENT('wamid.s1'),
      });
      // «Muéstrame» is a tú signal, so the reply is styled de tú.
      expect(reply(decision)).toMatch(/Resumen de (?:su|tu) pedido:/);
      expect(reply(decision)).toContain('Total a pagar: $30.00 MXN');
      expect(
        interactiveOf(decision)?.buttons?.map((button) => button.id),
      ).toEqual([expect.stringMatching(/^order_confirm:/), 'order_change']);
      expect(h.seen).toHaveLength(llmCalls);
      expect(h.api.getOrderHistory).not.toHaveBeenCalled();
      expect(h.api.createCheckout).not.toHaveBeenCalled();
    },
  );

  it('the re-shown summary can still be confirmed with SÍ', async () => {
    const h = setup();
    await pendingSummary(h);
    const shown = await h.turn('mi resumen', [say('Inventado')], {
      inboundEvent: EVENT('wamid.s1'),
    });
    (shown as { onSent: () => void }).onSent();
    const placed = await h.turn('SÍ', [say('Inventado')], {
      inboundEvent: EVENT('wamid.s2'),
    });
    expect(reply(placed)).toContain('B-0042');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('with a new cart after an earlier order and no summary yet, shows the cart with the next-step buttons', async () => {
    const h = setup();
    await h.store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: {
        minimalCart: {
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
          idempotencyKey: '',
          placedSale: { saleId: SALE, folio: 'B-0042', totalCents: 3000 },
        },
      },
    });
    const decision = await h.turn('ver mi pedido', [say('Inventado')]);
    expect(reply(decision)).toContain('Su carrito:');
    expect(reply(decision)).toContain('¿Desea agregar algo más');
    expect(
      interactiveOf(decision)?.buttons?.map((button) => button.id),
    ).toEqual([
      expect.stringMatching(/^cart_continue:/),
      expect.stringMatching(/^cart_add:/),
    ]);
    expect(h.seen).toHaveLength(0);
    expect(h.api.getOrderHistory).not.toHaveBeenCalled();
  });

  it('with an unpaid placed sale, shows that order with its payment next step', async () => {
    const h = setup();
    await h.seedPlacedSale();
    const decision = await h.turn('mi resumen');
    expect(reply(decision)).toBe(`${LEAD}\n\n${PAYMENT_QUESTION}`);
    expect(
      interactiveOf(decision)?.buttons?.map((button) => button.id),
    ).toEqual([`pay:transfer:${SALE}`]);
    expect(h.seen).toHaveLength(0);
    expect(h.api.getOrderHistory).not.toHaveBeenCalled();
    // The offer stays bound to this sale: a yes sends the details.
    const after = await h.turn('transferencia');
    expect(reply(after)).toContain('CLABE: 012180001234567891');
  });

  it('with a paid placed sale, shows folio and total and that it is paid', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    const decision = await h.turn('mi resumen');
    expect(reply(decision)).toBe(
      `Pedido con folio B-0042. Total: $30.00 MXN.\n${PAID_REPLY}`,
    );
    expect(interactiveOf(decision)).toBeUndefined();
    expect(h.seen).toHaveLength(0);
  });

  it('styles the placed-order summary for a tú customer', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    const decision = await h.turn('oye, ver mi pedido');
    expect(reply(decision)).toContain('Tu pedido ya está pagado.');
  });

  it.each([
    'mi pedido anterior',
    'lo mismo que la vez pasada',
    '¿qué pedí la última vez?',
  ])(
    'a previous-order request %p still goes to the model (getLastOrder)',
    async (text) => {
      const h = setup();
      await h.seedPlacedSale();
      h.api.getOrderHistory.mockResolvedValue(LAST_ORDER);
      await h.turn(text, [call('getLastOrder'), say('Inventado')]);
      expect(h.seen).toHaveLength(1);
      expect(h.api.getOrderHistory).toHaveBeenCalledTimes(1);
    },
  );

  it('a cart-only customer keeps the model (cart and checkout tools)', async () => {
    const h = setup();
    await seedCart(h);
    await h.turn('ver mi pedido', [say('¿Le armo su pedido?')]);
    expect(h.seen).toHaveLength(1);
  });

  it('without a pending summary, cart or placed sale the model keeps the turn', async () => {
    const h = setup();
    await h.turn('ver mi pedido', [say('No tiene pedidos todavía.')]);
    expect(h.seen).toHaveLength(1);
  });

  it('the prompt separates the current summary from the previous order', async () => {
    const h = setup();
    await seedCart(h);
    await h.turn('quiero croquetas', [say('Claro.')]);
    const system = String(h.seen[0].system);
    expect(system).toContain('getLastOrder solo para un pedido ANTERIOR');
    expect(system).toContain('no llame getLastOrder');
  });
});

describe('paid placed sale (S6)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a payment question answers it is already paid, no model, no tool, no team request', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    const decision = await h.turn('¿A qué cuenta le transfiero?');
    expect(reply(decision)).toBe(PAID_REPLY);
    expect(h.seen).toHaveLength(0);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('styles the answer for a tú customer', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    const decision = await h.turn('oye, ¿cómo pago?');
    expect(reply(decision)).toBe('Tu pedido ya está pagado.');
  });

  it('a stale payment button answers it is paid and never fetches the details', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    const decision = await h.turn('Transferencia', [say('Inventado')], {
      interactiveReplyId: `pay:transfer:${SALE}`,
    });
    expect(reply(decision)).toBe(PAID_REPLY);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('does not expose the payment tool and tells the model it is paid', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    await h.turn('Gracias', [say('Con gusto.')]);
    expect(Object.keys(h.seen[0].tools ?? {})).not.toContain(
      'getPaymentDetails',
    );
    expect(String(h.seen[0].system)).not.toContain(
      'Herramienta getPaymentDetails',
    );
    expect(String(h.seen[0].system)).toContain(PAID_REPLY);
  });

  it('an unpaid placed sale keeps the payment tool and the details (old state = unpaid)', async () => {
    const h = setup();
    await h.seedPlacedSale();
    const decision = await h.turn('¿Cómo pago?', [
      call('getPaymentDetails'),
      say('Inventado'),
    ]);
    expect(Object.keys(h.seen[0].tools ?? {})).toContain('getPaymentDetails');
    expect(reply(decision)).toContain('CLABE: 012180001234567891');
  });

  it('a paid sale with a leftover pending marker still answers it is paid', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true, paymentPending: true });
    const decision = await h.turn('datos de pago');
    expect(reply(decision)).toBe(PAID_REPLY);
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('a new order replaces the paid one and starts unpaid', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    await h.placeOrder();
    expect((await h.placedSale())?.paid).toBeUndefined();
  });

  it('an old paid order does not answer for a new cart in progress', async () => {
    const h = setup();
    await h.store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: {
        minimalCart: {
          items: [{ productId: PRODUCT, quantity: 1, unitPriceCents: 1500 }],
          idempotencyKey: '',
          placedSale: {
            saleId: SALE,
            folio: 'B-0042',
            totalCents: 3000,
            paid: true,
          },
        },
      },
    });
    const cart = await h.turn('ver mi pedido');
    expect(reply(cart)).toContain('Su carrito:');
    const question = await h.turn('¿cómo pago?', [say('Con gusto.')]);
    expect(reply(question)).not.toBe(PAID_REPLY);
    expect(h.seen).toHaveLength(1);
  });
});
