import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import type { CustomerReplyInteractive } from '../domain/customer-reply';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * S4 (owner): "Botones de WhatsApp. Por ejemplo "✅ Confirmar" / "✏️
 * Cambiar", o una lista para elegir la presentación." Buttons ride only on
 * the deterministic server-owned summaries and are bound to the summary they
 * were sent with; a list rides on the server presentation/product question.
 */
const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
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
const call = (toolName: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${toolName}-${Math.random()}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Listo.') => step([{ type: 'text', text }], 'stop');

type Decision = {
  reply: string;
  onSent?: () => void;
  interactive?: CustomerReplyInteractive;
};
const buttonIds = (decision: Decision): string[] =>
  decision.interactive?.type === 'buttons'
    ? decision.interactive.buttons.map((button) => button.id)
    : [];

function orderHarness() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async () => [
      {
        productId: PRODUCT,
        name: 'Ibuprofeno',
        price: { priceCents: 1500 },
        variants: [],
      },
    ]),
    getStock: jest.fn(async () => ({
      productId: PRODUCT,
      name: 'Ibuprofeno',
      stock: { status: 'available', quantity: 10 },
      variants: [],
    })),
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
    getCustomerCheckoutContext: jest.fn(async () => ({
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
    })),
    createSale: jest.fn(),
    createCheckout: jest.fn(async () => ({
      status: 'created',
      sale: {
        saleId: '55555555-5555-4555-8555-555555555555',
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
    })),
    getPaymentDetails: jest.fn(async () => ({
      id: 'pd',
      bankName: 'BBVA',
      beneficiary: 'HoundFe SA de CV',
      clabe: '012180001234567891',
      accountNumber: '0123456789',
      isActive: true,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })),
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
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const shipping = new MinimalShippingService(
    store,
    cart,
    checkout,
    { quote: jest.fn() } as never,
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
  const cartPin = [
    {
      productId: PRODUCT,
      quantity: 2,
      unitPriceCents: 1500,
      finalPriceCents: 3000,
    },
  ];
  const seed = (pickup: boolean) =>
    store.create(SENDER, {
      lastMessageAt: new Date().toISOString(),
      data: {
        minimalCart: {
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
          idempotencyKey: '',
          expectedTotalCents: 3000,
          ...(pickup ? { shipping: { mode: 'pickup', cartPin } } : {}),
        },
      },
    });
  const selectAddress = async () => {
    const lookup = await checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
  };
  return {
    api,
    seen,
    checkout,
    store,
    turn: async (
      text: string,
      script: unknown[],
      messageId: string,
      interactiveReplyId?: string,
    ): Promise<Decision> => {
      steps = script;
      return await agent.tryHandle({
        senderId: SENDER,
        text,
        inboundEvent: EVENT(messageId),
        ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
      });
    },
    /** Cart + pickup + confirmed delivery data: the order summary is next. */
    ready: async () => {
      await seed(true);
      await selectAddress();
      const offer = await checkout.prepareConfirmation(SENDER, EVENT('d1'));
      offer.onSent?.();
      await checkout.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('d2'),
      });
    },
    /** Cart + selected address, delivery data not confirmed yet. */
    unconfirmed: async () => {
      await seed(false);
      await selectAddress();
    },
    cartItems: async () =>
      (
        (await store.get(SENDER))?.data.minimalCart as
          | { items: unknown[] }
          | undefined
      )?.items,
  };
}

