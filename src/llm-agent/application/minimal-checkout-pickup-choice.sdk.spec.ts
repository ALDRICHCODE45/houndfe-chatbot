import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ShippingQuoteResponse } from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { CustomerReplyInteractive } from '../domain/customer-reply';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * Retest 2026-11-18 S4 (N15): when checkout starts («quiero comprar» or
 * [Seguir con la compra]) and store pickup is available, the bot first asks
 * how the customer wants the order, with two buttons. «Envío a domicilio»
 * continues with today's delivery-data flow; «Recoger en tienda» goes to the
 * pickup summary. Explicit wording skips the question; without pickup the
 * flow is unchanged.
 */
const SENDER = '5215550001111';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const QUESTION =
  '¿Se lo enviamos a su dirección o prefiere recogerlo en tienda?';
const QUESTION_TU =
  '¿Te lo enviamos a tu dirección o prefieres recogerlo en tienda?';
// Message formatting F3a: the bold heading line, usted or tú.
const DELIVERY_SUMMARY = /^\*Confirm[ae] (sus|tus) datos de entrega\*$/m;
const ORDER_ENDING =
  '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.';

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

type Decision = {
  reply: string;
  interactive?: CustomerReplyInteractive;
  onSent?: () => void;
};

async function setup(options: { pickup?: boolean; cart?: boolean } = {}) {
  const pickup = options.pickup ?? true;
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
    getPaymentDetails: jest.fn(),
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
    pickup ? shipping : undefined,
  );
  await store.create(SENDER, {
    lastMessageAt: new Date().toISOString(),
    data:
      options.cart === false
        ? {}
        : {
            minimalCart: {
              items: [
                { productId: PRODUCT, quantity: 1, unitPriceCents: 1500 },
              ],
              idempotencyKey: '',
              expectedTotalCents: 1500,
            },
          },
  });
  let n = 0;
  const send = async (
    text: string,
    steps: unknown[] = [say()],
    interactiveReplyId?: string,
  ): Promise<Decision> => {
    script = steps;
    const result = await agent.tryHandle({
      senderId: SENDER,
      text,
      inboundEvent: {
        senderId: SENDER,
        messageId: `wamid.${(n += 1)}`,
        receivingPhoneNumberId: '123456789012345',
      },
      ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
    });
    if (result.kind !== 'handled') throw new Error('reply');
    result.onSent?.();
    return result;
  };
  /** Delivery flow scripted the way the model runs it today. */
  const deliverySteps = async () => {
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    return [
      call('selectCheckoutAddress', {
        addressRef: lookup.addresses[0].addressRef,
      }),
      call('confirmCheckoutDetails'),
      say(),
    ];
  };
  return {
    api,
    store,
    cart,
    checkout,
    quotes,
    send,
    deliverySteps,
    llmCalls: () => calls,
  };
}

const buttonByTitle = (decision: Decision, title: string): string => {
  const id =
    decision.interactive?.type === 'buttons'
      ? decision.interactive.buttons.find((button) => button.title === title)
          ?.id
      : undefined;
  if (id === undefined) throw new Error(`no ${title} button`);
  return id;
};
const titles = (decision: Decision) =>
  decision.interactive?.type === 'buttons'
    ? decision.interactive.buttons.map((button) => button.title)
    : [];

