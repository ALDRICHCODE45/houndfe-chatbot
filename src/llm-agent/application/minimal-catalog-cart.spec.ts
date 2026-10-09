import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCartService } from './minimal-cart.service';
import { CostGuardService } from './cost-guard.service';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';

const ID = '11111111-1111-4111-8111-111111111111';
const SENDER = '5215550001111';
const step = (content: unknown[], finish: string) => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (name: string, input: unknown) =>
  step(
    [
      {
        type: 'tool-call',
        toolCallId: name,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
const say = () =>
  step([{ type: 'text', text: 'Invented sale created and paid' }], 'stop');
function setup() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn().mockResolvedValue([
      {
        productId: ID,
        name: 'Product',
        price: { priceCents: 1200 },
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
          unitPriceCents: 1200,
          originalPriceCents: 2400,
          finalPriceCents: 2400,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    }),
    createSale: jest.fn(),
    getPaymentDetails: jest.fn(),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: (key: string) =>
      key === 'minimalCatalogAgent'
        ? { enabled: true, allowedSenders: [SENDER] }
        : { model: 'm', maxSteps: 4, historyTurns: 12 },
  } as unknown as ConfigService;
  const cart = new MinimalCartService(api, store);
  let steps: unknown[] = [];
  const optionsSeen: Array<{
    system?: unknown;
    tools?: Record<string, unknown>;
  }> = [];
  const generate: GenerateTextFn = async (options) => {
    optionsSeen.push(options);
    return generateText({
      ...options,
      model: new MockLanguageModelV4({ doGenerate: steps } as never),
    });
  };
  const createAgent = () =>
    new MinimalCatalogAgentService(
      api,
      generate,
      new CostGuardService(100000),
      config,
      new InMemoryMinimalCatalogSessionStore(),
      undefined,
      undefined,
      cart,
    );
  return {
    store,
    api,
    cart,
    optionsSeen,
    createAgent,
    steps: (value: unknown[]) => {
      steps = value;
    },
  };
}

describe('Minimal cart through the public SDK route', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['setCartItem', 'adjustCartItem'] as const)(
    '%s binds variant guidance to the selected product and preserves mixed carts',
    async (name) => {
      const f = setup();
      const otherId = '33333333-3333-4333-8333-333333333333';
      const otherVariant = '22222222-2222-4222-8222-222222222222';
      const variant = {
        variantId: otherVariant,
        name: '250mg',
        priceCents: 13000,
        stock: { status: 'available', quantity: 10 },
      };
      f.api.searchCatalog.mockResolvedValue([
        {
          productId: ID,
          name: 'Croquetas Nupec',
          price: { priceCents: 45000 },
          variants: [],
        },
        {
          productId: otherId,
          name: 'Ibuprofeno',
          price: { priceCents: null },
          variants: [variant],
        },
      ] as never);
      f.api.getStock.mockImplementation(
        async (productId) =>
          ({
            productId,
            name: productId === ID ? 'Croquetas Nupec' : 'Ibuprofeno',
            stock: { status: 'available', quantity: 10 },
            variants: productId === ID ? [] : [variant],
          }) as never,
      );
      f.api.evaluateCart.mockImplementation(async (items) => ({
        items: items.map((item) => ({
          ...item,
          variantId: item.variantId ?? null,
          originalPriceCents: item.quantity * item.unitPriceCents,
          finalPriceCents: item.quantity * item.unitPriceCents,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }));
      expect(
        await f.cart.setItem(
          SENDER,
          {
            productId: otherId,
            variantId: otherVariant,
            quantity: 2,
          },
          new Set([otherId]),
        ),
      ).toMatchObject({ ok: true });
      const before = await f.cart.view(SENDER);
      const writes = jest.spyOn(f.store, 'commitMinimalCart');
      const mutation = name === 'setCartItem' ? { quantity: 1 } : { delta: 1 };
      const agent = f.createAgent();
      f.steps([
        call('getCart', {}),
        call('searchCatalog', { q: 'croquetas' }),
        call(name, { productId: ID, variantId: otherVariant, ...mutation }),
        say(),
      ]);
      expect(
        await agent.tryHandle({
          senderId: SENDER,
          text: 'Esa opcion me parece perfecta, agrega a mi carrito una unidad por favor.',
        }),
      ).toEqual({
        kind: 'handled',
        reply:
          'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.',
      });
      expect(writes).not.toHaveBeenCalled();
      expect(await f.cart.view(SENDER)).toEqual(before);
      f.steps([
        call('searchCatalog', { q: 'croquetas' }),
        call(name, { productId: ID, ...mutation }),
        say(),
      ]);
      expect(
        await agent.tryHandle({
          senderId: SENDER,
          text: 'Agrega una unidad de Croquetas Nupec',
        }),
      ).toEqual({
        kind: 'handled',
        reply:
          'Su carrito:\n• Ibuprofeno — 250mg: 2 × $130.00 MXN; importe $260.00 MXN\n• Croquetas Nupec: 1 × $450.00 MXN; importe $450.00 MXN\nTotal de productos: $710.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
      });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await f.cart.view(SENDER)).toMatchObject({
        ok: true,
        totalCents: 71000,
        items: [
          { productId: otherId, variantId: otherVariant, quantity: 2 },
          { productId: ID, quantity: 1 },
        ],
      });
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
      for (const options of f.optionsSeen) {
        expect(options.system).toContain(
          'Si el producto no tiene variantes, omita variantId',
        );
        expect(options.system).toContain(
          'Nunca invente un variantId ni copie el de otro producto',
        );
        expect(options.system).toContain(
          'Tras invalid_variant, no repita la llamada con la misma identidad',
        );
        const cartTool = options.tools?.[name] as
          | { description?: unknown }
          | undefined;
        expect(cartTool?.description).toEqual(
          expect.stringContaining(
            'Si el producto no tiene variantes, omita variantId',
          ),
        );
      }
    },
  );

  const cartTools = [
    { name: 'getCart', input: {}, quantity: 0 },
    { name: 'setCartItem', input: { productId: ID, quantity: 2 }, quantity: 2 },
    { name: 'adjustCartItem', input: { productId: ID, delta: 2 }, quantity: 2 },
  ];
  const cartLogs = (logs: jest.SpyInstance) =>
    logs.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        /tool (getCart|setCartItem|adjustCartItem) /.test(message),
      );
  const traceSuffix = ' trace=[0-9a-f-]{36}$';

  it.each([
    {
      tool: 'setCartItem',
      seed: false,
      stale: false,
      catalog: false,
      stock: false,
      loggerFails: false,
    },
    {
      tool: 'adjustCartItem',
      seed: false,
      stale: false,
      catalog: true,
      stock: false,
      loggerFails: false,
    },
    {
      tool: 'setCartItem',
      seed: false,
      stale: false,
      catalog: false,
      stock: true,
      loggerFails: false,
    },
    {
      tool: 'getCart',
      seed: true,
      stale: true,
      catalog: false,
      stock: false,
      loggerFails: false,
    },
    {
      tool: 'setCartItem',
      seed: true,
      stale: true,
      catalog: true,
      stock: false,
      loggerFails: false,
    },
    {
      tool: 'setCartItem',
      seed: true,
      stale: false,
      catalog: false,
      stock: false,
      loggerFails: false,
    },
    {
      tool: 'adjustCartItem',
      seed: false,
      stale: false,
      catalog: true,
      stock: false,
      loggerFails: true,
    },
  ])(
    'diagnoses invalid_variant through $tool (seed=$seed stale=$stale catalog=$catalog stock=$stock loggerFails=$loggerFails)',
    async ({ tool: name, seed, stale, catalog, stock, loggerFails }) => {
      const logs = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((message: unknown) => {
          if (loggerFails && String(message).includes('cart_variant_check'))
            throw new Error('svc_private-logger-secret');
        });
      const f = setup();
      const variantId = '22222222-2222-4222-8222-222222222222';
      const secondProduct = '33333333-3333-4333-8333-333333333333';
      const requestedProduct = seed ? secondProduct : ID;
      const target = stale ? ID : requestedProduct;
      const variant = {
        variantId,
        name: 'Private variant',
        priceCents: 1200,
        stock: { status: 'available', quantity: 10 },
      };
      const products = (broken: boolean) =>
        [ID, secondProduct].map((productId) => ({
          productId,
          name: 'Private product',
          price: { priceCents: 1200 },
          variants:
            broken && productId === target
              ? catalog
                ? [variant]
                : []
              : seed && productId === ID
                ? [variant]
                : [],
        }));
      const inventory = (productId: string, broken: boolean) => ({
        productId,
        name: 'Private product',
        stock: { status: 'available', quantity: 10 },
        variants:
          broken && productId === target
            ? stock
              ? [variant]
              : []
            : seed && productId === ID
              ? [variant]
              : [],
      });
      f.api.evaluateCart.mockImplementation(async (items) => ({
        items: items.map((item) => ({
          ...item,
          variantId: item.variantId ?? null,
          originalPriceCents: item.quantity * item.unitPriceCents,
          finalPriceCents: item.quantity * item.unitPriceCents,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }));
      f.api.searchCatalog.mockResolvedValue(products(false) as never);
      f.api.getStock.mockImplementation(
        async (id) => inventory(id, false) as never,
      );
      if (seed)
        expect(
          await f.cart.setItem(
            SENDER,
            { productId: ID, variantId, quantity: 2 },
            new Set([ID]),
          ),
        ).toMatchObject({ ok: true });
      const before = await f.cart.view(SENDER);
      const commit = jest.spyOn(f.store, 'commitMinimalCart');
      f.api.searchCatalog.mockResolvedValue(products(true) as never);
      f.api.getStock.mockImplementation(
        async (id) => inventory(id, true) as never,
      );
      f.steps([
        ...(name === 'getCart'
          ? []
          : [call('searchCatalog', { q: 'Private search text' })]),
        call(
          name,
          name === 'getCart'
            ? {}
            : {
                productId: requestedProduct,
                ...(stale ? {} : { variantId }),
                ...(name === 'adjustCartItem' ? { delta: 1 } : { quantity: 1 }),
              },
        ),
        say(),
      ]);
      expect(
        await f
          .createAgent()
          .tryHandle({ senderId: SENDER, text: 'Private customer text' }),
      ).toEqual({
        kind: 'handled',
        reply:
          'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.',
      });
      const messages = logs.mock.calls.map(([message]) => String(message));
      const diagnostics = messages.filter((message) =>
        message.includes('cart_variant_check'),
      );
      const trace = messages
        .find((message) => message.startsWith('minimal_catalog route_enter '))
        ?.split('trace=')[1];
      expect(trace).toMatch(/^[0-9a-f-]{36}$/);
      expect(diagnostics).toEqual([
        `minimal_catalog cart_variant_check operation=${name} line=${seed && !stale ? 2 : 1} origin=${stale ? 'stored' : 'requested'} catalog_match=${catalog} stock_match=${stock} variant_is_product=false trace=${trace}`,
      ]);
      expect(cartLogs(logs)).toEqual([
        `minimal_catalog tool ${name} result=error code=invalid_variant trace=${trace}`,
      ]);
      for (const secret of [
        SENDER,
        ID,
        variantId,
        secondProduct,
        'Private product',
        'Private variant',
        'Private search text',
        'Private customer text',
        'svc_private-logger-secret',
      ])
        expect(messages.join('\n')).not.toContain(secret);
      expect(commit).not.toHaveBeenCalled();
      f.api.searchCatalog.mockResolvedValue(products(false) as never);
      f.api.getStock.mockImplementation(
        async (id) => inventory(id, false) as never,
      );
      expect(await new MinimalCartService(f.api, f.store).view(SENDER)).toEqual(
        before,
      );
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it.each(cartTools)(
    'traces $name success without changing its result',
    async ({ name, input, quantity }) => {
      const logs = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      const f = setup();
      f.steps([
        ...(name === 'getCart'
          ? []
          : [call('searchCatalog', { q: 'Product' })]),
        call(name, input),
        say(),
      ]);
      const response = await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: 'Private customer message' });
      expect(response).toEqual({
        kind: 'handled',
        reply:
          quantity === 0
            ? 'Su carrito está vacío.'
            : 'Su carrito:\n• Product: 2 × $12.00 MXN; importe $24.00 MXN\nTotal de productos: $24.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
      });
      expect(cartLogs(logs)).toEqual([
        expect.stringMatching(
          new RegExp(`^minimal_catalog tool ${name} result=ok${traceSuffix}`),
        ),
      ]);
      expect(
        await new MinimalCartService(f.api, f.store).view(SENDER),
      ).toMatchObject({
        ok: true,
        totalCents: quantity * 1200,
        items: quantity === 0 ? [] : [{ productId: ID, quantity }],
      });
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it.each(cartTools)(
    'traces $name stock rejection without writing or leaking inputs',
    async ({ name, input }) => {
      const logs = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      const f = setup();
      if (name === 'getCart')
        await f.cart.setItem(
          SENDER,
          { productId: ID, quantity: 2 },
          new Set([ID]),
        );
      const before = await f.cart.view(SENDER);
      f.api.getStock.mockResolvedValue({
        productId: ID,
        name: 'Private product name',
        stock: { status: 'not_managed', quantity: null },
        variants: [],
      });
      f.steps([
        ...(name === 'getCart'
          ? []
          : [call('searchCatalog', { q: 'Private search text' })]),
        call(name, input),
        say(),
      ]);
      expect(
        await f
          .createAgent()
          .tryHandle({ senderId: SENDER, text: 'Private customer message' }),
      ).toEqual({
        kind: 'handled',
        reply:
          'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.',
      });
      expect(cartLogs(logs)).toEqual([
        expect.stringMatching(
          new RegExp(
            `^minimal_catalog tool ${name} result=error code=stock_unverified${traceSuffix}`,
          ),
        ),
      ]);
      const allLogs = logs.mock.calls.flat().join('\n');
      for (const secret of [
        SENDER,
        ID,
        'Private customer message',
        'Private search text',
        'Private product name',
      ])
        expect(allLogs).not.toContain(secret);
      f.api.getStock.mockResolvedValue({
        productId: ID,
        name: 'Product',
        stock: { status: 'available', quantity: 10 },
        variants: [],
      });
      expect(await new MinimalCartService(f.api, f.store).view(SENDER)).toEqual(
        before,
      );
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it('maps arbitrary cart errors to a closed diagnostic code rather than logging payloads', async () => {
    const logs = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const f = setup();
    const unsafeError = `svc_private-token ${SENDER} ${ID}\nforged-log`;
    jest
      .spyOn(f.cart, 'adjustItem')
      .mockResolvedValue({ ok: false, error: unsafeError });
    f.steps([
      call('searchCatalog', { q: 'Product' }),
      call('adjustCartItem', { productId: ID, delta: 2 }),
      say(),
    ]);
    expect(
      await f.createAgent().tryHandle({ senderId: SENDER, text: unsafeError }),
    ).toEqual({
      kind: 'handled',
      reply:
        'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.',
    });
    expect(cartLogs(logs)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^minimal_catalog tool adjustCartItem result=error code=unrecognized_cart_error${traceSuffix}`,
        ),
      ),
    ]);
    expect(logs.mock.calls.flat().join('\n')).not.toContain(unsafeError);
    expect(
      await new MinimalCartService(f.api, f.store).view(SENDER),
    ).toMatchObject({ ok: true, items: [], totalCents: 0 });
  });

  it.each(cartTools)(
    'preserves $name behaviour when the logger throws',
    async ({ name, input, quantity }) => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
        throw new Error('logging unavailable');
      });
      const f = setup();
      f.steps([
        ...(name === 'getCart'
          ? []
          : [call('searchCatalog', { q: 'Product' })]),
        call(name, input),
        say(),
      ]);
      const response = await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: 'Private customer message' });
      expect(response).toMatchObject({
        kind: 'handled',
        reply:
          quantity === 0
            ? 'Su carrito está vacío.'
            : 'Su carrito:\n• Product: 2 × $12.00 MXN; importe $24.00 MXN\nTotal de productos: $24.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
      });
      expect(
        await new MinimalCartService(f.api, f.store).view(SENDER),
      ).toMatchObject({
        ok: true,
        totalCents: quantity * 1200,
        items: quantity === 0 ? [] : [{ productId: ID, quantity }],
      });
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it('searches and adds via real SDK tools, restores cart with a fresh agent and never calls checkout', async () => {
    const f = setup();
    f.steps([
      call('searchCatalog', { q: 'Product' }),
      call('setCartItem', { productId: ID, quantity: 2 }),
      say(),
    ]);
    const first = await f.createAgent().tryHandle({
      senderId: SENDER,
      text: 'Agregue dos productos al carrito',
    });
    expect(first).toEqual({
      kind: 'handled',
      reply:
        'Su carrito:\n• Product: 2 × $12.00 MXN; importe $24.00 MXN\nTotal de productos: $24.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
    });
    f.steps([call('getCart', {}), say()]);
    expect(
      await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: '¿Qué tengo en mi carrito?' }),
    ).toEqual(first);
    expect(f.api.createSale).not.toHaveBeenCalled();
    expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(f.optionsSeen[0].system).toContain('cantidad TOTAL');
    expect(Object.keys(f.optionsSeen[0].tools ?? {})).not.toContain(
      'createSale',
    );
  });

  it.each([
    {
      text: 'Agrega 2 productos a mi carrito por favor',
      initial: 2,
      tool: 'adjustCartItem',
      input: { productId: ID, delta: 2 },
      expected: 4,
    },
    {
      text: 'Déjame 2 productos en total',
      initial: 3,
      tool: 'setCartItem',
      input: { productId: ID, quantity: 2 },
      expected: 2,
    },
    {
      text: 'Quita el producto de mi carrito por favor',
      initial: 2,
      tool: 'setCartItem',
      input: { productId: ID, quantity: 0 },
      expected: 0,
    },
    {
      text: 'Quita uno por favor',
      initial: 2,
      tool: 'adjustCartItem',
      input: { productId: ID, delta: -1 },
      expected: 1,
    },
  ])(
    'executes the tool interpretation of "$text" without model arithmetic',
    async ({ text, initial, tool: toolName, input, expected }) => {
      const f = setup();
      f.api.evaluateCart.mockImplementation(async (items) => ({
        items: items.map((item) => ({
          ...item,
          variantId: item.variantId ?? null,
          originalPriceCents: item.quantity * item.unitPriceCents,
          finalPriceCents: item.quantity * item.unitPriceCents,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }));
      await new MinimalCartService(f.api, f.store).setItem(
        SENDER,
        { productId: ID, quantity: initial },
        new Set([ID]),
      );
      f.steps([call(toolName, input), say()]);
      const response = await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text });
      const reply =
        expected === 0
          ? 'Su carrito está vacío.'
          : `Su carrito:\n• Product: ${expected} × $12.00 MXN; importe $${(expected * 12).toFixed(2)} MXN\nTotal de productos: $${(expected * 12).toFixed(2)} MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.`;
      expect(response).toEqual({ kind: 'handled', reply });
      expect(
        await new MinimalCartService(f.api, f.store).view(SENDER),
      ).toMatchObject({
        ok: true,
        items: expected === 0 ? [] : [{ productId: ID, quantity: expected }],
        totalCents: expected * 1200,
      });
      for (const instruction of [
        'Agrega 2',
        'Déjame 2',
        'Quita el producto',
        'Quita uno',
      ]) {
        expect(f.optionsSeen[0].system).toContain(instruction);
      }
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it('overrides a model success claim after failed persistence without reactivating legacy', async () => {
    const f = setup();
    jest.spyOn(f.store, 'commitMinimalCart').mockResolvedValue(false);
    f.steps([
      call('searchCatalog', { q: 'Product' }),
      call('setCartItem', { productId: ID, quantity: 2 }),
      say(),
    ]);
    expect(
      await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: 'Agregue dos' }),
    ).toEqual({
      kind: 'handled',
      reply:
        'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.',
    });
    expect(await f.store.get(SENDER)).toBeNull();
  });
});
