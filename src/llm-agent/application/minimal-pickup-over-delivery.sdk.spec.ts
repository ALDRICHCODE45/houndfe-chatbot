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
 * Retest 2026-11-18 S2 (N17): «prefiero recogerlo en tienda» while the
 * delivery-data confirmation [✅ Sí, son correctos] was pending. The pickup
 * summary's [✅ Confirmar pedido] must create the order on the FIRST tap and
 * never answer the older delivery-data question.
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
// Message formatting F3a: the bold heading line, usted or tú.
const DELIVERY_SUMMARY = /^\*Confirm[ae] (sus|tus) datos de entrega\*$/m;
const ORDER_ENDING =
  '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.';

async function setup(options: { branch?: true } = {}) {
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
  // T2-fix J4: the branch read (getStoreInfo) next to the checkout.
  if (options.branch === true)
    Object.assign(api, {
      getBranch: jest.fn(async () => ({
        name: 'Sucursal Centro',
        address: null,
        hours: { timeZone: 'America/Mexico_City', days: [], summary: '9 a 7' },
        location: { latitude: 19.4, longitude: -99.1 },
      })),
    });
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
  const offered: string[][] = [];
  const generate: GenerateTextFn = async (input) => {
    calls += 1;
    offered.push(Object.keys(input.tools ?? {}));
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
  const send = async (
    text: string,
    steps: unknown[] = [say()],
    interactiveReplyId?: string,
  ) => {
    script = steps;
    const result = await agent.tryHandle({
      senderId: SENDER,
      text,
      inboundEvent: event(`wamid.${(n += 1)}`),
      ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
    });
    if (result.kind !== 'handled') throw new Error('reply');
    // The transport accepted every reply.
    result.onSent?.();
    return result;
  };
  const turn = async (text: string, steps: unknown[] = [say()]) =>
    (await send(text, steps)).reply;
  /** Saved address selected and its delivery summary sent (with buttons). */
  const presentDelivery = async () => {
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    // Retest S4 (N15): «quiero comprar» first asks delivery or pickup; the
    // customer taps «Envío a domicilio» and today's delivery flow runs.
    const asked = await send('quiero comprar');
    const presented = await send(
      'Envío a domicilio',
      [
        call('selectCheckoutAddress', {
          addressRef: lookup.addresses[0].addressRef,
        }),
        call('confirmCheckoutDetails'),
        say(),
      ],
      buttonId(asked.interactive, 'fulfil_delivery:'),
    );
    expect(presented.reply).toMatch(DELIVERY_SUMMARY);
    return presented;
  };
  return {
    api,
    quotes,
    checkout,
    send,
    turn,
    presentDelivery,
    llmCalls: () => calls,
    lastTools: () => offered.at(-1) ?? [],
  };
}

const CONFIRMED_DELIVERY = /datos de entrega quedaron confirmados/;
const buttonId = (
  interactive:
    | { type: string; buttons?: readonly { id: string }[] }
    | undefined,
  prefix: string,
): string => {
  const id = interactive?.buttons?.find((button) =>
    button.id.startsWith(prefix),
  )?.id;
  if (id === undefined) throw new Error(`no ${prefix} button`);
  return id;
};

describe('S2 (N17) store pickup dismisses a pending delivery-data confirmation', () => {
  async function pickupOverPendingDelivery() {
    const h = await setup();
    await h.presentDelivery();
    expect(h.checkout.confirmationStatus(SENDER)?.stage).toBe('pending');
    const pickup = await h.send('prefiero recogerlo en tienda', [
      call('chooseStorePickup'),
      say(),
    ]);
    expect(pickup.reply).toContain('recoge su pedido en tienda');
    expect(pickup.reply).toContain('*Envío:* recoge en tienda — sin costo');
    expect(pickup.reply.endsWith(ORDER_ENDING)).toBe(true);
    expect(pickup.reply).not.toMatch(CONFIRMED_DELIVERY);
    return { h, pickup };
  }

  it('choosing pickup drops the pending delivery-data confirmation', async () => {
    const { h } = await pickupOverPendingDelivery();
    expect(h.checkout.confirmationStatus(SENDER)).toBeNull();
  });

  it('the FIRST ✅ Confirmar pedido tap creates the pickup order', async () => {
    const { h, pickup } = await pickupOverPendingDelivery();
    const tapped = await h.send(
      'SÍ',
      [say()],
      buttonId(pickup.interactive, 'order_confirm:'),
    );
    expect(tapped.reply).not.toMatch(CONFIRMED_DELIVERY);
    expect(tapped.reply).toContain('*¡Pedido registrado!* ✅\n*Folio:* B-42\n');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const payload = (
      h.api.createCheckout.mock.calls[0] as unknown as [
        { sale: Record<string, unknown> },
      ]
    )[0].sale;
    expect(payload).toMatchObject({ shipping: { mode: 'pickup' } });
  });

  it('a typed SÍ after the pickup summary creates the order at once', async () => {
    const { h } = await pickupOverPendingDelivery();
    const typed = await h.turn('SÍ');
    expect(typed).not.toMatch(CONFIRMED_DELIVERY);
    expect(typed).toContain('*¡Pedido registrado!* ✅\n*Folio:* B-42\n');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('the stale ✅ Sí, son correctos tap after pickup never confirms delivery data', async () => {
    const h = await setup();
    const delivery = await h.presentDelivery();
    await h.send('prefiero recogerlo en tienda', [
      call('chooseStorePickup'),
      say(),
    ]);
    const stale = await h.send(
      'SÍ',
      [say()],
      buttonId(delivery.interactive, 'checkout_confirm:'),
    );
    expect(stale.reply).not.toMatch(CONFIRMED_DELIVERY);
    expect(h.checkout.confirmationStatus(SENDER)).toBeNull();
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('delivery path unchanged: ✅ Sí, son correctos confirms the data and shows the order summary', async () => {
    const h = await setup();
    const delivery = await h.presentDelivery();
    h.quotes.enqueue(freeQuote());
    const confirmed = await h.send(
      'SÍ',
      [say()],
      buttonId(delivery.interactive, 'checkout_confirm:'),
    );
    expect(confirmed.reply).toMatch(
      /^Gracias, sus datos de entrega quedaron confirmados\.\n\n\*Resumen de su pedido\* 🧾\n/,
    );
    expect(confirmed.reply.endsWith(ORDER_ENDING)).toBe(true);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    const created = await h.send(
      'SÍ',
      [say()],
      buttonId(confirmed.interactive, 'order_confirm:'),
    );
    expect(created.reply).toContain(
      '*¡Pedido registrado!* ✅\n*Folio:* B-42\n',
    );
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
});

/**
 * T2-fix J4: while a checkout step is pending (delivery-data summary, order
 * summary, the delivery-or-pickup question), «paso a recoger» is a pickup
 * choice: getStoreInfo and its instruction are not offered, so the pickup
 * is selected exactly as before and no store block or pin is added.
 */
describe('T2-fix J4: «paso a recoger» during checkout selects pickup', () => {
  const pickupAfterDelivery = async (branch: boolean) => {
    const h = await setup(branch ? { branch: true } : {});
    await h.presentDelivery();
    const pickup = await h.send('paso a recoger', [
      call('chooseStorePickup'),
      say(),
    ]);
    return { h, pickup };
  };

  it('pending delivery-data summary: pickup selected as before, no store tool, block or pin', async () => {
    const before = await pickupAfterDelivery(false);
    const after = await pickupAfterDelivery(true);
    expect(after.h.lastTools()).toContain('chooseStorePickup');
    expect(after.h.lastTools()).not.toContain('getStoreInfo');
    expect(after.pickup.reply).toBe(before.pickup.reply);
    expect(after.pickup.reply).toContain(
      '*Envío:* recoge en tienda — sin costo',
    );
    expect(after.pickup.reply).not.toContain('Sucursal Centro');
    expect(after.pickup).not.toHaveProperty('location');
  });

  it('pending order summary: no store tool', async () => {
    const { h } = await pickupAfterDelivery(true);
    await h.send('¿dónde están?', [say()]);
    expect(h.lastTools()).not.toContain('getStoreInfo');
  });

  it('after the delivery-or-pickup question: no store tool', async () => {
    const h = await setup({ branch: true });
    const asked = await h.send('quiero comprar');
    expect(asked.interactive).toBeDefined();
    await h.send('paso a recoger', [call('chooseStorePickup'), say()]);
    expect(h.lastTools()).not.toContain('getStoreInfo');
  });

  it('nothing pending: the store tool is offered', async () => {
    const h = await setup({ branch: true });
    await h.send('hola', [say()]);
    expect(h.lastTools()).toContain('getStoreInfo');
  });
});