describe('S4 (N15) checkout start asks delivery or store pickup', () => {
  it.each(['quiero comprar', 'Quiero comprar.', 'Seguir con la compra'])(
    'typed «%s» asks the question with two buttons, no model run',
    async (text) => {
      const h = await setup();
      const asked = await h.send(text, [
        call('lookupCheckoutCustomer', { nextPageRef: null }),
        say('Tengo su dirección guardada.'),
      ]);
      expect(asked.reply).toBe(QUESTION);
      expect(titles(asked)).toEqual(['Envío a domicilio', 'Recoger en tienda']);
      expect(h.llmCalls()).toBe(0);
      expect(h.api.getCustomerCheckoutContext).not.toHaveBeenCalled();
    },
  );

  it('the [Seguir con la compra] button asks the question', async () => {
    const h = await setup();
    const reference = await h.cart.fingerprint(SENDER);
    const asked = await h.send(
      'Quiero comprar',
      [say()],
      `cart_continue:${reference}`,
    );
    expect(asked.reply).toBe(QUESTION);
    expect(titles(asked)).toEqual(['Envío a domicilio', 'Recoger en tienda']);
    expect(h.llmCalls()).toBe(0);
  });

  it('a tú customer gets the tú question', async () => {
    const h = await setup();
    await h.send('hola, tienes croquetas?', [say('Sí, tenemos.')]);
    const asked = await h.send('quiero comprar porfa');
    expect(asked.reply).toBe(QUESTION_TU);
    expect(titles(asked)).toEqual(['Envío a domicilio', 'Recoger en tienda']);
  });

  it('«Recoger en tienda» goes to the pickup summary and the first ✅ creates the order', async () => {
    const h = await setup();
    const asked = await h.send('quiero comprar');
    const before = h.llmCalls();
    const pickup = await h.send(
      'Recoger en tienda',
      [say()],
      buttonByTitle(asked, 'Recoger en tienda'),
    );
    expect(h.llmCalls()).toBe(before);
    expect(pickup.reply).toMatch(
      /^Listo, usted recoge su pedido en tienda, sin costo de envío\./,
    );
    expect(pickup.reply).toContain('*Envío:* recoge en tienda — sin costo');
    expect(pickup.reply.endsWith(ORDER_ENDING)).toBe(true);
    expect(await h.cart.shippingMode(SENDER)).toBe('pickup');
    const confirm =
      pickup.interactive?.type === 'buttons'
        ? pickup.interactive.buttons[0].id
        : '';
    const created = await h.send('SÍ', [say()], confirm);
    expect(created.reply).toContain(
      '*¡Pedido registrado!* ✅\n*Folio:* B-42\n',
    );
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('«Envío a domicilio» continues with today’s delivery-data flow', async () => {
    const h = await setup();
    const asked = await h.send('quiero comprar');
    const delivery = await h.send(
      'Envío a domicilio',
      await h.deliverySteps(),
      buttonByTitle(asked, 'Envío a domicilio'),
    );
    expect(delivery.reply).toMatch(DELIVERY_SUMMARY);
    expect(await h.cart.shippingMode(SENDER)).toBeNull();
    h.quotes.enqueue(freeQuote());
    const confirmed = await h.send(
      'SÍ',
      [say()],
      delivery.interactive?.type === 'buttons'
        ? delivery.interactive.buttons[0].id
        : '',
    );
    expect(confirmed.reply).toContain('*Resumen de su pedido* 🧾');
  });

  it('a delivery/pickup button from a cart that changed re-presents the cart', async () => {
    const h = await setup();
    const asked = await h.send('quiero comprar');
    // The customer added another unit after the question was sent.
    const raw = (await h.store.get(SENDER))?.data.minimalCart;
    expect(
      await h.store.commitMinimalCart(
        SENDER,
        raw,
        {
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
          idempotencyKey: '',
          expectedTotalCents: 3000,
        },
        new Date().toISOString(),
      ),
    ).toBe(true);
    const stale = await h.send(
      'Recoger en tienda',
      [say()],
      buttonByTitle(asked, 'Recoger en tienda'),
    );
    expect(stale.reply).toContain('Su carrito');
    expect(await h.cart.shippingMode(SENDER)).toBeNull();
    expect(h.llmCalls()).toBe(0);
  });

  it('a typed answer to the question goes to the model (no second question)', async () => {
    const h = await setup();
    await h.send('quiero comprar');
    const answer = await h.send('a domicilio porfa', await h.deliverySteps());
    expect(answer.reply).toMatch(DELIVERY_SUMMARY);
    expect(h.llmCalls()).toBe(1);
  });
});

describe('S4 explicit wording skips the question', () => {
  it('«quiero comprar para recoger en tienda» goes straight to pickup', async () => {
    const h = await setup();
    const pickup = await h.send('quiero comprar para recoger en tienda', [
      call('chooseStorePickup'),
      say(),
    ]);
    expect(pickup.reply).not.toContain(QUESTION);
    expect(pickup.reply.endsWith(ORDER_ENDING)).toBe(true);
    expect(h.llmCalls()).toBe(1);
  });

  it('«envíamelo a mi casa» goes straight to the delivery data', async () => {
    const h = await setup();
    const delivery = await h.send(
      'envíamelo a mi casa',
      await h.deliverySteps(),
    );
    expect(delivery.reply).not.toContain('recogerlo en tienda?');
    expect(delivery.reply).toMatch(DELIVERY_SUMMARY);
  });
});

describe('S4 without pickup or cart the flow is unchanged', () => {
  it('pickup unavailable: «quiero comprar» runs today’s delivery flow', async () => {
    const h = await setup({ pickup: false });
    const delivery = await h.send('quiero comprar', await h.deliverySteps());
    expect(delivery.reply).not.toContain(QUESTION);
    expect(delivery.reply).toMatch(DELIVERY_SUMMARY);
    expect(h.llmCalls()).toBe(1);
  });

  it('empty cart: «quiero comprar» is left to the model', async () => {
    const h = await setup({ cart: false });
    const reply = await h.send('quiero comprar', [
      say('Su carrito está vacío.'),
    ]);
    expect(reply.reply).not.toContain(QUESTION);
    expect(h.llmCalls()).toBe(1);
  });

  it('a pickup already chosen: «quiero comprar» does not ask again', async () => {
    const h = await setup();
    await h.send('prefiero recoger en tienda', [
      call('chooseStorePickup'),
      say(),
    ]);
    const again = await h.send('quiero comprar', [call('prepareOrder'), say()]);
    expect(again.reply).not.toContain(QUESTION);
  });
});
