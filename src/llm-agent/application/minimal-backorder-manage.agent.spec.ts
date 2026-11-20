import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type {
  BackorderBot,
  BackorderClient,
} from '../../backorders/domain/backorder';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { AskTeamOutcome } from '../../human-requests/application/human-request-create.service';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { MinimalBackorderManageService } from './minimal-backorder-manage.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalPaymentService } from './minimal-payment.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * Restock backorder S8 (T6) through the real customer turn: cancel and status
 * of a scheduled restock order are answered by code (no model), and every
 * existing flow the trigger could touch (cart, placed-order status and
 * payment, order confirmation) still behaves exactly as before.
 */
const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SALE = '55555555-5555-4555-8555-555555555555';
const BACKORDER_ID = '8c1d0000-1111-4222-8333-444455556666';
const T0 = Date.parse('2026-11-20T12:00:00.000Z');
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const backorder = (overrides: Partial<BackorderBot> = {}): BackorderBot => ({
  id: BACKORDER_ID,
  folio: 'BO-000012',
  status: 'WAITING',
  productId: PRODUCT,
  productName: 'Croquetas Adulto 18 kg',
  variantId: null,
  variantName: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: null,
  finalPriceCents: null,
  scheduledAt: '2026-11-20T12:00:00.000Z',
  estimatedAt: '2026-11-27T15:00:00.000Z',
  estimatedArrivalDays: 7,
  reservedAt: null,
  reservedUntil: null,
  reminderAt: null,
  queuePosition: 1,
  saleId: null,
  cancelledByKind: null,
  cancelReason: null,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  ...overrides,
});

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

function setup(options: { manage?: boolean; active?: BackorderBot[] } = {}) {
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
  const backorders = {
    createBackorder: jest.fn(),
    getBackorder: jest.fn(),
    listBackorders: jest
      .fn()
      .mockResolvedValue(options.active ?? [backorder()]),
    cancelBackorder: jest
      .fn()
      .mockResolvedValue(backorder({ status: 'CANCELLED' })),
  } satisfies Record<keyof BackorderClient, jest.Mock>;
  const manage =
    options.manage === false
      ? undefined
      : new MinimalBackorderManageService({ backorders, clock: () => T0 });
  const sessionStore = new InMemoryMinimalCatalogSessionStore();
  const agent = new MinimalCatalogAgentService(
    client,
    generate,
    new CostGuardService(100000),
    config,
    sessionStore,
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
    undefined,
    manage,
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
  return {
    api,
    sessionStore,
    backorders,
    store,
    team,
    seen,
    turn,
    placeOrder,
    seedPlacedSale,
    checkout,
  };
}

type Harness = ReturnType<typeof setup>;
const reply = (decision: unknown) => (decision as { reply: string }).reply;
const PAYMENT_QUESTION = 'Para terminar solo falta el pago. ¿Cómo desea pagar?';
const LEAD = 'Pedido con folio B-0042. Total a pagar: $30.00 MXN.';

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

const QUESTION = '¿Cancelo su pedido BO-000012 de 2 × Croquetas Adulto 18 kg?';

describe('cancel from the chat, through the customer turn', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks once with buttons, then a typed yes cancels; no model, no other call', async () => {
    const h = setup();
    const asked = await h.turn('cancela lo que aparté');
    expect(reply(asked)).toBe(QUESTION);
    expect(interactiveOf(asked)?.buttons?.map((b) => b.id)).toEqual([
      `backorder_cancel:yes:${BACKORDER_ID}`,
      `backorder_cancel:no:${BACKORDER_ID}`,
    ]);
    const done = await h.turn('sí');
    expect(reply(done)).toBe('Listo, cancelé su pedido BO-000012.');
    expect(h.backorders.cancelBackorder).toHaveBeenCalledTimes(1);
    expect(h.backorders.cancelBackorder).toHaveBeenCalledWith(BACKORDER_ID);
    expect(h.seen).toHaveLength(0);
  });

  it('the tapped [Sí, cancelar] cancels and the tapped [No] keeps it', async () => {
    const h = setup();
    expect(
      reply(
        await h.turn('SÍ', [say('Inventado')], {
          interactiveReplyId: `backorder_cancel:yes:${BACKORDER_ID}`,
        }),
      ),
    ).toBe('Listo, cancelé su pedido BO-000012.');
    expect(
      reply(
        await h.turn('No', [say('Inventado')], {
          interactiveReplyId: `backorder_cancel:no:${BACKORDER_ID}`,
        }),
      ),
    ).toBe('Entendido, no lo cancelo.');
    expect(h.backorders.cancelBackorder).toHaveBeenCalledTimes(1);
    expect(h.seen).toHaveLength(0);
  });

  it('keeps the customer style (tú)', async () => {
    const h = setup();
    const asked = await h.turn('oye, cancela lo que aparté');
    expect(reply(asked)).toBe(
      '¿Cancelo tu pedido BO-000012 de 2 × Croquetas Adulto 18 kg?',
    );
    expect(reply(await h.turn('sí'))).toBe(
      'Listo, cancelé tu pedido BO-000012.',
    );
  });

  it('with no active backorder the turn is NOT handled here: the model answers as before', async () => {
    const h = setup({ active: [] });
    await h.turn('cancela mi pedido por reposición', [say('Sin pedidos.')]);
    expect(h.seen).toHaveLength(1);
    expect(h.backorders.cancelBackorder).not.toHaveBeenCalled();
  });

  it('records the turn so a later reorder/payment «sí» cannot reuse an old offer', async () => {
    const h = setup();
    await h.seedPlacedSale();
    await h.turn('mi resumen'); // payment offer bound to the sale
    const asked = await h.turn('cancela lo que aparté');
    expect(reply(asked)).toBe(QUESTION);
    // The yes belongs to the cancel question, not to the payment offer.
    expect(reply(await h.turn('sí'))).toBe(
      'Listo, cancelé su pedido BO-000012.',
    );
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
  });
});

