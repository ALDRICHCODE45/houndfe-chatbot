import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type {
  BackorderBot,
  BackorderClient,
} from '../../backorders/domain/backorder';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CreateCheckoutInput } from '../../chatbot-api/domain/dtos/checkout.dto';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { AskTeamOutcome } from '../../human-requests/application/human-request-create.service';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService } from './cost-guard.service';
import { MinimalBackorderConfirmService } from './minimal-backorder-confirm.service';
import { MinimalBackorderManageService } from './minimal-backorder-manage.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalPaymentService } from './minimal-payment.service';
import { MinimalShippingService } from './minimal-shipping.service';
import {
  BO_CROQUETAS,
  BO_DECISION,
  BO_FINAL_CENTS,
  BO_ID,
  BO_ID_2,
  BO_NOW,
  BO_PRODUCT,
  BO_SENDER,
  backorderCartLine,
  reservedBackorder,
} from './minimal-backorder-checkout.fixtures';

/**
 * Restock backorder T5b (S2, S6, S11) through the real customer turn: the
 * confirm tap or a bare yes puts the reserved backorder in the cart and the
 * NORMAL checkout continues; none of it calls the model.
 */
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const SALE = '55555555-5555-4555-8555-555555555555';
const CATALOG: Record<string, { name: string; price: number }> = {
  [BO_PRODUCT]: { name: 'Ibuprofeno', price: 1500 },
  [BO_CROQUETAS]: { name: 'Croquetas Adulto 18 kg', price: 120000 },
};
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: BO_SENDER,
  messageId,
});
const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const say = (text = 'Listo.') => step([{ type: 'text', text }], 'stop');

