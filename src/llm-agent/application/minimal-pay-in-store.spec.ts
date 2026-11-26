import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
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

/**
 * Pay in store S3 (odd/tasks/pay-in-store.md): for a PICKUP order and with
 * PAY_IN_STORE_ENABLED the payment question offers [Transferencia] and
 * [Pagar en tienda]; the tap marks the sale (PATCH payment-intent) and tells
 * the customer the deadline and the store. Flag off: exactly today's offer.
 */

const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SALE = '55555555-5555-4555-8555-555555555555';
const OTHER_SALE = '66666666-6666-4666-8666-666666666666';
const KEY = '77777777-7777-4777-8777-777777777777';
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const LOCATION = {
  name: 'Sucursal Centro',
  address: {
    addressLine1: 'Av. Juárez 123',
    addressLine2: null,
    neighborhood: 'Centro',
    municipality: 'Cuauhtémoc',
    state: 'Ciudad de México',
    postalCode: '06000',
    formatted:
      'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000.',
  },
  hours: {
    timeZone: 'America/Mexico_City',
    days: [],
    summary: 'Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
  },
};
// Message formatting F3b: the store block of the hold reply, one piece per line.
const STORE = [
  '*Sucursal Centro*',
  'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
  '*Horario:* Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
].join('\n');
// 12:30 p. m. of Thursday 19 November in Mexico City (UTC-6).
const HOLD = {
  saleId: SALE,
  folio: 'B-0042',
  paymentIntent: 'IN_STORE',
  holdUntil: '2026-11-19T18:30:00.000Z',
  reminderAt: '2026-11-19T15:30:00.000Z',
};
const HELD = `Listo, le apartamos su pedido *B-0042* hasta el *jueves 19 de noviembre a las 12:30 p. m.*\n\nPáselo a recoger y pagar en ${STORE}\n\nSi no pasa antes de esa fecha, el pedido se cancela.`;
const HELD_TU = `Listo, te apartamos tu pedido *B-0042* hasta el *jueves 19 de noviembre a las 12:30 p. m.*\n\nPásalo a recoger y pagar en ${STORE}\n\nSi no pasas antes de esa fecha, el pedido se cancela.`;
const ALREADY_PAID = 'Su pedido ya está pagado.';
const FAILED =
  'No pude apartar su pedido en este momento; puede pagar por transferencia o intentarlo de nuevo en unos minutos.';
const LEAD = 'Pedido con folio B-0042. Total a pagar: $30.00.';
const QUESTION = 'Para terminar solo falta el pago. ¿Cómo desea pagar?';

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

function setup(options: { enabled?: unknown } = {}) {
  const enabled = 'enabled' in options ? options.enabled : true;
  const store = new InMemoryConversationStore();
  const sale = {
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
    fulfillmentMode: 'PICKUP',
  };
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
        customer: {
          resolution: 'existing',
          customerId: CUSTOMER,
          firstName: 'Ana',
          lastName: null,
        },
        address: null,
        sale,
        pickupLocation: LOCATION,
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
    setPayInStoreIntent: jest.fn((saleId: string) =>
      Promise.resolve({ ...HOLD, saleId }),
    ),
    createSale: jest.fn(),
    upsertCustomer: jest.fn(),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? CASHIER
        : key === 'payInStore.enabled'
          ? enabled
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
  const receipts = {
    hasReceiptInReview: jest.fn(() => Promise.resolve(false)),
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
  const payment = new MinimalPaymentService(
    client,
    store,
    team,
    receipts,
    config,
  );
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
    extra: { interactiveReplyId?: string; inboundEvent?: unknown } = {},
    script: unknown[] = [say('Inventado')],
  ) => {
    steps = script;
    return agent.tryHandle({
      senderId: SENDER,
      text,
      inboundAt: '2026-11-18T18:00:00.000Z',
      ...extra,
    });
  };
  /** Real flow: pickup cart → delivery data confirmed → summary → SÍ. */
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
      { inboundEvent: EVENT('wamid.o1') },
      [call('prepareOrder'), say('Inventado')],
    );
    (offer as { onSent: () => void }).onSent();
    return turn('SÍ', { inboundEvent: EVENT('wamid.o2') });
  };
  /** A placed sale stored directly (no session offer). */
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
    seen,
    team,
    receipts,
    turn,
    placeOrder,
    seedPlacedSale,
    placedSale,
  };
}