describe('status from the chat, through the customer turn', () => {
  it.each([
    [
      '¿cómo va mi pedido por reposición?',
      'Su pedido BO-000012 sigue en espera; llega aprox. el 27 de noviembre. Le aviso en cuanto llegue.',
    ],
    [
      'oye, ¿ya llegó lo que aparté?',
      'Tu pedido BO-000012 sigue en espera; llega aprox. el 27 de noviembre. Te aviso en cuanto llegue.',
    ],
  ])('%s', async (text, expected) => {
    const h = setup();
    expect(reply(await h.turn(text))).toBe(expected);
    expect(h.seen).toHaveLength(0);
    expect(h.backorders.cancelBackorder).not.toHaveBeenCalled();
  });

  it('RESERVED is answered without offering checkout (T5 owns it)', async () => {
    const h = setup({
      active: [
        backorder({
          status: 'RESERVED',
          reservedUntil: '2026-11-21T15:00:00.000Z',
        }),
      ],
    });
    const decision = await h.turn('¿ya llegó lo que aparté?');
    expect(reply(decision)).toBe(
      '¡Ya llegó! Se lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.',
    );
    expect(interactiveOf(decision)).toBeUndefined();
  });

  it('with an unpaid placed sale and generic wording, the existing sale path keeps the turn', async () => {
    const h = setup();
    await h.seedPlacedSale();
    await h.turn('¿ya llegó mi pedido?', [say('Aún no sale.')]);
    expect(h.seen).toHaveLength(1);
    expect(h.backorders.listBackorders).not.toHaveBeenCalled();
  });

  it('with an unpaid placed sale and the restock order named, the backorder is answered', async () => {
    const h = setup();
    await h.seedPlacedSale();
    expect(reply(await h.turn('¿cómo va mi pedido por reposición?'))).toContain(
      'BO-000012 sigue en espera',
    );
    expect(h.seen).toHaveLength(0);
  });

  it('«ver mi pedido por reposición» names the restock order: not the placed-sale summary', async () => {
    const h = setup();
    await h.seedPlacedSale();
    expect(reply(await h.turn('ver mi pedido por reposición'))).not.toContain(
      'B-0042',
    );
  });
});

