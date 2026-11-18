import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { AskTeamOutcome } from '../../human-requests/application/human-request-create.service';
import { CLOSING_REPLY } from '../domain/closing-message';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalPaymentService } from './minimal-payment.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * Cost protection S6 / review advisory R3-purchase-in-progress-unproved:
 * with the REAL cart, checkout, shipping, order and payment services over
 * in-memory stores, a closing word («ok», «listo», «gracias») while a
 * delivery-data confirmation, an order summary, a payment offer or an
 * interactive choice is pending keeps the existing flow; with an empty cart
 * and no draft, «gracias» gets the fixed reply without the model.
 */
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

const pickupCart = () => ({
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
    getOrderHistory: jest.fn(() => Promise.resolve([])),
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
  const seen: unknown[] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = steps;
    let index = 0;
    return generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: async () =>
          script[index++] as Awaited<
            ReturnType<MockLanguageModelV4['doGenerate']>
          >,
      }),
    });
  };
  const team = {
    askTeam: jest.fn(
      (): Promise<AskTeamOutcome> =>
        Promise.resolve({ kind: 'registered', requestId: 'r-1' }),
    ),
  };
  const sessions = new InMemoryMinimalCatalogSessionStore();
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
    new CostGuardService(),
    config,
    sessions,
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
    script: unknown[] = [say('Respuesta del modelo.')],
    extra: { inboundEvent?: unknown } = {},
  ) => {
    steps = script;
    return agent.tryHandle({
      senderId: SENDER,
      text,
      inboundAt: '2026-11-16T12:00:00.000Z',
      ...extra,
    });
  };
  /** Cart + selected address + the delivery-data summary shown (pending). */
  const pendingDeliveryConfirmation = async () => {
    await store.create(SENDER, {
      lastMessageAt: '2026-10-10T00:00:00.000Z',
      data: { minimalCart: pickupCart() },
    });
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
    const delivery = await checkout.prepareConfirmation(
      SENDER,
      EVENT('wamid.d1'),
    );
    delivery.onSent?.();
  };
  /** ... then SÍ and the order summary shown (pending). */
  const pendingOrderSummary = async () => {
    await pendingDeliveryConfirmation();
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
    if (typeof (offer as { onSent?: unknown }).onSent !== 'function')
      throw new Error(`no order summary: ${JSON.stringify(offer)}`);
    (offer as { onSent: () => void }).onSent();
  };
  /** ... then SÍ: the order is placed and the payment offer is pending. */
  const pendingPaymentOffer = async () => {
    await pendingOrderSummary();
    return turn('SÍ', [say('Inventado')], { inboundEvent: EVENT('wamid.o2') });
  };
  return {
    api,
    store,
    seen,
    turn,
    checkout,
    sessions,
    pendingDeliveryConfirmation,
    pendingOrderSummary,
    pendingPaymentOffer,
  };
}

const reply = (decision: unknown) => (decision as { reply: string }).reply;
const isClosing = (decision: unknown) =>
  reply(decision) === CLOSING_REPLY ||
  (decision as { silent?: true }).silent === true;

