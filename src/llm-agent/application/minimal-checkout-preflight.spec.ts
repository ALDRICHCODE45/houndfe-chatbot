import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import type { MinimalRestockRequestService } from './minimal-restock-request.service';
import type { MinimalExpirationRequestService } from './minimal-expiration-request.service';
import {
  CART_OPERATION_CLARIFICATION,
  CART_UNKNOWN_REFERENCE_REPLY,
} from './minimal-cart-conversation';

const ID = '11111111-1111-4111-8111-111111111111';
const SENDER = '5215550001111';
const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (name = 'reviewCheckout', input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: name,
      toolName: name,
      input: JSON.stringify(input),
    },
  ]);
const say = step(
  [{ type: 'text', text: 'Su pedido está confirmado y el envío es gratis.' }],
  'stop',
);

function setup(
  options: {
    empty?: boolean;
    cartAvailable?: boolean;
    enabled?: boolean;
    restock?: MinimalRestockRequestService;
    expiration?: MinimalExpirationRequestService;
  } = {},
) {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn().mockResolvedValue([
      {
        productId: ID,
        name: 'Product',
        price: { priceCents: 1500 },
        variants: [],
      },
    ]),
    getStock: jest.fn().mockResolvedValue({
      productId: ID,
      name: 'Product',
      stock: { status: 'available', quantity: 10 },
      variants: [],
    }),
    evaluateCart: jest.fn().mockResolvedValue({
      items: [
        {
          productId: ID,
          variantId: null,
          quantity: 2,
          unitPriceCents: 1500,
          originalPriceCents: 3000,
          finalPriceCents: 3000,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    }),
    createSale: jest.fn(),
    upsertCustomer: jest.fn(),
    attachReceipt: jest.fn(),
    getPaymentDetails: jest.fn(),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: (key: string) =>
      key === 'minimalCatalogAgent'
        ? { enabled: options.enabled !== false, allowedSenders: [SENDER] }
        : { model: 'm', maxSteps: 5, historyTurns: 12 },
  } as unknown as ConfigService;
  let steps: unknown[] = [call(), say];
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
  const outputs: unknown[] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const result = await generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: steps } as never),
    });
    outputs.push(
      ...result.steps.flatMap((s) => s.toolResults.map((r) => r.output)),
    );
    return result;
  };
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    options.restock,
    options.expiration,
    options.cartAvailable === false
      ? undefined
      : new MinimalCartService(api, store),
  );
  const seed = async () =>
    store.create(
      SENDER,
      structuredClone({
        lastMessageAt: '2026-10-10T00:00:00.000Z',
        data: {
          minimalCart: {
            items: options.empty
              ? []
              : [{ productId: ID, quantity: 2, unitPriceCents: 1200 }],
            idempotencyKey: '',
            expectedTotalCents: options.empty ? 0 : 2400,
          },
          cart: { legacy: 'preserved' },
          shippingApproval: { legacy: 'preserved' },
          placedSaleId: 'previous-sale',
        },
      }),
    );
  return {
    store,
    api,
    agent,
    seen,
    outputs,
    seed,
    steps: (value: unknown[]) => {
      steps = value;
    },
  };
}

async function review(f: ReturnType<typeof setup>, inboundEvent?: unknown) {
  await f.seed();
  const before = structuredClone(await f.store.get(SENDER));
  const write = jest.spyOn(f.store, 'update');
  const create = jest.spyOn(f.store, 'create');
  const cartWrite = jest.spyOn(f.store, 'commitMinimalCart');
  const result = await f.agent.tryHandle({
    senderId: SENDER,
    text: 'Quiero revisar mi compra',
    ...(inboundEvent === undefined ? {} : { inboundEvent }),
  });
  expect(await f.store.get(SENDER)).toEqual(before);
  expect(write).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(cartWrite).not.toHaveBeenCalled();
  expect(f.api.createSale).not.toHaveBeenCalled();
  expect(f.api.upsertCustomer).not.toHaveBeenCalled();
  expect(f.api.attachReceipt).not.toHaveBeenCalled();
  expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
  return result;
}

