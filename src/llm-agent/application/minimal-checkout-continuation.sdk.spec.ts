import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ShippingQuoteResponse } from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * F1 (live eval 2026-11-07): once the customer confirms the delivery data
 * the flow continues by itself to the order summary; no magic phrase, and
 * neutral turns never loop back to the delivery-data summary.
 */
const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const event = (messageId: string) => ({
  senderId: SENDER,
  messageId,
  receivingPhoneNumberId: '123456789012345',
});
const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (toolName: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${toolName}-${Math.random()}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Texto del modelo.') =>
  step([{ type: 'text', text }], 'stop');
const freeQuote = (): ShippingQuoteResponse => ({
  quoteId: 'q1',
  expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
  zoneStatus: 'FREE',
  option: null,
  costCents: 0,
  creditCents: 0,
  customerChargeCents: 0,
  currency: 'MXN',
  eta: { days: 1, reason: null },
});
const DETAILS_KEYS = [
  'firstName',
  'lastName',
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
] as const;
const details = (values: Partial<Record<string, string>>) => ({
  ...Object.fromEntries(DETAILS_KEYS.map((key) => [key, values[key] ?? null])),
  useNewAddress: false,
});

const DELIVERY_SUMMARY = /^Confirm[ae] (sus|tus) datos de entrega:/m;
const ORDER_ENDING =
  'Responda "SÍ" para crear el pedido, o dígame qué quiere cambiar.';

async function setup() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async () => [
      {
        productId: PRODUCT,
        name: 'Croquetas',
        price: { priceCents: 1500 },
        variants: [],
      },
    ]),
    getStock: jest.fn(async () => ({
      productId: PRODUCT,
      name: 'Croquetas',
      stock: { status: 'available', quantity: 10 },
      variants: [],
    })),
    evaluateCart: jest.fn(async (items: Array<{ quantity: number }>) => ({
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
    })),
    getCustomerCheckoutContext: jest.fn(async () => ({
      status: 'unique',
      customer: { customerId: CUSTOMER, firstName: 'Mariana', lastName: null },
      addresses: [
        {
          id: ADDRESS,
          version: '2026-10-01T00:00:00.000Z',
          label: 'Casa',
          street: 'Av. Coyoacán',
          exteriorNumber: '1200',
          interiorNumber: null,
          zipCode: '03100',
          neighborhood: 'Del Valle Centro',
          municipality: 'Benito Juárez',
          city: null,
          state: 'Ciudad de México',
          visualReferences: null,
          carrierPhone: null,
        },
      ],
      nextAfterAddressId: null,
    })),
    createSale: jest.fn(),
    createCheckout: jest.fn(async () => ({
      status: 'created',
      sale: {
        saleId: '55555555-5555-4555-8555-555555555555',
        folio: 'B-42',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 1500,
        paidCents: 0,
        debtCents: 1500,
        confirmedAt: null,
        discountCents: 0,
      },
    })),
    getPaymentDetails: jest.fn(async () => ({
      id: 'pd',
      bankName: 'BBVA',
      beneficiary: 'HoundFe',
      clabe: '012180001234567891',
      accountNumber: null,
      isActive: true,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? '99999999-9999-4999-8999-999999999999'
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
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
  );
  let script: unknown[] = [];
  let calls = 0;
  const generate: GenerateTextFn = async (input) => {
    calls += 1;
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
  };
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
    shipping,
  );
  await store.create(SENDER, {
    lastMessageAt: new Date().toISOString(),
    data: {
      minimalCart: {
        items: [{ productId: PRODUCT, quantity: 1, unitPriceCents: 1500 }],
        idempotencyKey: '',
        expectedTotalCents: 1500,
      },
    },
  });
  let n = 0;
  const turn = async (text: string, steps: unknown[] = [say()]) => {
    script = steps;
    const result = await agent.tryHandle({
      senderId: SENDER,
      text,
      inboundEvent: event(`wamid.${(n += 1)}`),
    });
    if (result.kind !== 'handled') throw new Error('reply');
    // The transport accepted every reply.
    result.onSent?.();
    return result.reply;
  };
  /** Saved address selected and its delivery summary sent (eval turn 4). */
  const presentDelivery = async () => {
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    const reply = await turn('Sí, a mi dirección de casa', [
      call('selectCheckoutAddress', {
        addressRef: lookup.addresses[0].addressRef,
      }),
      call('confirmCheckoutDetails'),
      call('requestShippingQuote'),
      call('prepareOrder'),
      say(),
    ]);
    expect(reply).toMatch(DELIVERY_SUMMARY);
    return reply;
  };
  return {
    api,
    quotes,
    checkout,
    turn,
    presentDelivery,
    llmCalls: () => calls,
  };
}