describe('S4 order summary buttons', () => {
  it('the summary carries ✅/✏️ buttons bound to it; tapping ✅ creates exactly one order', async () => {
    const h = orderHarness();
    await h.ready();
    const offer = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'o1',
    );
    expect(offer.reply).toContain('Resumen de su pedido:');
    expect(offer.interactive).toEqual({
      type: 'buttons',
      buttons: [
        {
          id: expect.stringMatching(/^order_confirm:.+/) as string,
          title: '✅ Confirmar pedido',
        },
        { id: 'order_change', title: '✏️ Cambiar algo' },
      ],
      prompt: '¿Confirma su pedido?',
    });
    offer.onSent?.();
    const confirm = buttonIds(offer)[0];

    const calls = h.seen.length;
    const placed = await h.turn('SÍ', [say('no')], 'o2', confirm);
    expect(h.seen).toHaveLength(calls);
    expect(placed.reply).toContain('folio B-0042');
    expect(placed.interactive).toBeUndefined();
    // A double tap never creates a second order.
    await h.turn('SÍ', [say('¿Algo más?')], 'o3', confirm);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('✏️ Cambiar algo asks what to change, keeps the cart and spends the summary', async () => {
    const h = orderHarness();
    await h.ready();
    const offer = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'o1',
    );
    offer.onSent?.();
    const before = await h.cartItems();
    const calls = h.seen.length;

    const change = await h.turn(
      'Quiero cambiar algo',
      [say('no debería usarse')],
      'o2',
      'order_change',
    );
    expect(change.reply).toBe('Claro, ¿qué desea cambiar?');
    expect(change.interactive).toBeUndefined();
    expect(h.seen).toHaveLength(calls);
    expect(await h.cartItems()).toEqual(before);
    // The old ✅ (or a typed SÍ) no longer creates that order.
    await h.turn('SÍ', [say('¿Qué desea cambiar?')], 'o3', buttonIds(offer)[0]);
    await h.turn('SÍ', [say('¿Qué desea cambiar?')], 'o4');
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('a ✅ from a superseded summary never creates the newer order; it re-presents the current one', async () => {
    const h = orderHarness();
    await h.ready();
    const first = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'o1',
    );
    first.onSent?.();
    const second = await h.turn(
      'Me muestra el resumen otra vez, por favor',
      [call('prepareOrder'), say()],
      'o2',
    );
    second.onSent?.();
    expect(buttonIds(second)[0]).not.toBe(buttonIds(first)[0]);

    const stale = await h.turn('SÍ', [say('no')], 'o3', buttonIds(first)[0]);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    expect(stale.reply).toMatch(/^Ese botón ya no está vigente\./);
    expect(stale.reply).toContain('Resumen de su pedido:');
    const current = buttonIds(stale)[0];
    expect(current).toMatch(/^order_confirm:/);
    expect([buttonIds(first)[0], buttonIds(second)[0]]).not.toContain(current);

    // The superseded second summary is spent too; only the current one sells.
    await h.turn('SÍ', [say('no')], 'o4', buttonIds(second)[0]);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('a ✅ when no order summary is pending creates nothing', async () => {
    const h = orderHarness();
    await h.ready();
    const offer = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'o1',
    );
    // Never sent: the gate was never armed.
    const reply = await h.turn('SÍ', [say('no')], 'o2', buttonIds(offer)[0]);
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    expect(reply.reply).not.toContain('folio');
  });

  it('an unknown button id goes to the model and never creates an order', async () => {
    const h = orderHarness();
    await h.ready();
    const offer = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'o1',
    );
    offer.onSent?.();
    const reply = await h.turn(
      'Sí',
      [say('¿En qué le ayudo?')],
      'o2',
      'promo_yes',
    );
    expect(reply.reply).toBe('¿En qué le ayudo?');
    await h.turn('SÍ', [say('¿Algo más?')], 'o3');
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('a tú customer gets the prompt in tú; titles keep their emoji', async () => {
    const h = orderHarness();
    await h.ready();
    const offer = await h.turn(
      'oye, ¿me puedes mostrar mi pedido?',
      [call('prepareOrder'), say()],
      'o1',
    );
    expect(offer.interactive).toMatchObject({
      prompt: '¿Confirmas tu pedido?',
      buttons: [{ title: '✅ Confirmar pedido' }, { title: '✏️ Cambiar algo' }],
    });
  });
});

describe('S4 delivery-data summary buttons', () => {
  it('the delivery summary carries its buttons; ✏️ Corregir datos asks which field', async () => {
    const h = orderHarness();
    await h.unconfirmed();
    const offer = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'd1',
    );
    expect(offer.reply).toMatch(/^Confirme sus datos de entrega:/);
    expect(offer.interactive).toEqual({
      type: 'buttons',
      buttons: [
        {
          id: expect.stringMatching(/^checkout_confirm:.+/) as string,
          title: '✅ Sí, son correctos',
        },
        { id: 'checkout_change', title: '✏️ Corregir datos' },
      ],
      prompt: '¿Son correctos sus datos de entrega?',
    });
    offer.onSent?.();
    const change = await h.turn(
      'Quiero corregir mis datos',
      [say('no')],
      'd2',
      'checkout_change',
    );
    expect(change.reply).toBe(
      'Entendido, no confirmé sus datos de entrega. ¿Qué dato quiere corregir?',
    );
    expect(h.checkout.confirmationStatus(SENDER)).toBeNull();
  });

  it('✅ Sí, son correctos confirms the data; a stale one re-presents instead', async () => {
    const h = orderHarness();
    await h.unconfirmed();
    const offer = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      'd1',
    );
    offer.onSent?.();
    const stale = await h.turn(
      'SÍ',
      [say('no')],
      'd2',
      'checkout_confirm:old-ref',
    );
    expect(stale.reply).toMatch(/^Ese botón ya no está vigente\./);
    expect(h.checkout.confirmationStatus(SENDER)).toMatchObject({
      stage: 'pending',
      armed: false,
    });
    stale.onSent?.();
    const confirmed = await h.turn(
      'SÍ',
      [say('no')],
      'd3',
      buttonIds(stale)[0],
    );
    expect(confirmed.reply).toContain(
      'sus datos de entrega quedaron confirmados',
    );
    expect(h.checkout.confirmationStatus(SENDER)).toMatchObject({
      stage: 'confirmed',
    });
  });
});

// ── Lists: presentation / product choice (EvalFakeApi catalog) ───────────
const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const variant = (p: number, v: number) =>
  `b0000000-0000-4000-8000-${String(p * 100 + v).padStart(12, '0')}`;
const registry = new MinimalCartSelections(SENDER);
const ref = (p: number, v?: number): string => {
  const reference = registry.register({
    productId: product(p),
    productName: 'Fixture',
    ...(v === undefined
      ? {}
      : { variantId: variant(p, v), variantName: 'Fixture variant' }),
  });
  if (reference === null) throw new Error('fixture ref');
  return reference;
};
const SILICE = 9;
const AGLOMERANTE = 8;
const KONG = 10;

function listHarness() {
  const api = new EvalFakeApi({ kind: 'new' });
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? CASHIER
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const cart = new MinimalCartService(api, store);
  let scripts: unknown[][] = [];
  const seen: Array<{ system?: unknown }> = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = scripts.shift() ?? [say()];
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
  };
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cart,
  );
  let n = 0;
  return {
    seen,
    turn: async (
      text: string,
      script: unknown[],
      interactiveReplyId?: string,
    ): Promise<Decision> => {
      scripts = [script];
      const result = (await agent.tryHandle({
        senderId: SENDER,
        text,
        inboundEvent: EVENT(`wamid.${(n += 1)}`),
        ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
      })) as Decision;
      result.onSent?.();
      return result;
    },
    lines: async () =>
      (
        (
          (await store.get(SENDER))?.data.minimalCart as
            | {
                items: Array<{
                  productId: string;
                  variantId?: string;
                  quantity: number;
                }>;
              }
            | undefined
        )?.items ?? []
      ).map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
      })),
  };
}