/**
 * Every existing flow the trigger could touch: the same scenario with and
 * without the manage service must give the same answer.
 */
describe('existing flows are untouched by the backorder trigger', () => {
  afterEach(() => jest.restoreAllMocks());

  const same = async (
    prepare: (h: Harness) => Promise<unknown>,
    text: string,
    script: unknown[] = [say('Inventado')],
  ) => {
    const withManage = setup();
    const without = setup({ manage: false });
    await prepare(withManage);
    await prepare(without);
    const a = await withManage.turn(text, script);
    const b = await without.turn(text, script);
    expect(a).toEqual(b);
    expect(withManage.seen.length).toBe(without.seen.length);
    expect(withManage.backorders.listBackorders).not.toHaveBeenCalled();
    expect(withManage.backorders.cancelBackorder).not.toHaveBeenCalled();
    return a;
  };

  /** The bot's latest turn carries a reorder offer (as after «lo mismo de la vez pasada»). */
  const seedReorderOffer = (h: Harness) => {
    h.sessionStore.write(SENDER, [
      {
        messages: [
          { role: 'user', content: 'lo mismo de la vez pasada' },
          {
            role: 'assistant',
            content: 'Su último pedido… ¿Lo agrego igual a su carrito?',
          },
        ],
        verifiedProductIds: [PRODUCT],
        reorderOffer: {
          reference: 'reorder-1',
          items: [{ productId: PRODUCT, quantity: 2 }],
        },
      },
    ]);
    return Promise.resolve();
  };

  it('«no, ya no quiero el pedido» right after a reorder offer is the reorder flow, not a backorder cancel', async () => {
    await same(seedReorderOffer, 'no, ya no quiero el pedido');
  });

  it('a catalog search message never reaches the backorder list', async () => {
    await same(() => Promise.resolve(), '¿tienen croquetas para gato?');
  });

  it('cart removal wording keeps the model route', async () => {
    await same(seedCart, 'quita las croquetas del carrito');
    await same(seedCart, 'elimina el pedido del carrito');
  });

  it('«ya no quiero el pedido» with a cart is the cart/model, not a backorder cancel', async () => {
    await same(seedCart, 'ya no quiero el pedido');
  });

  it('«cancela mi pedido» with an unpaid placed sale is the sale/model, not a backorder cancel', async () => {
    await same((h) => h.seedPlacedSale(), 'cancela mi pedido');
  });

  it('«ya no quiero el pedido» with a pending order summary keeps its route', async () => {
    await same(pendingSummary, 'ya no quiero el pedido');
  });

  it('placed-order status («mi resumen») is unchanged', async () => {
    const decision = await same((h) => h.seedPlacedSale(), 'mi resumen');
    expect(reply(decision)).toBe(`${LEAD}\n\n${PAYMENT_QUESTION}`);
  });

  it('a payment question on the placed order is unchanged', async () => {
    await same((h) => h.seedPlacedSale(), '¿cómo pago?');
    await same(
      (h) => h.seedPlacedSale({ paid: true }),
      '¿A qué cuenta le transfiero?',
    );
  });

  it('a previous-order request still goes to the model (getLastOrder)', async () => {
    await same((h) => h.seedPlacedSale(), 'mi pedido anterior', [
      call('getLastOrder'),
      say('Inventado'),
    ]);
  });

  it('a bare «sí» / «no» with no cancel question belongs to the other flows', async () => {
    const withManage = setup();
    await pendingSummary(withManage);
    const placed = await withManage.turn('SÍ', [say('Inventado')], {
      inboundEvent: EVENT('wamid.o2'),
    });
    expect(withManage.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(reply(placed)).toContain('B-0042');
    expect(withManage.backorders.listBackorders).not.toHaveBeenCalled();
  });
});