describe('Read-only checkout preflight through the public minimal SDK route', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses fresh backend prices, never saved totals, and discloses every remaining step without an order claim', async () => {
    const f = setup();
    const result = await review(f);
    expect(f.api.getStock).toHaveBeenCalledWith(ID);
    expect(f.api.searchCatalog).toHaveBeenCalledWith('Product', 20);
    expect(f.api.evaluateCart).toHaveBeenCalledWith([
      { productId: ID, quantity: 2, unitPriceCents: 1500 },
    ]);
    expect(f.outputs).toContainEqual({
      ok: true,
      status: 'incomplete',
      productsSubtotalCents: 3000,
      missing: [
        'customer_and_address',
        'approved_shipping',
        'explicit_confirmation',
      ],
      orderCreated: false,
    });
    expect(result).toEqual({
      kind: 'handled',
      reply:
        'Revisión de compra: subtotal de productos $30.00 MXN. No incluye envío. Falta confirmar sus datos y dirección, obtener un envío aprobado y confirmar explícitamente el total final. No se creó ningún pedido ni se reservaron existencias.',
    });
    expect(String(f.seen[0].system)).toContain('reviewCheckout');
    expect(Object.keys(f.seen[0].tools ?? {})).not.toContain('createSale');
    expect(Object.keys(f.seen[0].tools ?? {})).not.toContain(
      'getShippingQuote',
    );
  });

  it('blocks an empty cart without backend reads or invented success', async () => {
    const f = setup({ empty: true });
    const result = await review(f);
    expect(f.outputs).toContainEqual({
      ok: false,
      status: 'blocked',
      reason: 'empty_cart',
      orderCreated: false,
    });
    expect(result).toEqual({
      kind: 'handled',
      reply:
        'Su carrito está vacío. Agregue productos antes de revisar la compra. No se creó ningún pedido.',
    });
    expect(f.api.getStock).not.toHaveBeenCalled();
    expect(f.api.searchCatalog).not.toHaveBeenCalled();
    expect(f.api.evaluateCart).not.toHaveBeenCalled();
  });

  it.each(['insufficient', 'failure', 'invalid_price'] as const)(
    'blocks unverified cart (%s) without changing state',
    async (failure) => {
      const f = setup();
      if (failure === 'insufficient')
        f.api.getStock.mockResolvedValue({
          productId: ID,
          name: 'Product',
          stock: { status: 'available', quantity: 1 },
          variants: [],
        });
      if (failure === 'failure')
        f.api.getStock.mockRejectedValue(new Error('private-backend-detail'));
      if (failure === 'invalid_price')
        f.api.evaluateCart.mockResolvedValue({
          items: [],
          promotionEvaluationStatus: 'fully_evaluated',
        });
      const result = await review(f);
      expect(f.outputs).toContainEqual({
        ok: false,
        status: 'blocked',
        reason: 'cart_unverified',
        orderCreated: false,
      });
      expect(result).toEqual({
        kind: 'handled',
        reply:
          'No pude verificar los precios y existencias del carrito para revisar la compra. No se creó ningún pedido ni se modificó su carrito.',
      });
    },
  );

  it('blocks promotion review instead of treating it as checkout approval', async () => {
    const f = setup();
    f.api.evaluateCart.mockImplementation(async (input) => ({
      items: input.map((i) => ({
        ...i,
        variantId: null,
        originalPriceCents: 3000,
        finalPriceCents: 3000,
        discountAmountCents: 0,
        appliedPromotionTitle: null,
      })),
      promotionEvaluationStatus: 'needs_human_review',
    }));
    const result = await review(f);
    expect(f.outputs).toContainEqual({
      ok: false,
      status: 'blocked',
      reason: 'promotion_review',
      orderCreated: false,
    });
    expect(result).toEqual({
      kind: 'handled',
      reply:
        'Las promociones o precios de su carrito requieren revisión del equipo antes de continuar con la compra. Esta revisión no registró una solicitud ni creó un pedido.',
    });
  });

  it('does not let a later getCart or model text replace the checkout preflight', async () => {
    const f = setup();
    f.steps([call(), call('getCart'), say]);
    const result = await review(f);
    expect(result.kind === 'handled' && result.reply).toContain(
      'Revisión de compra: subtotal de productos $30.00 MXN.',
    );
  });

  it('rejects model-supplied sender and prices before execution without a purchase claim', async () => {
    const f = setup();
    f.steps([
      call('reviewCheckout', { senderId: 'other', priceCents: 1 }),
      say,
    ]);
    expect(await review(f)).toEqual({
      kind: 'handled',
      reply: CART_OPERATION_CLARIFICATION,
    });
    expect(f.api.getStock).not.toHaveBeenCalled();
    expect(f.api.evaluateCart).not.toHaveBeenCalled();
    expect(f.outputs).not.toContainEqual(
      expect.objectContaining({ status: 'incomplete' }),
    );
  });

  it('preserves an authoritative preflight when a later malformed review is rejected', async () => {
    const f = setup();
    f.steps([call(), call('reviewCheckout', { priceCents: 1 }), say]);
    const result = await review(f);
    expect(result.kind === 'handled' && result.reply).toContain(
      'Revisión de compra: subtotal de productos $30.00 MXN.',
    );
    expect(f.api.getStock).toHaveBeenCalledTimes(1);
    expect(f.api.evaluateCart).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'after'] as const)(
    'preserves cart clarification when review runs %s it',
    async (order) => {
      const f = setup();
      const invalid = call('adjustCartItem', {
        selectionRef: 'unknown-ref',
        delta: 1,
        quantityText: 'una',
        continuation: false,
      });
      f.steps(
        order === 'before' ? [call(), invalid, say] : [invalid, call(), say],
      );
      expect(await review(f)).toEqual({
        kind: 'handled',
        reply: CART_UNKNOWN_REFERENCE_REPLY,
      });
    },
  );

  it.each(['before', 'after'] as const)(
    'preserves a real cart mutation acknowledgement when review runs %s it',
    async (order) => {
      const f = setup();
      await f.seed();
      const reference = new MinimalCartSelections(SENDER).register({
        productId: ID,
        productName: 'Product',
      });
      const mutation = call('setCartItem', {
        selectionRef: reference,
        quantity: 2,
        quantityText: '2',
        continuation: false,
      });
      f.steps(
        order === 'before'
          ? [call('getCart'), call(), mutation, say]
          : [call('getCart'), mutation, call(), say],
      );
      const result = await f.agent.tryHandle({
        senderId: SENDER,
        text: 'Déjeme 2 unidades de Product',
      });
      expect(result).toEqual({
        kind: 'handled',
        reply:
          'Su carrito:\n• Product: 2 × $15.00 MXN; importe $30.00 MXN\nTotal de productos: $30.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
      });
      const state = await f.store.get(SENDER);
      expect(state?.data.minimalCart).toEqual({
        items: [{ productId: ID, quantity: 2, unitPriceCents: 1500 }],
        idempotencyKey: '',
        expectedTotalCents: 3000,
      });
      expect(state?.data.cart).toEqual({ legacy: 'preserved' });
      expect(state?.data.shippingApproval).toEqual({ legacy: 'preserved' });
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.upsertCustomer).not.toHaveBeenCalled();
    },
  );

  it.each(['restock', 'expiration'] as const)(
    'preserves %s reply priority and delivery callback',
    async (kind) => {
      const onSent = jest.fn();
      const prepare = jest
        .fn()
        .mockResolvedValue(
          kind === 'restock'
            ? { kind: 'offer', reply: 'RESTOCK?', onSent }
            : { kind: 'registered', reply: 'EXPIRATION registered' },
        );
      const f = setup(
        kind === 'restock'
          ? {
              restock: {
                enabled: true,
                consume: jest.fn().mockResolvedValue(null),
                prepare,
              } as unknown as MinimalRestockRequestService,
            }
          : {
              expiration: {
                enabled: true,
                prepare,
              } as unknown as MinimalExpirationRequestService,
            },
      );
      f.steps([
        call('getCart'),
        call(),
        call(kind === 'restock' ? 'prepareRestock' : 'prepareExpiration', {
          productId: ID,
        }),
        say,
      ]);
      const result = await review(f, {
        receivingPhoneNumberId: '123456',
        senderId: SENDER,
        messageId: 'wamid.checkout-test',
      });
      expect(result).toEqual(
        kind === 'restock'
          ? { kind: 'handled', reply: 'RESTOCK?', onSent }
          : { kind: 'handled', reply: 'EXPIRATION registered' },
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(onSent).not.toHaveBeenCalled();
      expect(f.outputs).toContainEqual(
        expect.objectContaining({ status: 'incomplete' }),
      );
    },
  );

  it('retains the previous public getCart behavior', async () => {
    const f = setup();
    f.steps([call('getCart'), say]);
    const result = await review(f);
    expect(result).toEqual({
      kind: 'handled',
      reply:
        'Su carrito:\n• Product: 2 × $15.00 MXN; importe $30.00 MXN\nTotal de productos: $30.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
    });
  });

  it('does not expose reviewCheckout without the cart capability', async () => {
    const f = setup({ cartAvailable: false });
    f.steps([say]);
    await review(f);
    expect(f.seen[0].tools).not.toHaveProperty('reviewCheckout');
    expect(String(f.seen[0].system)).not.toContain('reviewCheckout');
  });

  it('preserves enabled and sender allowlist gates', async () => {
    const f = setup({ enabled: false });
    expect(
      await f.agent.tryHandle({ senderId: SENDER, text: 'Quiero comprar' }),
    ).toEqual({ kind: 'not-handled' });
    const active = setup();
    expect(
      await active.agent.tryHandle({
        senderId: 'unlisted',
        text: 'Quiero comprar',
      }),
    ).toEqual({ kind: 'not-handled' });
    expect(f.seen).toHaveLength(0);
    expect(active.seen).toHaveLength(0);
  });
});