describe('F1 checkout continues to the order summary by itself', () => {
  it('the delivery summary has no bureaucratic disclaimer (F2)', async () => {
    const h = await setup();
    const reply = await h.presentDelivery();
    expect(reply).not.toMatch(/no crea un pedido|solo en este chat/);
  });

  it('"Sí, por favor 🙏" → shipping + order summary (no magic phrase) → "claro" → exactly one order', async () => {
    const h = await setup();
    await h.presentDelivery();
    h.quotes.enqueue(freeQuote());
    const before = h.llmCalls();
    const summary = await h.turn('Sí, por favor 🙏');
    expect(h.llmCalls()).toBe(before);
    expect(summary).not.toContain('hacer pedido');
    expect(summary).not.toMatch(/no crea un pedido|solo en este chat/);
    expect(summary).toContain(
      'Su envío al código postal 03100 no tiene costo.',
    );
    expect(summary.endsWith(ORDER_ENDING)).toBe(true);
    expect(h.quotes.calls).toHaveLength(1);
    expect(h.api.createCheckout).not.toHaveBeenCalled();

    const created = await h.turn('claro');
    expect(created).toContain('Su pedido quedó registrado con folio B-42.');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    await h.turn('ok');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('neutral turns after the confirmation never loop back to the delivery summary', async () => {
    const h = await setup();
    await h.presentDelivery();
    h.quotes.enqueue(freeQuote()).enqueue(freeQuote());
    await h.turn('Sí, por favor 🙏');
    const draft = await h.checkout.confirmedDraft(SENDER);
    expect(draft).not.toBeNull();

    // The eval's loop: the model re-runs the checkout tools on a neutral turn
    // and echoes the rendered "Calle" line back into the street.
    const again = await h.turn('Envío a domicilio', [
      call('confirmCheckoutDetails'),
      call('requestShippingQuote'),
      call('prepareOrder'),
      call('updateCheckoutDetails', details({ street: 'Av. Coyoacán 1200' })),
      say(),
    ]);
    expect(again).not.toMatch(DELIVERY_SUMMARY);
    expect(again.endsWith(ORDER_ENDING)).toBe(true);
    expect(await h.checkout.confirmedDraft(SENDER)).toEqual(draft);

    await h.turn('va');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0].sale;
    expect(payload).toMatchObject({ shipping: { quoteId: 'q1' } });
  });

  it('a delivery confirmation with an undeliverable ZIP offers pickup instead of a summary', async () => {
    const h = await setup();
    await h.presentDelivery();
    h.quotes.enqueue({
      ...freeQuote(),
      zoneStatus: 'DENIED',
      quoteId: null,
      expiresAt: null,
      costCents: 0,
      creditCents: 0,
      customerChargeCents: 0,
      eta: { days: null, reason: null },
    });
    const reply = await h.turn('claro');
    expect(reply).toContain('Por ahora no tenemos entrega a su código postal');
    expect(reply).not.toContain(ORDER_ENDING);
    await h.turn('sí');
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('store pickup shows the order summary in the same reply → "claro" → one pickup order', async () => {
    const h = await setup();
    const chosen = await h.turn('Prefiero recogerlo en tienda.', [
      call('chooseStorePickup'),
      call('prepareOrder'),
      say(),
    ]);
    expect(chosen).toContain('recoge su pedido en tienda');
    expect(chosen).not.toContain('hacer pedido');
    expect(chosen).toContain('Recoge en tienda (sin costo de envío)');
    expect(chosen.endsWith(ORDER_ENDING)).toBe(true);
    expect(h.quotes.calls).toHaveLength(0);

    await h.turn('claro');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0].sale;
    expect(payload).toMatchObject({ shipping: { mode: 'pickup' } });
  });

  it('a quote requested by the model is followed by the order summary', async () => {
    const h = await setup();
    await h.presentDelivery();
    // Confirmation without the continuation quote (unavailable provider).
    const confirmed = await h.turn('sí');
    expect(confirmed).toContain('No pude calcular el envío');
    h.quotes.enqueue(freeQuote());
    const quoted = await h.turn('¿y ahora?', [
      call('requestShippingQuote'),
      say(),
    ]);
    expect(quoted).not.toContain('hacer pedido');
    expect(quoted.endsWith(ORDER_ENDING)).toBe(true);
    await h.turn('sí');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
});