describe('S6 closings with a purchase in progress (real services)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['ok', 'listo'])(
    'a pending delivery-data confirmation: %p confirms it (existing flow), never the closing reply',
    async (text) => {
      const h = setup();
      await h.pendingDeliveryConfirmation();
      expect(h.checkout.confirmationStatus(SENDER)?.stage).toBe('pending');
      const decision = await h.turn(text, [say('Inventado')], {
        inboundEvent: EVENT('wamid.c1'),
      });
      expect(isClosing(decision)).toBe(false);
      expect(h.checkout.confirmationStatus(SENDER)?.stage).not.toBe('pending');
    },
  );

  it('a delivery-data confirmation pending: «gracias» is not swallowed by the closing reply', async () => {
    const h = setup();
    await h.pendingDeliveryConfirmation();
    const decision = await h.turn('gracias', [say('¿Confirma sus datos?')]);
    expect(isClosing(decision)).toBe(false);
  });

  it.each(['ok', 'listo'])(
    'a pending order summary: %p places the order (existing flow), never the closing reply',
    async (text) => {
      const h = setup();
      await h.pendingOrderSummary();
      const decision = await h.turn(text, [say('Inventado')], {
        inboundEvent: EVENT('wamid.c2'),
      });
      expect(isClosing(decision)).toBe(false);
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      expect(reply(decision)).toContain('B-0042');
    },
  );

  it('a pending order summary: «gracias» reaches the existing route (model), not the closing reply', async () => {
    const h = setup();
    await h.pendingOrderSummary();
    const before = h.seen.length;
    const decision = await h.turn('gracias', [say('¿Confirma su pedido?')]);
    expect(isClosing(decision)).toBe(false);
    expect(h.seen.length).toBe(before + 1);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it.each(['ok', 'listo'])(
    'a pending payment offer: %p sends the payment details (existing flow)',
    async (text) => {
      const h = setup();
      await h.pendingPaymentOffer();
      const decision = await h.turn(text);
      expect(isClosing(decision)).toBe(false);
      expect(reply(decision)).toContain('CLABE: 012180001234567891');
    },
  );

  it('a pending payment offer: «gracias» is not answered as a closing', async () => {
    const h = setup();
    await h.pendingPaymentOffer();
    const decision = await h.turn('gracias');
    expect(isClosing(decision)).toBe(false);
  });

  it.each(['ok', 'listo', 'gracias'])(
    'a pending interactive choice (product list): %p goes to the model, not the closing reply',
    async (text) => {
      const h = setup();
      h.sessions.write(SENDER, [
        {
          messages: [
            { role: 'user', content: 'busco ibuprofeno' },
            { role: 'assistant', content: 'Tenemos estas opciones.' },
          ],
          verifiedProductIds: [PRODUCT],
          interactiveChoice: {
            options: [
              { id: 'pick:p:a', reference: 'a', text: 'Ibuprofeno 200 mg' },
              { id: 'pick:p:b', reference: 'b', text: 'Ibuprofeno 400 mg' },
            ],
          },
        },
      ]);
      const decision = await h.turn(text);
      expect(isClosing(decision)).toBe(false);
      expect(h.seen).toHaveLength(1);
    },
  );

  it('a cart with items and no pending question: «gracias» goes to the model', async () => {
    const h = setup();
    await h.store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: { minimalCart: pickupCart() },
    });
    const decision = await h.turn('gracias');
    expect(isClosing(decision)).toBe(false);
    expect(h.seen).toHaveLength(1);
  });

  it('an empty cart and no draft: «gracias» gets the fixed reply without the model', async () => {
    const h = setup();
    const decision = await h.turn('gracias');
    expect(decision).toEqual({ kind: 'handled', reply: CLOSING_REPLY });
    expect(h.seen).toHaveLength(0);
  });

  it('a stored conversation with an emptied cart and no draft key: «gracias» gets the fixed reply', async () => {
    const h = setup();
    await h.store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: { minimalCart: { items: [], idempotencyKey: '' } },
    });
    await expect(h.checkout.hasDraft(SENDER)).resolves.toBe(false);
    const decision = await h.turn('gracias');
    expect(decision).toEqual({ kind: 'handled', reply: CLOSING_REPLY });
    expect(h.seen).toHaveLength(0);
  });

  it('an empty cart but a delivery-data draft for an order not placed: «gracias» goes to the model', async () => {
    const h = setup();
    await h.pendingDeliveryConfirmation();
    // The cart was emptied and the summary is no longer pending; the draft
    // stays (delivery data being collected).
    const live = await h.store.get(SENDER);
    await expect(
      h.store.commitMinimalCart(
        SENDER,
        live?.data.minimalCart,
        { items: [], idempotencyKey: '' },
        new Date().toISOString(),
      ),
    ).resolves.toBe(true);
    await expect(h.store.get(SENDER)).resolves.toMatchObject({
      data: { minimalCart: { items: [] } },
    });
    h.checkout.dismissPendingConfirmation(SENDER);
    await expect(h.checkout.hasDraft(SENDER)).resolves.toBe(true);
    const decision = await h.turn('gracias');
    expect(isClosing(decision)).toBe(false);
    expect(h.seen).toHaveLength(1);
  });
});

describe('MinimalCheckoutService.hasDraft (S6 semantics)', () => {
  const api = {} as ChatbotApiClient;

  it('an absent conversation is no draft', async () => {
    const checkout = new MinimalCheckoutService(
      api,
      new InMemoryConversationStore(),
    );
    await expect(checkout.hasDraft(SENDER)).resolves.toBe(false);
  });

  it('a conversation without the draft key is no draft', async () => {
    const store = new InMemoryConversationStore();
    await store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: { minimalCart: { items: [], idempotencyKey: '' } },
    });
    await expect(
      new MinimalCheckoutService(api, store).hasDraft(SENDER),
    ).resolves.toBe(false);
  });

  it('an unreadable store or an unreadable draft counts as a draft (fail safe: model route)', async () => {
    const broken = {
      get: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as ConversationStore;
    await expect(
      new MinimalCheckoutService(api, broken).hasDraft(SENDER),
    ).resolves.toBe(true);
    const store = new InMemoryConversationStore();
    await store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: { minimalCheckoutDraft: { corrupt: true } },
    });
    await expect(
      new MinimalCheckoutService(api, store).hasDraft(SENDER),
    ).resolves.toBe(true);
  });
});
