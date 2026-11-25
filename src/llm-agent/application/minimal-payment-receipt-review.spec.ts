/**
 * Retest 2026-11-18 S3 (N19): a receipt already sent for the placed sale
 * (attached, waiting for review) means no second set of bank details.
 */
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
import { ReceiptReviewStatusRegistry } from '../domain/receipt-review-status';
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

const LEAD = 'Pedido con folio B-0042. Total a pagar: $30.00.';
const INSTRUCTIONS = [
  '*Pago por transferencia*',
  '*Banco:* BBVA',
  '*Beneficiario:* HoundFe SA de CV',
  '*CLABE:* 012180001234567891',
  '*Cuenta:* 0123456789',
  '',
  'Cuando haga la transferencia, envíe aquí la foto de su comprobante.',
].join('\n');

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
  // The receipt-media read as the composition root wires it.
  const inReview = {
    hasReceiptInReview: jest.fn(
      (...args: [senderId: string, saleId: string]): Promise<boolean> => {
        void args;
        return Promise.resolve(false);
      },
    ),
  };
  const receipts = new ReceiptReviewStatusRegistry();
  receipts.register(inReview);
  const payment = new MinimalPaymentService(client, store, team, receipts);
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
    inReview,
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

/** Retest 2026-11-18 S3 (N19) customer copy, verbatim. */
const IN_REVIEW_USTED =
  'Ya recibimos su comprobante del pedido B-0042 y lo estamos revisando; no hace falta que vuelva a pagar. Le aviso en cuanto quede confirmado.';
const IN_REVIEW_TU =
  'Ya recibimos tu comprobante del pedido B-0042 y lo estamos revisando; no hace falta que vuelvas a pagar. Te aviso en cuanto quede confirmado.';

describe('S3 (N19) receipt in review: no second set of bank details', () => {
  it('production case: order placed, receipt sent, the older Transferencia button is tapped', async () => {
    const h = setup();
    await h.placeOrder();
    h.inReview.hasReceiptInReview.mockResolvedValue(true);
    const llmCalls = h.seen.length;
    const decision = await tap(h);
    expect(reply(decision)).toBe(IN_REVIEW_USTED);
    expect(h.inReview.hasReceiptInReview).toHaveBeenCalledWith(SENDER, SALE);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.team.askTeam).not.toHaveBeenCalled();
    expect(h.seen).toHaveLength(llmCalls);
    expect(await h.placedSale()).not.toHaveProperty('paymentPending');
  });

  it('«¿A qué cuenta le transfiero?» answers the in-review text without the model (usted)', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.inReview.hasReceiptInReview.mockResolvedValue(true);
    const decision = await h.turn('¿A qué cuenta le transfiero?', [
      call('getPaymentDetails'),
      say('Inventado'),
    ]);
    expect(reply(decision)).toBe(IN_REVIEW_USTED);
    expect(h.seen).toHaveLength(0);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('«¿a qué cuenta te transfiero?» answers the in-review text in tú', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.inReview.hasReceiptInReview.mockResolvedValue(true);
    const decision = await h.turn('¿a qué cuenta te transfiero?', [
      call('getPaymentDetails'),
      say('Inventado'),
    ]);
    expect(reply(decision)).toBe(IN_REVIEW_TU);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it('a yes to the pending payment offer gets the in-review text too', async () => {
    const h = setup();
    await h.placeOrder();
    h.inReview.hasReceiptInReview.mockResolvedValue(true);
    expect(reply(await h.turn('transferencia'))).toBe(IN_REVIEW_USTED);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it('a payment question the model routes to getPaymentDetails gets the in-review text', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.inReview.hasReceiptInReview.mockResolvedValue(true);
    const decision = await h.turn('pásame otra vez lo del banco', [
      call('getPaymentDetails'),
      say('Inventado'),
    ]);
    expect(reply(decision)).toBe(IN_REVIEW_TU);
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(h.team.askTeam).not.toHaveBeenCalled();
  });

  it.each([
    'me faltó pagar el resto',
    'necesito transferir la diferencia',
    'quiero hacer otro pago',
  ])(
    '«%s» (paying the rest / another amount) gets the bank details',
    async (text) => {
      const h = setup();
      await h.seedPlacedSale();
      h.inReview.hasReceiptInReview.mockResolvedValue(true);
      const decision = await h.turn(text, [
        call('getPaymentDetails'),
        say('Inventado'),
      ]);
      expect(reply(decision)).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
      expect(h.api.getPaymentDetails).toHaveBeenCalledTimes(1);
      expect(h.team.askTeam).not.toHaveBeenCalled();
    },
  );

  it('after a REJECTED outcome (no receipt in review) the tap gives the details normally', async () => {
    const h = setup();
    await h.placeOrder();
    h.inReview.hasReceiptInReview.mockResolvedValue(false);
    expect(reply(await tap(h))).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
    expect(h.api.getPaymentDetails).toHaveBeenCalledTimes(1);
  });

  it('an unreadable receipt state fails open: the details are given', async () => {
    const h = setup();
    await h.seedPlacedSale();
    h.inReview.hasReceiptInReview.mockRejectedValue(new Error('db down'));
    expect(reply(await tap(h))).toBe(`${LEAD}\n\n${INSTRUCTIONS}`);
  });

  it('a paid order keeps «Su pedido ya está pagado.» for the tap and the question', async () => {
    const h = setup();
    await h.seedPlacedSale({ paid: true });
    h.inReview.hasReceiptInReview.mockResolvedValue(true);
    expect(reply(await tap(h))).toBe('Su pedido ya está pagado.');
    expect(reply(await h.turn('¿A qué cuenta le transfiero?'))).toBe(
      'Su pedido ya está pagado.',
    );
    expect(h.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it('without a registered receipt read nothing changes (details on tap)', async () => {
    const h = setup();
    await h.seedPlacedSale();
    const bare = new MinimalPaymentService(
      h.api as unknown as ChatbotApiClient,
      h.store,
    );
    expect((await bare.paymentDetails(SENDER))?.reply).toBe(
      `${LEAD}\n\n${INSTRUCTIONS}`,
    );
  });
});