describe('S4 choice lists', () => {
  it('the presentation question carries a list; picking a row adds exactly that presentation', async () => {
    const h = listHarness();
    const question = await h.turn('quiero 2 kong', [
      call('searchCatalog', { q: 'kong' }),
      call('prepareCartItem', {
        selectionRef: ref(KONG),
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say('Listo.'),
    ]);
    expect(question.reply).toMatch(/¿Qué presentación desea agregar/);
    expect(question.interactive).toEqual({
      type: 'list',
      buttonText: 'Ver opciones',
      prompt: 'Elija una opción de la lista.',
      rows: [
        { id: `pick_variant:${ref(KONG, 1)}`, title: 'Chico — $249' },
        { id: `pick_variant:${ref(KONG, 2)}`, title: 'Mediano — $329' },
        { id: `pick_variant:${ref(KONG, 3)}`, title: 'Grande — $429' },
      ],
    });

    await h.turn(
      'Mediano — $329',
      [
        call('adjustCartItem', {
          selectionRef: ref(KONG, 2),
          delta: null,
          quantityText: null,
          continuation: true,
        }),
        say(),
      ],
      `pick_variant:${ref(KONG, 2)}`,
    );
    expect(String(h.seen.at(-1)?.system)).toContain(
      `selectionRef: ${ref(KONG, 2)}`,
    );
    expect(await h.lines()).toEqual([
      { productId: product(KONG), variantId: variant(KONG, 2), quantity: 2 },
    ]);
  });

  it('the product question carries a list of the shown products', async () => {
    const h = listHarness();
    await h.turn('Busco arena para gato.', [
      call('searchCatalog', { q: 'arena para gato' }),
      say(
        'Encontré dos opciones:\n1. Arena para Gato de Sílice 3.8 L, $179.00\n2. Arena para Gato Aglomerante Sin Aroma: 10 kg $219.00 o 20 kg $389.00\n¿Cuál desea?',
      ),
    ]);
    const question = await h.turn('Sí, agréguela por favor.', [
      call('adjustCartItem', {
        selectionRef: ref(SILICE),
        delta: 1,
        quantityText: null,
        continuation: false,
      }),
      say('Listo.'),
    ]);
    expect(question.reply).toMatch(/¿A cuál producto se refiere/);
    expect(question.interactive).toMatchObject({
      type: 'list',
      rows: expect.arrayContaining<unknown>([
        expect.objectContaining({
          id: `pick_product:${ref(SILICE)}`,
          title: 'Arena para Gato de Síli…',
          description: 'Arena para Gato de Sílice 3.8 L',
        }),
        expect.objectContaining({ id: `pick_product:${ref(AGLOMERANTE)}` }),
      ]) as unknown[],
    });
  });

  it('a pick that is not in the latest list gets no hint and writes only what the words support', async () => {
    const h = listHarness();
    await h.turn('quiero 2 kong', [
      call('searchCatalog', { q: 'kong' }),
      call('prepareCartItem', {
        selectionRef: ref(KONG),
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say(),
    ]);
    // An unrelated turn: the list is no longer the bot's latest message.
    await h.turn('¿Cuál es su horario?', [say('Abrimos de 9 a 7.')]);
    await h.turn(
      'Grande — $429',
      [say('¿Desea el Kong Grande?')],
      `pick_variant:${ref(KONG, 3)}`,
    );
    expect(String(h.seen.at(-1)?.system)).not.toContain('eligió en la lista');
    expect(await h.lines()).toEqual([]);
  });
});