type Harness = ReturnType<typeof setup>;
const PICKUP = { pickup: { checkoutKey: KEY, location: LOCATION } };
const tapInStore = (h: Harness, saleId = SALE) =>
  h.turn('Pagar en tienda', { interactiveReplyId: `pay:in_store:${saleId}` });
const reply = (decision: unknown) => (decision as { reply: string }).reply;
const buttons = (decision: unknown) =>
  (
    decision as {
      interactive?: { buttons?: Array<{ id: string; title: string }> };
    }
  ).interactive?.buttons;

describe('pay in store: the offer (S3)', () => {
  it('a pickup order with the flag on offers [Transferencia] [Pagar en tienda] and remembers the checkout key and store', async () => {
    const h = setup();
    const placed = await h.placeOrder();
    expect(reply(placed)).toContain(QUESTION);
    expect(buttons(placed)).toEqual([
      { id: `pay:transfer:${SALE}`, title: 'Transferencia' },
      { id: `pay:in_store:${SALE}`, title: 'Pagar en tienda' },
    ]);
    expect(await h.placedSale()).toEqual({
      saleId: SALE,
      folio: 'B-0042',
      totalCents: 3000,
      pickup: {
        checkoutKey: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        location: LOCATION,
      },
    });
  });

  it.each([
    ['off', false],
    ['unset', undefined],
    ['a non-boolean value', 'true'],
  ])(
    'flag %s: a pickup order offers only [Transferencia] and stores today’s placedSale',
    async (_name, enabled) => {
      const h = setup({ enabled });
      const placed = await h.placeOrder();
      expect(buttons(placed)).toEqual([
        { id: `pay:transfer:${SALE}`, title: 'Transferencia' },
      ]);
      expect(await h.placedSale()).toEqual({
        saleId: SALE,
        folio: 'B-0042',
        totalCents: 3000,
      });
      // A yes still means transfer (the single-method shortcut stays).
      const answered = await h.turn('sí');
      expect(reply(answered)).toContain('*CLABE:* 012180001234567891');
      expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
    },
  );

  it('a delivery order with the flag on offers only [Transferencia]', async () => {
    const h = setup();
    await h.seedPlacedSale();
    const decision = await h.turn('mi resumen');
    expect(reply(decision)).toBe(`${LEAD}\n\n${QUESTION}`);
    expect(buttons(decision)).toEqual([
      { id: `pay:transfer:${SALE}`, title: 'Transferencia' },
    ]);
  });

  it('the placed-order status of a pickup order shows both buttons', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    const decision = await h.turn('mi resumen');
    expect(reply(decision)).toBe(`${LEAD}\n\n${QUESTION}`);
    expect(buttons(decision)?.map((b) => b.id)).toEqual([
      `pay:transfer:${SALE}`,
      `pay:in_store:${SALE}`,
    ]);
  });

  it('follow-ups S6: a receipt in review hides [Pagar en tienda] from the placed-order status', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    h.receipts.hasReceiptInReview.mockResolvedValue(true);
    const decision = await h.turn('mi resumen');
    expect(buttons(decision)?.map((b) => b.id)).toEqual([
      `pay:transfer:${SALE}`,
    ]);
    expect(h.receipts.hasReceiptInReview).toHaveBeenCalledWith(SENDER, SALE);
    // A typed «en tienda» is still answered with the in-review text.
    expect(reply(await h.turn('en tienda'))).toContain(
      'Ya recibimos su comprobante del pedido B-0042',
    );
    expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
  });

  it('follow-ups S6: an unreadable receipt state keeps today’s offer (fails open)', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    h.receipts.hasReceiptInReview.mockRejectedValue(new Error('db down'));
    const decision = await h.turn('mi resumen');
    expect(buttons(decision)?.map((b) => b.id)).toEqual([
      `pay:transfer:${SALE}`,
      `pay:in_store:${SALE}`,
    ]);
  });

  it('a paid pickup order never shows [Pagar en tienda] (paid rule keeps priority)', async () => {
    const h = setup();
    await h.seedPlacedSale({ ...PICKUP, paid: true });
    const decision = await h.turn('mi resumen');
    expect(buttons(decision)).toBeUndefined();
    expect(reply(decision)).toContain(ALREADY_PAID);
  });

  it.each(['sí', 'claro', 'ok'])(
    'with two methods offered, a bare %p asks the payment question again with both buttons (no LLM)',
    async (text) => {
      const h = setup();
      await h.placeOrder();
      const llmCalls = h.seen.length;
      const decision = await h.turn(text);
      expect(reply(decision)).toBe(`${LEAD}\n\n${QUESTION}`);
      expect(buttons(decision)).toEqual([
        { id: `pay:transfer:${SALE}`, title: 'Transferencia' },
        { id: `pay:in_store:${SALE}`, title: 'Pagar en tienda' },
      ]);
      expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
      expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
      expect(h.seen.length).toBe(llmCalls);
      // The re-asked offer is still pending: a typed method answers it.
      expect(reply(await h.turn('transferencia'))).toContain(
        '*CLABE:* 012180001234567891',
      );
    },
  );

  it('with [Pagar en tienda] hidden by a receipt in review, a bare yes gets the in-review text (single shown method, no LLM)', async () => {
    const h = setup();
    await h.placeOrder();
    h.receipts.hasReceiptInReview.mockResolvedValue(true);
    const llmCalls = h.seen.length;
    const decision = await h.turn('sí');
    expect(reply(decision)).toContain(
      'Ya recibimos su comprobante del pedido B-0042',
    );
    expect(buttons(decision)).toBeUndefined();
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
    expect(h.seen.length).toBe(llmCalls);
  });

  it('typing «transferencia» after the two-button offer still sends the bank details', async () => {
    const h = setup();
    await h.placeOrder();
    const decision = await h.turn('transferencia');
    expect(reply(decision)).toContain('*CLABE:* 012180001234567891');
    expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
  });
});

