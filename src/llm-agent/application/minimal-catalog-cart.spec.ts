import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
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
// The reference is a deterministic digest of (sender, productId, variantId), so
// a fixture derives the exact value the server registers from a successful
// catalog/stock/cart read. No registry state is forged: scripted reads below
// register every pair a mutation later resolves.
const selectionRegistry = new MinimalCartSelections(SENDER);
const cartRef = (productId: string, variantId?: string): string => {
  const reference = selectionRegistry.register({
    productId,
    productName: 'Catalog product',
    ...(variantId === undefined
      ? {}
      : { variantId, variantName: 'Catalog variant' }),
  });
  if (reference === null) throw new Error('fixture ref registration failed');
  return reference;
};
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
  const createAgent = (generateOverride: GenerateTextFn = generate) =>
    new MinimalCatalogAgentService(
      api,
      generateOverride,
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

  it('sends explicit strict nullable cart schemas through the real OpenAI provider without network access', async () => {
    const f = setup();
    const requests: Array<{
      tools: Array<{
        name: string;
        strict?: boolean;
        parameters: {
          required: string[];
          additionalProperties: boolean;
          properties: Record<string, { anyOf?: Array<{ type: string }> }>;
        };
      }>;
    }> = [];
    const offline = createOpenAI({
      apiKey: 'synthetic-offline-key',
      fetch: (_url, init) => {
        const body = init?.body;
        if (typeof body !== 'string') throw new Error('Expected JSON request');
        requests.push(JSON.parse(body) as (typeof requests)[number]);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'offline',
              object: 'response',
              created_at: 0,
              status: 'completed',
              model: 'm',
              output: [
                {
                  type: 'message',
                  id: 'msg',
                  status: 'completed',
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: 'offline', annotations: [] },
                  ],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    await f
      .createAgent((options) =>
        generateText({ ...options, model: offline('m') }),
      )
      .tryHandle({ senderId: SENDER, text: 'Muestre mi carrito' });
    expect(requests).toHaveLength(1);
    const cartWire = (name: string) =>
      requests[0].tools.find((candidate) => candidate.name === name);
    for (const name of ['setCartItem', 'adjustCartItem', 'prepareCartItem']) {
      const wire = cartWire(name);
      expect(wire).toBeDefined();
      expect(wire?.strict).toBe(true);
      expect(wire?.parameters.additionalProperties).toBe(false);
      expect(wire?.parameters.required.slice().sort()).toEqual(
        Object.keys(wire?.parameters.properties ?? {}).sort(),
      );
      // Identity now travels as a server selection reference, never a raw id.
      expect(wire?.parameters.properties.selectionRef).toBeDefined();
      expect(wire?.parameters.properties.continuation).toBeDefined();
      expect(
        wire?.parameters.properties.quantityText.anyOf?.map(
          (schema) => schema.type,
        ),
      ).toContain('null');
      expect(wire?.parameters.properties.productId).toBeUndefined();
      expect(wire?.parameters.properties.variantId).toBeUndefined();
    }
    expect(
      cartWire('setCartItem')?.parameters.properties.quantity.anyOf?.map(
        (schema) => schema.type,
      ),
    ).toContain('null');
    expect(
      cartWire('adjustCartItem')?.parameters.properties.delta.anyOf?.map(
        (schema) => schema.type,
      ),
    ).toContain('null');
    expect(
      cartWire('prepareCartItem')?.parameters.properties.operation,
    ).toBeDefined();
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [],
      totalCents: 0,
    });
    expect(f.api.searchCatalog).not.toHaveBeenCalled();
    expect(f.api.getStock).not.toHaveBeenCalled();
    expect(f.api.evaluateCart).not.toHaveBeenCalled();
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'setCartItem',
      text: 'Déjame dos productos en total',
      mutation: { quantity: 2, quantityText: 'dos' },
      domainInput: { productId: ID, quantity: 2 },
    },
    {
      name: 'adjustCartItem',
      text: 'Agrega dos productos',
      mutation: { delta: 2, quantityText: 'dos' },
      domainInput: { productId: ID, delta: 2 },
    },
  ] as const)(
    '$name grounds the quantity, resolves the selection and omits the variant before domain validation',
    async ({ name, text, mutation, domainInput }) => {
      const f = setup();
      const method = name === 'setCartItem' ? 'setItem' : 'adjustItem';
      const domain = jest.spyOn(f.cart, method);
      f.steps([
        call('searchCatalog', { q: 'Product' }),
        call(name, {
          selectionRef: cartRef(ID),
          ...mutation,
          continuation: false,
        }),
        say(),
      ]);
      expect(
        await f.createAgent().tryHandle({ senderId: SENDER, text }),
      ).toEqual({
        kind: 'handled',
        reply:
          'Su carrito:\n• Product: 2 × $12.00 MXN; importe $24.00 MXN\nTotal de productos: $24.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
      });
      expect(domain).toHaveBeenCalledTimes(1);
      expect(domain.mock.calls[0][1]).toEqual(domainInput);
      const view = await f.cart.view(SENDER);
      expect(view).toMatchObject({
        ok: true,
        items: [{ productId: ID, quantity: 2 }],
        totalCents: 2400,
      });
      if (view.ok) expect(view.items[0]).not.toHaveProperty('variantId');
      expect(f.api.evaluateCart.mock.calls[0][0]).toEqual([
        { productId: ID, quantity: 2, unitPriceCents: 1200 },
      ]);
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'setCartItem',
      selected: true,
      text: 'Déjame dos unidades en total',
      mutation: { quantity: 2, quantityText: 'dos' },
    },
    {
      name: 'adjustCartItem',
      selected: true,
      text: 'Agrega dos unidades',
      mutation: { delta: 2, quantityText: 'dos' },
    },
    {
      name: 'setCartItem',
      selected: false,
      text: 'Déjame dos unidades en total',
      mutation: { quantity: 2, quantityText: 'dos' },
    },
    {
      name: 'adjustCartItem',
      selected: false,
      text: 'Agrega dos unidades',
      mutation: { delta: 2, quantityText: 'dos' },
    },
  ] as const)(
    '$name preserves variant ownership and selection requirements (selected=$selected)',
    async ({ name, selected, text, mutation }) => {
      const f = setup();
      const variantId = '22222222-2222-4222-8222-222222222222';
      const variant = {
        variantId,
        name: '250mg',
        priceCents: 1200,
        stock: { status: 'available', quantity: 10 },
      };
      f.api.searchCatalog.mockResolvedValue([
        {
          productId: ID,
          name: 'Product',
          price: { priceCents: null },
          variants: [variant],
        },
      ] as never);
      f.api.getStock.mockResolvedValue({
        productId: ID,
        name: 'Product',
        stock: { status: 'available', quantity: 10 },
        variants: [variant],
      } as never);
      f.api.evaluateCart.mockResolvedValue({
        items: [
          {
            productId: ID,
            variantId,
            quantity: 2,
            unitPriceCents: 1200,
            originalPriceCents: 2400,
            finalPriceCents: 2400,
            discountAmountCents: 0,
            appliedPromotionTitle: null,
          },
        ],
        promotionEvaluationStatus: 'fully_evaluated',
      });
      const writes = jest.spyOn(f.store, 'commitMinimalCart');
      f.steps([
        call('searchCatalog', { q: 'Product' }),
        call(name, {
          selectionRef: selected ? cartRef(ID, variantId) : cartRef(ID),
          ...mutation,
          continuation: false,
        }),
        say(),
      ]);
      expect(
        await f.createAgent().tryHandle({ senderId: SENDER, text }),
      ).toEqual({
        kind: 'handled',
        reply: selected
          ? 'Su carrito:\n• Product — 250mg: 2 × $12.00 MXN; importe $24.00 MXN\nTotal de productos: $24.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.'
          : '¿Qué presentación desea agregar al carrito?',
      });
      expect(writes).toHaveBeenCalledTimes(selected ? 1 : 0);
      if (selected) {
        expect(f.api.evaluateCart.mock.calls[0][0]).toEqual([
          { productId: ID, variantId, quantity: 2, unitPriceCents: 1200 },
        ]);
        expect(await f.cart.view(SENDER)).toMatchObject({
          ok: true,
          items: [{ productId: ID, variantId, quantity: 2 }],
          totalCents: 2400,
        });
      } else {
        expect(f.api.evaluateCart).not.toHaveBeenCalled();
        expect(await f.cart.view(SENDER)).toMatchObject({
          ok: true,
          items: [],
          totalCents: 0,
        });
      }
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'setCartItem',
      addText: 'Déjame una unidad de Croquetas Nupec en total',
      mutation: { quantity: 1, quantityText: 'una' },
    },
    {
      name: 'adjustCartItem',
      addText: 'Agrega una unidad de Croquetas Nupec',
      mutation: { delta: 1, quantityText: 'una' },
    },
  ] as const)(
    '%s binds identity to a server selection and preserves mixed carts',
    async ({ name, addText, mutation }) => {
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
      const agent = f.createAgent();
      // A raw UUID is not a server-owned selection reference: it must be
      // rejected before any domain validation or write.
      f.steps([
        call('getCart', {}),
        call('searchCatalog', { q: 'croquetas' }),
        call(name, {
          selectionRef: otherVariant,
          ...mutation,
          continuation: false,
        }),
        say(),
      ]);
      expect(
        await agent.tryHandle({
          senderId: SENDER,
          text: addText,
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
        call(name, {
          selectionRef: cartRef(ID),
          ...mutation,
          continuation: false,
        }),
        say(),
      ]);
      expect(
        await agent.tryHandle({
          senderId: SENDER,
          text: addText,
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
        expect(options.system).toMatch(/cartSelectionRef|selectionRef/i);
        expect(options.system).toContain('prepareCartItem');
        const cartTool = options.tools?.[name] as
          | { description?: unknown }
          | undefined;
        expect(cartTool?.description).toMatch(/cartSelectionRef|selectionRef/i);
      }
    },
  );

  const cartTools = [
    {
      name: 'getCart',
      input: {},
      quantity: 0,
      text: 'Private customer message',
    },
    {
      name: 'setCartItem',
      input: {
        selectionRef: cartRef(ID),
        quantity: 2,
        quantityText: 'dos',
        continuation: false,
      },
      quantity: 2,
      text: 'Déjame dos unidades, Private customer message',
    },
    {
      name: 'adjustCartItem',
      input: {
        selectionRef: cartRef(ID),
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      },
      quantity: 2,
      text: 'Agrega dos unidades, Private customer message',
    },
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
      const healthy = () =>
        [ID, secondProduct].map((productId) => ({
          productId,
          name: 'Private product',
          price: { priceCents: 1200 },
          variants: [variant],
        }));
      f.api.searchCatalog.mockImplementation(async () => healthy() as never);
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
      // A successful read must register the requested pair, then the fresh
      // domain projection drifts so the SAME reference now fails ownership.
      // Unknown raw ids can no longer be supplied: they fail before domain
      // validation and can never pretend to have been registered.
      const searchQueue: unknown[] = [];
      const stockQueue: unknown[] = [];
      if (name === 'getCart') {
        searchQueue.push(products(true));
        stockQueue.push(inventory(ID, true));
      } else {
        searchQueue.push(healthy()); // scripted read registers the pair
        stockQueue.push(inventory(target, true)); // domain quote sees drift
        searchQueue.push(products(true));
        if (seed && !stale) {
          searchQueue.splice(1, 0, healthy());
          stockQueue.unshift(inventory(ID, false));
        }
      }
      f.api.searchCatalog.mockImplementation(
        async () => searchQueue.shift() as never,
      );
      f.api.getStock.mockImplementation(
        async () => stockQueue.shift() as never,
      );
      const mutationText =
        name === 'setCartItem'
          ? 'Déjame una unidad svc_private-customer-text'
          : 'Agrega una unidad svc_private-customer-text';
      f.steps([
        ...(name === 'getCart'
          ? []
          : [call('searchCatalog', { q: 'Private search text' })]),
        call(
          name,
          name === 'getCart'
            ? {}
            : {
                selectionRef: stale
                  ? cartRef(ID)
                  : cartRef(requestedProduct, variantId),
                ...(name === 'adjustCartItem' ? { delta: 1 } : { quantity: 1 }),
                quantityText: 'una',
                continuation: false,
              },
        ),
        say(),
      ]);
      expect(
        await f
          .createAgent()
          .tryHandle({ senderId: SENDER, text: mutationText }),
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
        'svc_private-customer-text',
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
    async ({ name, input, quantity, text }) => {
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
        .tryHandle({ senderId: SENDER, text });
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
    async ({ name, input, text }) => {
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
        await f.createAgent().tryHandle({ senderId: SENDER, text }),
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
      call('adjustCartItem', {
        selectionRef: cartRef(ID),
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
      say(),
    ]);
    expect(
      await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: 'Agrega dos unidades' }),
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
    async ({ name, input, quantity, text }) => {
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
        .tryHandle({ senderId: SENDER, text });
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
      call('adjustCartItem', {
        selectionRef: cartRef(ID),
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
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
    expect(f.optionsSeen[0].system).toMatch(/cartSelectionRef|selectionRef/i);
    expect(Object.keys(f.optionsSeen[0].tools ?? {})).not.toContain(
      'createSale',
    );
  });

  it.each([
    {
      text: 'Agrega 2 productos a mi carrito por favor',
      initial: 2,
      tool: 'adjustCartItem',
      input: { delta: 2, quantityText: '2' },
      expected: 4,
    },
    {
      text: 'Déjame 2 productos en total',
      initial: 3,
      tool: 'setCartItem',
      input: { quantity: 2, quantityText: '2' },
      expected: 2,
    },
    {
      text: 'Quita el producto de mi carrito por favor',
      initial: 2,
      tool: 'setCartItem',
      input: { quantity: 0, quantityText: null },
      expected: 0,
    },
    {
      text: 'Quita uno por favor',
      initial: 2,
      tool: 'adjustCartItem',
      input: { delta: -1, quantityText: 'uno' },
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
      f.steps([
        call('getCart', {}),
        call(toolName, {
          selectionRef: cartRef(ID),
          ...input,
          continuation: false,
        }),
        say(),
      ]);
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
      for (const instruction of ['Agrega 2', 'Déjame 2', 'Quita uno']) {
        expect(f.optionsSeen[0].system).toContain(instruction);
      }
      // Whole-line removal is communicated through the mutation tool description
      // (zero clears the line) rather than an explicit phrase example.
      const setTool = f.optionsSeen[0].tools?.setCartItem as
        | { description?: unknown }
        | undefined;
      expect(setTool?.description).toMatch(/cero lo quita/i);
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it('overrides a model success claim after failed persistence without reactivating legacy', async () => {
    const f = setup();
    jest.spyOn(f.store, 'commitMinimalCart').mockResolvedValue(false);
    f.steps([
      call('searchCatalog', { q: 'Product' }),
      call('adjustCartItem', {
        selectionRef: cartRef(ID),
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
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