function setup(
  options: { reserved?: BackorderBot[]; all?: BackorderBot[] } = {},
) {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn((name: string) => {
      const [productId, entry] = Object.entries(CATALOG).find(
        ([, v]) => v.name === name,
      )!;
      return Promise.resolve([
        {
          productId,
          name: entry.name,
          price: { priceCents: entry.price },
          variants: [],
        },
      ]);
    }),
    getStock: jest.fn((productId: string) =>
      Promise.resolve({
        productId,
        name: CATALOG[productId].name,
        stock: { status: 'available', quantity: 10 },
        variants: [],
      }),
    ),
    evaluateCart: jest.fn(
      (
        items: Array<{
          productId: string;
          quantity: number;
          unitPriceCents: number;
        }>,
      ) =>
        Promise.resolve({
          items: items.map((item) => ({
            productId: item.productId,
            variantId: null,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            originalPriceCents: item.unitPriceCents * item.quantity,
            finalPriceCents: item.unitPriceCents * item.quantity,
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
          totalCents: 219800,
          paidCents: 0,
          debtCents: 219800,
          confirmedAt: null,
          discountCents: 0,
        },
      }),
    ),
    getCheckoutStatus: jest.fn(() =>
      Promise.resolve({ status: 'not_observed', checkout: null }),
    ),
    getPaymentDetails: jest.fn(),
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
  const reserved = options.reserved ?? [reservedBackorder()];
  const all = options.all ?? reserved;
  const backorders = {
    createBackorder: jest.fn(),
    getBackorder: jest.fn((id: string) => {
      const found = all.find((item) => item.id === id);
      return found === undefined
        ? Promise.reject(new Error('missing'))
        : Promise.resolve(found);
    }),
    listBackorders: jest.fn((query?: { status?: string }) =>
      Promise.resolve(
        all.filter(
          (item) =>
            query?.status === undefined ||
            query.status.split(',').includes(item.status),
        ),
      ),
    ),
    cancelBackorder: jest.fn(),
  } satisfies Record<keyof BackorderClient, jest.Mock>;
  const manage = new MinimalBackorderManageService({
    backorders,
    clock: () => BO_NOW,
  });
  const confirm = new MinimalBackorderConfirmService({
    backorders,
    chatbotApi: client,
    clock: () => BO_NOW,
  });
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
    shipping,
    undefined,
    undefined,
    team,
    payment,
    undefined,
    manage,
    confirm,
  );
  const turn = (
    text: string,
    script: unknown[] = [say('Modelo')],
    extra: { interactiveReplyId?: string; inboundEvent?: unknown } = {},
  ) => {
    steps = script;
    return agent.tryHandle({
      senderId: BO_SENDER,
      text,
      inboundAt: '2026-11-20T15:00:00.000Z',
      ...extra,
    });
  };
  const slot = async () =>
    (await store.get(BO_SENDER))?.data.minimalCart as
      | { items: Array<Record<string, any>> }
      | undefined;
  const seedCart = (items: object[]) =>
    store.commitMinimalCart(
      BO_SENDER,
      undefined,
      { items, idempotencyKey: '' },
      '2026-11-20T14:00:00.000Z',
    );
  return {
    api,
    backorders,
    cart,
    sessionStore,
    store,
    seen,
    turn,
    slot,
    seedCart,
  };
}
const reply = (decision: unknown) => (decision as { reply: string }).reply;
const buttons = (decision: unknown) =>
  (
    decision as {
      interactive?: { buttons?: Array<{ id: string; title: string }> };
    }
  ).interactive?.buttons ?? [];
const TAP = `backorder_confirm:${BO_ID}`;
const ADDED =
  'Listo, su pedido apartado BO-000012 (2 × Croquetas Adulto 18 kg) ya está en su carrito a $1099.00 MXN c/u. Se lo tenemos apartado hasta el 21 de noviembre a las 9:00 a. m.';

describe('restock backorder confirm through the customer turn', () => {
  beforeEach(() =>
    jest.useFakeTimers({
      now: BO_NOW,
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'hrtime',
      ],
    }),
  );
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('the Confirm tap puts the reserved backorder in the cart at its final price and offers the next step, without the model', async () => {
    const h = setup();
    const decision = await h.turn('Confirmo mi pedido apartado', [], {
      interactiveReplyId: TAP,
    });

    expect(reply(decision)).toBe(
      [
        ADDED,
        '',
        '*Su carrito*\n• Croquetas Adulto 18 kg (pedido apartado BO-000012)\n   2 × $1,099.00 = *$2,198.00*\n\n*Total de productos: $2,198.00*\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
        '',
        '¿Desea agregar algo más o seguimos con su compra?',
      ].join('\n'),
    );
    expect(buttons(decision).map((b) => b.title)).toEqual([
      'Seguir con la compra',
      'Agregar algo más',
    ]);
    expect(h.seen).toHaveLength(0);
    expect((await h.slot())?.items).toEqual([backorderCartLine()]);
  });

  it('a pending cart is NOT a blocker for the tap: the line joins the ordinary one', async () => {
    const h = setup();
    await h.seedCart([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
    ]);
    const decision = await h.turn('Confirmo mi pedido apartado', [], {
      interactiveReplyId: TAP,
    });
    expect(reply(decision)).toContain('• Ibuprofeno\n   1 × $15.00 = *$15.00*');
    expect(reply(decision)).toContain('(pedido apartado BO-000012)');
    expect(reply(decision)).toContain('*Total de productos: $2,213.00*');
    expect((await h.slot())?.items).toHaveLength(2);
    expect(h.seen).toHaveLength(0);
  });

  it('the tap of a backorder that is not confirmable gets the honest answer and the cart is untouched', async () => {
    const h = setup({
      all: [
        reservedBackorder({ status: 'CONFIRMED', saleId: SALE }),
        reservedBackorder({ id: BO_ID_2, status: 'EXPIRED' }),
      ],
    });
    const confirmed = await h.turn('Confirmo', [], { interactiveReplyId: TAP });
    expect(reply(confirmed)).toBe('Ese pedido ya está confirmado.');
    const expired = await h.turn('Confirmo', [], {
      interactiveReplyId: `backorder_confirm:${BO_ID_2}`,
    });
    expect(reply(expired)).toBe(
      'Se venció el apartado de su pedido BO-000012.',
    );
    expect(await h.slot()).toBeUndefined();
    expect(h.seen).toHaveLength(0);
  });

  it('serves a tú customer in tú, with the same facts', async () => {
    const h = setup();
    await h.turn('oye, ¿qué onda? dime si tienes collares', [say('Modelo')]);
    const decision = await h.turn('Confirmo mi pedido apartado', [], {
      interactiveReplyId: TAP,
    });
    expect(reply(decision)).toContain('Te lo tenemos apartado hasta');
    expect(reply(decision)).toContain('tu carrito');
  });

  it('after the tap the NORMAL checkout runs: fulfilment, summary, SÍ → createCheckout with backorderId and the final price', async () => {
    const h = setup();
    await h.turn('Confirmo mi pedido apartado', [], {
      interactiveReplyId: TAP,
    });
    const asked = await h.turn('Quiero comprar', []);
    const pickup = buttons(asked).find((b) =>
      b.id.startsWith('fulfil_pickup:'),
    );
    expect(pickup).toBeDefined();

    const summary = await h.turn('Recoger en tienda', [], {
      interactiveReplyId: pickup!.id,
      inboundEvent: EVENT('wamid.s1'),
    });
    expect(reply(summary)).toContain('*Resumen de su pedido* 🧾');
    expect(reply(summary)).toContain(
      '• Croquetas Adulto 18 kg (pedido apartado BO-000012)\n   2 × $1,099.00 = *$2,198.00*',
    );
    expect(reply(summary)).toContain('*Total a pagar: $2,198.00*');
    (summary as { onSent: () => void }).onSent();

    await h.turn('SÍ', [], { inboundEvent: EVENT('wamid.s2') });
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    const body = (
      h.api.createCheckout.mock.calls as unknown as Array<[CreateCheckoutInput]>
    )[0][0];
    expect(body.sale.items).toEqual([
      {
        productId: BO_CROQUETAS,
        variantId: null,
        productName: 'Croquetas Adulto 18 kg',
        variantName: null,
        quantity: 2,
        unitPriceCents: BO_FINAL_CENTS,
        backorderId: BO_ID,
      },
    ]);
    expect(body.sale.expectedTotalCents).toBe(2 * BO_FINAL_CENTS);
    expect(h.seen).toHaveLength(0);
  });

  it('a customer asking to change the line is told it comes from the apartado and the cart is unchanged', async () => {
    const h = setup();
    await h.turn('Confirmo mi pedido apartado', [], {
      interactiveReplyId: TAP,
    });
    const before = await h.slot();
    // The model's cart call for «déjame 3 croquetas» is refused by the cart.
    const result = await h.cart.setItem(
      BO_SENDER,
      { productId: BO_CROQUETAS, quantity: 3 },
      new Set([BO_CROQUETAS]),
    );
    expect(result).toEqual({ ok: false, error: 'backorder_line_locked' });
    expect(await h.slot()).toEqual(before);
  });
});