describe('pay in store: the tap (S3)', () => {
  it('calls PATCH payment-intent once and replies the exact text with folio, deadline and store', async () => {
    const h = setup();
    await h.placeOrder();
    const llmCalls = h.seen.length;
    const decision = await tapInStore(h);
    expect(reply(decision)).toBe(HELD);
    expect(h.api.setPayInStoreIntent).toHaveBeenCalledTimes(1);
    expect(h.api.setPayInStoreIntent).toHaveBeenCalledWith(SALE);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.seen).toHaveLength(llmCalls);
  });

  it('follow-ups S7: a held order is recorded on placedSale.pickup (held) so a later receipt refusal can explain the expiry', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    expect(reply(await tapInStore(h))).toBe(HELD);
    expect((await h.placedSale())?.pickup).toEqual({
      checkoutKey: KEY,
      location: LOCATION,
      held: true,
    });
    // A re-tap keeps it; the order still reads and offers as before.
    expect(reply(await tapInStore(h))).toBe(HELD);
    expect((await h.placedSale())?.pickup?.held).toBe(true);
  });

  it('follow-ups S7: a failed PATCH records no hold', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    h.api.setPayInStoreIntent.mockRejectedValueOnce(new Error('boom'));
    expect(reply(await tapInStore(h))).toBe(FAILED);
    expect((await h.placedSale())?.pickup).toEqual({
      checkoutKey: KEY,
      location: LOCATION,
    });
  });

  it('a re-tap calls PATCH once more (idempotent upstream) and repeats the same text', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    expect(reply(await tapInStore(h))).toBe(HELD);
    expect(reply(await tapInStore(h))).toBe(HELD);
    expect(h.api.setPayInStoreIntent).toHaveBeenCalledTimes(2);
  });

  it.each(['en tienda', 'Pagar en tienda', 'prefiero pagar en la tienda'])(
    'typing %p after the offer is the same as the tap',
    async (text) => {
      const h = setup();
      await h.placeOrder();
      expect(reply(await h.turn(text))).toBe(HELD);
      expect(h.api.setPayInStoreIntent).toHaveBeenCalledTimes(1);
    },
  );

  it('a tú customer gets the tú text', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    await h.turn('oye, ver mi pedido');
    const decision = await tapInStore(h);
    expect(reply(decision)).toBe(HELD_TU);
  });

  it('a null folio and no known store still read well', async () => {
    const h = setup();
    await h.seedPlacedSale({
      folio: null,
      pickup: { checkoutKey: KEY, location: null },
    });
    h.api.setPayInStoreIntent.mockResolvedValueOnce({
      ...HOLD,
      folio: null,
    } as never);
    expect(reply(await tapInStore(h))).toBe(
      'Listo, le apartamos su pedido hasta el *jueves 19 de noviembre a las 12:30 p. m.*\n\nPáselo a recoger y pagar en la tienda.\n\nSi no pasa antes de esa fecha, el pedido se cancela.',
    );
  });

  it('409 PAY_IN_STORE_SALE_ALREADY_PAID answers «Su pedido ya está pagado.»', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    h.api.setPayInStoreIntent.mockRejectedValueOnce(
      new ChatbotApiError(
        'conflict',
        409,
        { error: 'PAY_IN_STORE_SALE_ALREADY_PAID' },
        'PAY_IN_STORE_SALE_ALREADY_PAID',
      ),
    );
    expect(reply(await tapInStore(h))).toBe(ALREADY_PAID);
    expect(h.api.setPayInStoreIntent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      '409 PAY_IN_STORE_SALE_NOT_CONFIRMED',
      new ChatbotApiError(
        'c',
        409,
        undefined,
        'PAY_IN_STORE_SALE_NOT_CONFIRMED',
      ),
    ],
    [
      '422 PAY_IN_STORE_REQUIRES_PICKUP',
      new ChatbotApiError('c', 422, undefined, 'PAY_IN_STORE_REQUIRES_PICKUP'),
    ],
    [
      '404 SALE_NOT_FOUND',
      new ChatbotApiError('c', 404, undefined, 'SALE_NOT_FOUND'),
    ],
    ['a 503', new UpstreamError('down', 503)],
    ['a timeout', new ChatbotApiError('timeout', null)],
    ['an unexpected error', new Error('boom')],
  ])(
    '%s answers the fixed failure text; a later «transferencia» still sends the details',
    async (_name, error) => {
      const h = setup();
      await h.seedPlacedSale(PICKUP);
      h.api.setPayInStoreIntent.mockRejectedValueOnce(error);
      expect(reply(await tapInStore(h))).toBe(FAILED);
      expect(h.api.setPayInStoreIntent).toHaveBeenCalledTimes(1);
      const after = await h.turn('transferencia');
      expect(reply(after)).toContain('*CLABE:* 012180001234567891');
    },
  );

  it('a paid order never calls PATCH and says it is paid', async () => {
    const h = setup();
    await h.seedPlacedSale({ ...PICKUP, paid: true });
    expect(reply(await tapInStore(h))).toBe(ALREADY_PAID);
    expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
  });

  it('a receipt in review keeps priority: no PATCH, the in-review text', async () => {
    const h = setup();
    await h.seedPlacedSale(PICKUP);
    h.receipts.hasReceiptInReview.mockResolvedValue(true);
    expect(reply(await tapInStore(h))).toBe(
      'Ya recibimos su comprobante del pedido B-0042 y lo estamos revisando; no hace falta que vuelva a pagar. Le aviso en cuanto quede confirmado.',
    );
    expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
  });

  it.each<[string, (h: Harness) => Promise<unknown>]>([
    [
      'another sale',
      (h) => h.seedPlacedSale(PICKUP).then(() => tapInStore(h, OTHER_SALE)),
    ],
    ['a delivery order', (h) => h.seedPlacedSale().then(() => tapInStore(h))],
    ['no placed order', (h) => tapInStore(h)],
    [
      'the flag turned off',
      async (h) => {
        await h.seedPlacedSale(PICKUP);
        return tapInStore(h);
      },
    ],
  ])('a tap for %s never calls PATCH', async (name, act) => {
    const h = setup({ enabled: name === 'the flag turned off' ? false : true });
    const decision = await act(h);
    expect(h.api.setPayInStoreIntent).not.toHaveBeenCalled();
    expect(reply(decision)).not.toContain('le apartamos');
  });
});

describe('T2 H4: the store pin rides with the order-created decision', () => {
  const COORDINATES = { latitude: 19.4326, longitude: -99.1332 };

  it('a pickup branch with coordinates → the decision carries the pin; the text is today’s', async () => {
    const today = reply(await setup().placeOrder());
    const h = setup();
    const created = (await h.api.createCheckout()) as Record<string, unknown>;
    h.api.createCheckout.mockImplementationOnce(() =>
      Promise.resolve({
        ...created,
        pickupLocation: { ...LOCATION, location: COORDINATES },
      } as never),
    );
    h.api.createCheckout.mockClear();
    const placed = await h.placeOrder();
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(reply(placed)).toBe(today);
    expect((placed as { location?: unknown }).location).toEqual({
      ...COORDINATES,
      name: 'Sucursal Centro',
      address:
        'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
    });
  });

  it('no coordinates → no pin on the decision', async () => {
    const placed = await setup().placeOrder();
    expect(placed).not.toHaveProperty('location');
  });
});
