import { Logger } from '@nestjs/common';
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
import { markPlacedSalePaid } from './minimal-paid-sale';
import { MinimalPaymentService } from './minimal-payment.service';
import { MinimalShippingService } from './minimal-shipping.service';

const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SALE = '55555555-5555-4555-8555-555555555555';
const OTHER_SALE = '66666666-6666-4666-8666-666666666666';
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const LEAD = 'Pedido con folio B-0042. Total a pagar: $30.00 MXN.';
const INSTRUCTIONS = [
  'Para pagar por transferencia:',
  'Banco: BBVA',
  'Beneficiario: HoundFe SA de CV',
  'CLABE: 012180001234567891',
  'Cuenta: 0123456789',
  'Cuando haga la transferencia, envíe aquí la foto de su comprobante.',
].join('\n');
const UNAVAILABLE =
  'No pude obtener los datos en este momento; ya le avisé al equipo y se los comparto en cuanto estén.';

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
  };
}

type Harness = ReturnType<typeof setup>;
const tap = (h: Harness, saleId = SALE) =>
  h.turn('Transferencia', [say('Inventado')], {
    interactiveReplyId: `pay:transfer:${saleId}`,
  });
const reply = (decision: unknown) => (decision as { reply: string }).reply;

describe('payment step after the order (S3)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('tapping Transferencia fetches the details now and sends folio, amount and instructions', async () => {
    const h = setup();
    await h.placeOrder();
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    const llmCalls = h.seen.length;
    const decision = await tap(h);
    expect(reply(decision)).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
    expect(h.api.getPaymentDetails).toHaveBeenCalledTimes(1);
    expect(h.seen).toHaveLength(llmCalls);
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it.each(['sí', 'Si, por favor', 'transferencia', 'Por transferencia'])(
    'answering %p to the pending offer sends the details',
    async (text) => {
      const h = setup();
      await h.placeOrder();
      const llmCalls = h.seen.length;
      const decision = await h.turn(text);
      expect(reply(decision)).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
      expect(h.api.getPaymentDetails).toHaveBeenCalledTimes(1);
      expect(h.seen).toHaveLength(llmCalls);
    },
  );

  it('a yes after the offer was spent by another turn does not fetch the details', async () => {
    const h = setup();
    await h.placeOrder();
    await h.turn('Gracias', [say('De nada.')]);
    const llmCalls = h.seen.length;
    await h.turn('sí', [say('Claro.')]);
    expect(h.seen).toHaveLength(llmCalls + 1);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it('a button bound to another sale never fetches the details', async () => {
    const h = setup();
    await h.seedPlacedSale();
    const decision = await tap(h, OTHER_SALE);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(reply(decision)).not.toContain('CLABE');
  });

  it('a tap without any placed sale never fetches the details', async () => {
    const h = setup();
    const decision = await tap(h);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(reply(decision)).not.toContain('CLABE');
  });
});

describe('payment question any time after an order (S4)', () => {
  it('exposes getPaymentDetails only with a placed sale and answers with the S3 text, never askTeam', async () => {
    const h = setup();
    await h.seedPlacedSale();
    const decision = await h.turn('¿A qué cuenta le transfiero?', [
      call('getPaymentDetails'),
      say('Texto inventado por el modelo'),
    ]);
    expect(Object.keys(h.seen[0].tools ?? {})).toContain('getPaymentDetails');
    expect(reply(decision)).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
    expect(h.api.getPaymentDetails).toHaveBeenCalledTimes(1);
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('does not expose the tool without a placed sale', async () => {
    const h = setup();
    await h.turn('datos de pago');
    expect(Object.keys(h.seen[0].tools ?? {})).not.toContain(
      'getPaymentDetails',
    );
  });

  it('the ask-team prompt excludes payments and the payment tool prompt forbids askTeam for them', async () => {
    const h = setup();
    await h.seedPlacedSale();
    await h.turn('datos de pago');
    const system = String(h.seen[0].system);
    expect(system).toMatch(/askTeam[\s\S]*no la uses para[\s\S]*pagos/);
    expect(system).toContain('Herramienta getPaymentDetails');
  });
});

describe('details unavailable (S5, S6)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('replies verbatim, stores the marker and asks the team once for the same sale', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.api.getPaymentDetails.mockRejectedValue(new UpstreamError('down', 503));
    const first = await tap(h);
    expect(reply(first)).toBe(UNAVAILABLE);
    expect(await h.placedSale()).toEqual({
      saleId: SALE,
      folio: 'B-0042',
      totalCents: 3000,
      paymentPending: true,
    });
    expect(h.team.askTeam).toHaveBeenCalledTimes(1);
    expect(h.team.askTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: SENDER,
        question: expect.stringContaining('B-0042') as string,
        summary: expect.stringContaining('B-0042') as string,
        inboundAt: '2026-11-16T12:00:00.000Z',
      }),
    );
    const [[request]] = h.team.askTeam.mock.calls as unknown as Array<
      [{ question: string }]
    >;
    expect(request.question).toMatch(/transferencia/i);
    // A repeated failure retries the fetch but never duplicates the request.
    expect(reply(await tap(h))).toBe(UNAVAILABLE);
    expect(h.api.getPaymentDetails).toHaveBeenCalledTimes(2);
    expect(h.team.askTeam).toHaveBeenCalledTimes(1);
  });

  it('a paid mark that lands while the details fail sets no marker, creates no request and says it is paid', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.api.getPaymentDetails.mockImplementation(async () => {
      // The receipt poller confirms the payment while the read is in flight.
      expect(await markPlacedSalePaid(h.store, SENDER, SALE)).toBe(true);
      throw new UpstreamError('down', 503);
    });
    const answer = await tap(h);
    expect(reply(answer)).toBe('Su pedido ya está pagado.');
    expect(h.team.askTeam).not.toHaveBeenCalled();
    expect(await h.placedSale()).toEqual({
      saleId: SALE,
      folio: 'B-0042',
      totalCents: 3000,
      paid: true,
    });
  });

  it('a later yes retries; success clears the marker and sends the details', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.api.getPaymentDetails.mockRejectedValueOnce(new UpstreamError('d', 503));
    await tap(h);
    expect(await h.placedSale()).toMatchObject({ paymentPending: true });
    const decision = await h.turn('sí');
    expect(reply(decision)).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
    expect(await h.placedSale()).toEqual({
      saleId: SALE,
      folio: 'B-0042',
      totalCents: 3000,
    });
    expect(h.team.askTeam).toHaveBeenCalledTimes(1);
  });

  it('a later payment question retries through the tool', async () => {
    const h = setup();
    await h.seedPlacedSale({ paymentPending: true });
    const decision = await h.turn('datos de pago', [
      call('getPaymentDetails'),
      say('Inventado'),
    ]);
    expect(reply(decision)).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
    expect(await h.placedSale()).not.toHaveProperty('paymentPending');
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('keeps no marker when the request could not be created, so the next failure asks again', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.api.getPaymentDetails.mockRejectedValue(new UpstreamError('down', 503));
    h.team.askTeam.mockResolvedValueOnce({
      kind: 'failed',
      reason: 'unavailable',
    });
    expect(reply(await tap(h))).toBe(UNAVAILABLE);
    expect(await h.placedSale()).not.toHaveProperty('paymentPending');
    await tap(h);
    expect(h.team.askTeam).toHaveBeenCalledTimes(2);
    expect(await h.placedSale()).toMatchObject({ paymentPending: true });
  });

  it('logs a warn with status and error code, with no bank data or message text', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = setup();
    await h.seedPlacedSale();
    h.api.getPaymentDetails.mockRejectedValueOnce(
      new ChatbotApiError(
        'BBVA 012180001234567891 secret-detail',
        404,
        { clabe: '012180001234567891' },
        'PAYMENT_DETAILS_NOT_FOUND',
      ),
    );
    await tap(h);
    const lines = warn.mock.calls.map((args) => String(args[0]));
    const line = lines.find((text) => text.includes('payment details'));
    expect(line).toBeDefined();
    expect(line).toMatch(/status=404/);
    expect(line).toContain('PAYMENT_DETAILS_NOT_FOUND');
    for (const text of lines) {
      expect(text).not.toMatch(/BBVA|0121800|secret-detail|HoundFe/);
    }
  });
});

describe('stored state compatibility (S7)', () => {
  it('parses a placedSale written before the marker and one with it', () => {
    const cart = (placedSale: object) => ({
      items: [],
      idempotencyKey: '',
      placedSale,
    });
    const legacy = { saleId: SALE, folio: 'B-0042', totalCents: 3000 };
    expect(parseMinimalCart(cart(legacy))?.placedSale).toEqual(legacy);
    expect(
      parseMinimalCart(cart({ ...legacy, paymentPending: true }))?.placedSale,
    ).toEqual({ ...legacy, paymentPending: true });
    expect(
      parseMinimalCart(cart({ ...legacy, paymentPending: false })),
    ).toBeNull();
  });

  it('an order stored before this change still offers payment on a button tap', async () => {
    const h: Harness = setup();
    await h.seedPlacedSale();
    expect(reply(await tap(h))).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
  });
});