describe('the bare yes only confirms when nothing else could own it', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['sí', 'Confirmo', 'sí lo quiero'])(
    '«%s» with one RESERVED backorder and no competing order adds it, without the model',
    async (text) => {
      const h = setup();
      const decision = await h.turn(text, []);
      expect(reply(decision)).toContain(ADDED.split('.')[0]);
      expect((await h.slot())?.items).toEqual([backorderCartLine()]);
      expect(h.seen).toHaveLength(0);
    },
  );

  it('a cart with items is a competing order: the yes is not ours (no backorder read, the model answers)', async () => {
    const h = setup();
    await h.seedCart([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
    ]);
    const decision = await h.turn('sí', [say('Modelo')]);
    expect(reply(decision)).toBe('Modelo');
    expect(h.backorders.listBackorders).not.toHaveBeenCalled();
    expect((await h.slot())?.items).toHaveLength(1);
  });

  it('several RESERVED backorders: not ours', async () => {
    const h = setup({
      reserved: [
        reservedBackorder(),
        reservedBackorder({ id: BO_ID_2, productId: BO_PRODUCT }),
      ],
    });
    const decision = await h.turn('sí', [say('Modelo')]);
    expect(reply(decision)).toBe('Modelo');
    expect(await h.slot()).toBeUndefined();
  });

  it('a reserved backorder that is not RESERVED (waiting) is not ours', async () => {
    const h = setup({ reserved: [reservedBackorder({ status: 'WAITING' })] });
    expect(reply(await h.turn('sí', [say('Modelo')]))).toBe('Modelo');
  });

  it("the bot's latest message asked something else: the yes answers THAT, not the apartado", async () => {
    const h = setup();
    await h.turn('hola', [say('¿Le muestro más opciones de collares?')]);
    const decision = await h.turn('sí', [say('Modelo')]);
    expect(reply(decision)).toBe('Modelo');
    expect(h.backorders.listBackorders).not.toHaveBeenCalled();
    expect(await h.slot()).toBeUndefined();
  });

  it('…unless that question is about the apartado itself', async () => {
    const h = setup();
    await h.turn('hola', [
      say('Su pedido apartado BO-000012 ya llegó. ¿Lo confirma?'),
    ]);
    const decision = await h.turn('sí', []);
    expect(reply(decision)).toContain('Listo, su pedido apartado BO-000012');
    expect((await h.slot())?.items).toHaveLength(1);
  });

  it('a yes with no reserved backorder at all goes to the model, as before', async () => {
    const h = setup({ reserved: [], all: [] });
    expect(reply(await h.turn('sí', [say('Modelo')]))).toBe('Modelo');
  });

  it('a non-yes message never reaches the backorder client', async () => {
    const h = setup();
    expect(reply(await h.turn('tienen collares?', [say('Modelo')]))).toBe(
      'Modelo',
    );
    expect(h.backorders.listBackorders).not.toHaveBeenCalled();
  });
});

describe('reschedule taps through the customer turn', () => {
  afterEach(() => jest.restoreAllMocks());

  it('the reschedule tap schedules again from the same decision; the decline answers «Entendido.»', async () => {
    const expired = reservedBackorder({
      status: 'EXPIRED',
      sourceDecisionId: BO_DECISION,
    });
    const h = setup({ all: [expired] });
    h.backorders.createBackorder.mockResolvedValue({
      created: true,
      backorder: reservedBackorder({
        id: BO_ID_2,
        folio: 'BO-000020',
        status: 'WAITING',
        reservedUntil: null,
        finalPriceCents: null,
      }),
    });
    const scheduled = await h.turn('SÍ', [], {
      interactiveReplyId: `backorder_reschedule:${BO_ID}`,
    });
    expect(reply(scheduled)).toContain(
      'Listo, quedó agendado su pedido BO-000020',
    );
    expect(h.backorders.createBackorder).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDecisionId: BO_DECISION, quantity: 2 }),
      `backorder-reschedule:${BO_ID}`,
    );

    const declined = await h.turn('No, gracias', [], {
      interactiveReplyId: `backorder_reschedule_decline:${BO_ID}`,
    });
    expect(reply(declined)).toBe('Entendido.');
    expect(h.seen).toHaveLength(0);
  });

  it('without a sourceDecisionId it answers honestly and offers the team', async () => {
    const h = setup({ all: [reservedBackorder({ status: 'EXPIRED' })] });
    const decision = await h.turn('SÍ', [], {
      interactiveReplyId: `backorder_reschedule:${BO_ID}`,
    });
    expect(reply(decision)).toContain(
      'No puedo agendarlo de nuevo de forma automática',
    );
    expect(h.backorders.createBackorder).not.toHaveBeenCalled();
  });
});

describe('without the confirm capability (test seam) nothing changes', () => {
  it('a backorder tap is the stale-button fallback and a yes goes to the model', async () => {
    const api = {} as unknown as ChatbotApiClient;
    const agent = new MinimalCatalogAgentService(
      api,
      (async () => ({ text: 'Modelo', steps: [], toolCalls: [] })) as never,
      new CostGuardService(100000),
      {
        get: () => ({ model: 'm', maxSteps: 5, historyTurns: 12 }),
      } as unknown as ConfigService,
      new InMemoryMinimalCatalogSessionStore(),
    );
    const decision = await agent.tryHandle({
      senderId: BO_SENDER,
      text: 'Confirmo mi pedido apartado',
      interactiveReplyId: TAP,
    });
    expect(reply(decision)).toContain('¿Qué desea hacer?');
  });
});
