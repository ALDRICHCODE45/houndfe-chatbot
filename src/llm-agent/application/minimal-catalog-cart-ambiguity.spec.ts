import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SMALL = '22222222-2222-4222-8222-222222222222';
const LARGE = '33333333-3333-4333-8333-333333333333';
const FOOD = '44444444-4444-4444-8444-444444444444';
const SENDER = '5215550001111';
const stock = { status: 'available', quantity: 10 };
const products = [
  {
    productId: PRODUCT,
    name: 'Ibuprofeno',
    price: { priceCents: null },
    variants: [
      { variantId: SMALL, name: '250mg', priceCents: 13000, stock },
      { variantId: LARGE, name: '500mg', priceCents: 15000, stock },
    ],
  },
  {
    productId: FOOD,
    name: 'Croquetas Nupec',
    price: { priceCents: 45000 },
    variants: [],
  },
];

const REJECTION =
  'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.';
const INSUFFICIENT_STOCK =
  'No hay existencias suficientes para esa cantidad. Su carrito no fue modificado.';
const QUANTITY_QUESTION = /cu[aá]ntas.*unidades/i;

function response(content: unknown[], finish: string) {
  return {
    content,
    finishReason: { unified: finish, raw: undefined },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  };
}
function call(name: string, input: unknown) {
  return response(
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
}
function say(text = 'Unsupported model acknowledgement') {
  return response([{ type: 'text', text }], 'stop');
}

function fixture() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn().mockResolvedValue(products),
    getStock: jest.fn().mockImplementation((id: string) => {
      const item = products.find((candidate) => candidate.productId === id);
      return Promise.resolve({
        productId: id,
        name: item?.name,
        stock,
        variants: item?.variants ?? [],
      });
    }),
    evaluateCart: jest.fn().mockImplementation(
      (
        items: Array<{
          productId: string;
          variantId?: string;
          quantity: number;
          unitPriceCents: number;
        }>,
      ) =>
        Promise.resolve({
          items: items.map((item) => ({
            ...item,
            variantId: item.variantId ?? null,
            originalPriceCents: item.unitPriceCents * item.quantity,
            finalPriceCents: item.unitPriceCents * item.quantity,
            appliedPromotionTitle: null,
            discountAmountCents: 0,
          })),
          promotionEvaluationStatus: 'fully_evaluated',
        }),
    ),
    createSale: jest.fn(),
    getPaymentDetails: jest.fn(),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const cart = new MinimalCartService(api, store);
  const session = new InMemoryMinimalCatalogSessionStore();
  let steps: unknown[] = [];
  const optionsSeen: Array<{
    system?: unknown;
    tools?: Record<string, unknown>;
  }> = [];
  const generate: GenerateTextFn = (options) => {
    optionsSeen.push(options);
    return generateText({
      ...options,
      model: new MockLanguageModelV4({ doGenerate: steps } as never),
    });
  };
  const config = {
    get: (key: string) =>
      key === 'minimalCatalogAgent'
        ? { enabled: true, allowedSenders: [SENDER] }
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    session,
    undefined,
    undefined,
    cart,
  );
  // The reference is a deterministic digest of (sender, productId, variantId),
  // so a fixture can derive the same value the server registers from a
  // successful catalog read. No registry state is forged: every ref used below
  // is produced by a scripted successful read in the same test.
  const registry = new MinimalCartSelections(SENDER);
  const derive = (productId: string, variantId?: string): string => {
    const reference = registry.register({
      productId,
      productName: 'Fixture product',
      ...(variantId === undefined
        ? {}
        : { variantId, variantName: 'Fixture variant' }),
    });
    if (reference === null) throw new Error('fixture ref registration failed');
    return reference;
  };
  const refs = {
    parent: derive(PRODUCT),
    small: derive(PRODUCT, SMALL),
    large: derive(PRODUCT, LARGE),
    food: derive(FOOD),
  };
  return {
    api,
    cart,
    agent,
    refs,
    optionsSeen,
    steps: (value: unknown[]) => {
      steps = value;
    },
  };
}

describe('Minimal cart ambiguity through the public SDK route', () => {
  it('asks for quantity on the reported 500mg confirmation and preserves other lines (S2)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: SMALL, quantity: 2 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await f.cart.setItem(SENDER, { productId: FOOD, quantity: 1 }, allowed))
        .ok,
    ).toBe(true);
    const before = await f.cart.view(SENDER);
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      say('¿Buscaba la de 500mg?'),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega ibuprofeno de otra presentación',
    });
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      say('250mg y 500mg.'),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Cuantas presentaciones tienes de ibuprofeno?',
    });
    const mutation = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Si, la de 500mg por favor.',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toMatch(QUANTITY_QUESTION);
    expect(mutation).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toEqual(before);
    expect(f.api.createSale).not.toHaveBeenCalled();
    expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it('carries two only from the same prepared request and adds the chosen variant (S3)', async () => {
    const f = fixture();
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('prepareCartItem', {
        selectionRef: f.refs.parent,
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say('¿De 250mg o de 500mg?'),
    ]);
    await f.agent.tryHandle({ senderId: SENDER, text: 'Agrega 2 ibuprofenos' });
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toContain('500mg');
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: PRODUCT, variantId: LARGE, quantity: 2 }],
      totalCents: 30000,
    });
    expect(f.api.createSale).not.toHaveBeenCalled();
    expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it('does not inherit a saved line quantity when no pending request exists (S3)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: LARGE, quantity: 2 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    const before = await f.cart.view(SENDER);
    const mutation = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toMatch(QUANTITY_QUESTION);
    expect(mutation).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toEqual(before);
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it("does not carry a pending count into a different product's request (S3)", async () => {
    const f = fixture();
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('prepareCartItem', {
        selectionRef: f.refs.parent,
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say('¿De 250mg o de 500mg?'),
    ]);
    await f.agent.tryHandle({ senderId: SENDER, text: 'Agrega 2 ibuprofenos' });
    const mutation = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('adjustCartItem', {
        selectionRef: f.refs.food,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Las croquetas',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toMatch(QUANTITY_QUESTION);
    expect(mutation).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('lets a new explicit quantity supersede the pending request (S3)', async () => {
    const f = fixture();
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('prepareCartItem', {
        selectionRef: f.refs.parent,
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say('¿De 250mg o de 500mg?'),
    ]);
    await f.agent.tryHandle({ senderId: SENDER, text: 'Agrega 2 ibuprofenos' });
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: 3,
        quantityText: '3',
        continuation: true,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg, mejor 3',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toContain('500mg');
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: PRODUCT, variantId: LARGE, quantity: 3 }],
      totalCents: 45000,
    });
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('clears the pending count after a completed mutation (S3)', async () => {
    const f = fixture();
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('prepareCartItem', {
        selectionRef: f.refs.parent,
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say('¿De 250mg o de 500mg?'),
    ]);
    await f.agent.tryHandle({ senderId: SENDER, text: 'Agrega 2 ibuprofenos' });
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const completed = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(completed.kind).toBe('handled');
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: PRODUCT, variantId: LARGE, quantity: 2 }],
    });
    const mutation = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const replay = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(replay.kind).toBe('handled');
    if (replay.kind !== 'handled') throw new Error('Expected handled reply');
    expect(replay.reply).toMatch(QUANTITY_QUESTION);
    expect(mutation).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: PRODUCT, variantId: LARGE, quantity: 2 }],
    });
  });

  it('clears the pending count after a failed mutation and never auto-retries (S3)', async () => {
    const f = fixture();
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('prepareCartItem', {
        selectionRef: f.refs.parent,
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say('¿De 250mg o de 500mg?'),
    ]);
    await f.agent.tryHandle({ senderId: SENDER, text: 'Agrega 2 ibuprofenos' });
    f.api.getStock.mockImplementation((id: string) => {
      const item = products.find((candidate) => candidate.productId === id);
      return Promise.resolve({
        productId: id,
        name: item?.name ?? '',
        stock,
        variants: (item?.variants ?? []).map((variant) =>
          variant.variantId === LARGE
            ? { ...variant, stock: { status: 'available', quantity: 1 } }
            : variant,
        ),
      } as never);
    });
    const adjust = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const failed = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(failed.kind).toBe('handled');
    if (failed.kind !== 'handled') throw new Error('Expected handled reply');
    expect(failed.reply).toBe(INSUFFICIENT_STOCK);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    adjust.mockClear();
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const replay = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(replay.kind).toBe('handled');
    if (replay.kind !== 'handled') throw new Error('Expected handled reply');
    expect(replay.reply).toMatch(QUANTITY_QUESTION);
    expect(adjust).not.toHaveBeenCalled();
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('rejects an unknown selection reference without writing or echoing the model claim (S2)', async () => {
    const f = fixture();
    const before = await f.cart.view(SENDER);
    const mutation = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('adjustCartItem', {
        selectionRef: 'deadbeefdeadbeef',
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
      say('Agregué dos ibuprofenos a su carrito.'),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega dos ibuprofenos',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).not.toContain('Agregué dos ibuprofenos');
    expect(reply.reply).toBe(REJECTION);
    expect(mutation).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toEqual(before);
    expect(f.api.createSale).not.toHaveBeenCalled();
    expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it("maps 'Agrega 5 unidades' to an additive delta even when stock rejects the write (S4)", async () => {
    const f = fixture();
    f.api.getStock.mockImplementation((id: string) => {
      const item = products.find((candidate) => candidate.productId === id);
      return Promise.resolve({
        productId: id,
        name: item?.name ?? '',
        stock: id === FOOD ? { status: 'available', quantity: 3 } : stock,
        variants: item?.variants ?? [],
      } as never);
    });
    const set = jest.spyOn(f.cart, 'setItem');
    const adjust = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('adjustCartItem', {
        selectionRef: f.refs.food,
        delta: 5,
        quantityText: '5',
        continuation: false,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega 5 unidades de croquetas nupec',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toBe(INSUFFICIENT_STOCK);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust.mock.calls[0][1]).toEqual({ productId: FOOD, delta: 5 });
    expect(set).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('keeps a total set idempotent, subtracts one, then adds one again (S4)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (await f.cart.setItem(SENDER, { productId: FOOD, quantity: 3 }, allowed))
        .ok,
    ).toBe(true);
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('setCartItem', {
        selectionRef: f.refs.food,
        quantity: 1,
        quantityText: 'una',
        continuation: false,
      }),
      say(),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Déjame una unidad de croquetas',
    });
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: FOOD, quantity: 1 }],
    });
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('setCartItem', {
        selectionRef: f.refs.food,
        quantity: 1,
        quantityText: 'una',
        continuation: false,
      }),
      say(),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Déjame una unidad de croquetas',
    });
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: FOOD, quantity: 1 }],
    });
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('adjustCartItem', {
        selectionRef: f.refs.food,
        delta: -1,
        quantityText: 'una',
        continuation: false,
      }),
      say(),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Quita una unidad de croquetas',
    });
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('adjustCartItem', {
        selectionRef: f.refs.food,
        delta: 1,
        quantityText: 'una',
        continuation: false,
      }),
      say(),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega una unidad de Croquetas Nupec',
    });
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: FOOD, quantity: 1 }],
      totalCents: 45000,
    });
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('omits variantId from the domain input for a simple product (S6)', async () => {
    const f = fixture();
    const domain = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('adjustCartItem', {
        selectionRef: f.refs.food,
        delta: 1,
        quantityText: 'una',
        continuation: false,
      }),
      say(),
    ]);
    await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega una unidad de Croquetas Nupec',
    });
    expect(domain).toHaveBeenCalledTimes(1);
    expect(domain.mock.calls[0][1]).toEqual({ productId: FOOD, delta: 1 });
    const view = await f.cart.view(SENDER);
    expect(view).toMatchObject({ ok: true, items: [{ productId: FOOD }] });
    if (view.ok) expect(view.items[0]).not.toHaveProperty('variantId');
  });

  it('clears a named line proposed as set zero and preserves the other lines (S4)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: LARGE, quantity: 2 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await f.cart.setItem(SENDER, { productId: FOOD, quantity: 1 }, allowed))
        .ok,
    ).toBe(true);
    const set = jest.spyOn(f.cart, 'setItem');
    f.steps([
      call('getCart', {}),
      call('setCartItem', {
        selectionRef: f.refs.large,
        quantity: 0,
        quantityText: null,
        continuation: false,
      }),
      say('Acknowledged model claim'),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Quita el ibuprofeno',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).not.toContain('Acknowledged model claim');
    expect(reply.reply).toContain('Croquetas Nupec');
    expect(reply.reply).not.toContain('Ibuprofeno');
    expect(set).toHaveBeenCalledTimes(1);
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: FOOD, quantity: 1 }],
      totalCents: 45000,
    });
    expect(f.api.createSale).not.toHaveBeenCalled();
    expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
  });

  it('does not clear a line from a presentation-only confirmation proposed as set zero (S2/S4)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: LARGE, quantity: 2 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    const before = await f.cart.view(SENDER);
    const set = jest.spyOn(f.cart, 'setItem');
    const adjust = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('getCart', {}),
      call('setCartItem', {
        selectionRef: f.refs.large,
        quantity: 0,
        quantityText: null,
        continuation: false,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Si, la de 500mg por favor.',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toMatch(
      /No pude confirmar esa operación|No pude completar esa operación/,
    );
    expect(set).not.toHaveBeenCalled();
    expect(adjust).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toEqual(before);
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('does not clear a line when the current text negates the removal (S4)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: LARGE, quantity: 2 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await f.cart.setItem(SENDER, { productId: FOOD, quantity: 1 }, allowed))
        .ok,
    ).toBe(true);
    const before = await f.cart.view(SENDER);
    const set = jest.spyOn(f.cart, 'setItem');
    f.steps([
      call('getCart', {}),
      call('setCartItem', {
        selectionRef: f.refs.large,
        quantity: 0,
        quantityText: null,
        continuation: false,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'No eliminar el ibuprofeno',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toMatch(
      /No pude confirmar esa operación|No pude completar esa operación/,
    );
    expect(set).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toEqual(before);
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('blocks same-pair set, adjust and prepare after a rejected adjustment without rearming (S3)', async () => {
    const f = fixture();
    f.api.getStock.mockImplementation((id: string) => {
      const item = products.find((candidate) => candidate.productId === id);
      return Promise.resolve({
        productId: id,
        name: item?.name ?? '',
        stock,
        variants: (item?.variants ?? []).map((variant) =>
          variant.variantId === LARGE
            ? { ...variant, stock: { status: 'available', quantity: 1 } }
            : variant,
        ),
      } as never);
    });
    const adjust = jest.spyOn(f.cart, 'adjustItem');
    const set = jest.spyOn(f.cart, 'setItem');
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
      call('setCartItem', {
        selectionRef: f.refs.large,
        quantity: 1,
        quantityText: 'una',
        continuation: false,
      }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: 1,
        quantityText: 'una',
        continuation: false,
      }),
      call('prepareCartItem', {
        selectionRef: f.refs.large,
        operation: 'add',
        quantity: 2,
        quantityText: 'dos',
        continuation: false,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega dos ibuprofenos de 500mg',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toBe(INSUFFICIENT_STOCK);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    // A later no-count continuation must ask again: the blocked prepare did not
    // rearm the pending intent.
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const replay = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(replay.kind).toBe('handled');
    if (replay.kind !== 'handled') throw new Error('Expected handled reply');
    expect(replay.reply).toMatch(QUANTITY_QUESTION);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toMatchObject({ ok: true, items: [] });
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('keeps a successful mutation acknowledgement when a later unknown reference is rejected (S2/S4)', async () => {
    const f = fixture();
    const adjust = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'croquetas' }),
      call('adjustCartItem', {
        selectionRef: f.refs.food,
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
      call('adjustCartItem', {
        selectionRef: 'deadbeefdeadbeef',
        delta: 2,
        quantityText: 'dos',
        continuation: false,
      }),
      say(),
    ]);
    const reply = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Agrega dos de croquetas y dos de otra cosa',
    });
    expect(reply.kind).toBe('handled');
    if (reply.kind !== 'handled') throw new Error('Expected handled reply');
    expect(reply.reply).toContain('Croquetas Nupec');
    expect(reply.reply).not.toMatch(/no pude completar|no confirmé/i);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: FOOD, quantity: 2 }],
      totalCents: 90000,
    });
    expect(f.api.createSale).not.toHaveBeenCalled();
  });

  it('asks quantity for a selected presentation, then continues that 500mg line with a literal dos (S3)', async () => {
    const f = fixture();
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: SMALL, quantity: 5 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await f.cart.setItem(SENDER, { productId: FOOD, quantity: 1 }, allowed))
        .ok,
    ).toBe(true);
    const before = await f.cart.view(SENDER);
    const mutation = jest.spyOn(f.cart, 'adjustItem');
    f.steps([
      call('searchCatalog', { q: 'ibuprofeno' }),
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: false,
      }),
      say(),
    ]);
    const asked = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Si, la de 500mg por favor.',
    });
    expect(asked.kind).toBe('handled');
    if (asked.kind !== 'handled') throw new Error('Expected handled reply');
    expect(asked.reply).toMatch(QUANTITY_QUESTION);
    expect(mutation).not.toHaveBeenCalled();
    expect(await f.cart.view(SENDER)).toEqual(before);
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: 'dos',
        continuation: true,
      }),
      say(),
    ]);
    const added = await f.agent.tryHandle({ senderId: SENDER, text: 'dos' });
    expect(added.kind).toBe('handled');
    if (added.kind !== 'handled') throw new Error('Expected handled reply');
    // The selected 500mg context must survive the acknowledgement branch that
    // dropped the tool messages and be visible to the next run.
    const nextSystem = f.optionsSeen[1]?.system;
    expect(
      typeof nextSystem === 'string' &&
        (nextSystem.includes(f.refs.large) || nextSystem.includes('500mg')),
    ).toBe(true);
    expect(added.reply).toContain('500mg');
    expect(await f.cart.view(SENDER)).toMatchObject({
      ok: true,
      items: [
        { productId: PRODUCT, variantId: SMALL, quantity: 5 },
        { productId: FOOD, quantity: 1 },
        { productId: PRODUCT, variantId: LARGE, quantity: 2 },
      ],
      totalCents: 140000,
    });
    // A completed no-count request clears the selected pending.
    f.steps([
      call('adjustCartItem', {
        selectionRef: f.refs.large,
        delta: null,
        quantityText: null,
        continuation: true,
      }),
      say(),
    ]);
    const replay = await f.agent.tryHandle({
      senderId: SENDER,
      text: 'Los de 500mg',
    });
    expect(replay.kind).toBe('handled');
    if (replay.kind !== 'handled') throw new Error('Expected handled reply');
    expect(replay.reply).toMatch(QUANTITY_QUESTION);
    expect(f.api.createSale).not.toHaveBeenCalled();
  });
});

describe('Minimal cart singular "otra unidad" add phrasing (S4)', () => {
  // Both reported live texts, each exercised on its own isolated cart so a
  // pass cannot come from a compounded increment in another case.
  const phraseCases: ReadonlyArray<{
    label: string;
    text: string;
    quantityText: string;
  }> = [
    {
      label: 'full phrase',
      text: 'Agrega otra unidad de Croquetas Nupec',
      quantityText: 'otra unidad',
    },
    {
      label: 'context-bound short citation',
      text: 'Quiero que agregues otra unidad de croquetas nupec',
      quantityText: 'otra',
    },
  ];

  const seedReportedCart = async (f: ReturnType<typeof fixture>) => {
    const allowed = new Set([PRODUCT, FOOD]);
    expect(
      (
        await f.cart.setItem(
          SENDER,
          { productId: PRODUCT, variantId: SMALL, quantity: 2 },
          allowed,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await f.cart.setItem(SENDER, { productId: FOOD, quantity: 1 }, allowed))
        .ok,
    ).toBe(true);
  };

  it.each(phraseCases)(
    'adds exactly one grounded unit for the $label and keeps the other line',
    async ({ text, quantityText }) => {
      const f = fixture();
      await seedReportedCart(f);
      const before = await f.cart.view(SENDER);
      expect(before).toMatchObject({
        ok: true,
        items: [
          { productId: PRODUCT, variantId: SMALL, quantity: 2 },
          { productId: FOOD, quantity: 1 },
        ],
        totalCents: 71000,
      });

      f.steps([call('getCart', {}), say('Su carrito actual.')]);
      const viewed = await f.agent.tryHandle({
        senderId: SENDER,
        text: 'Muéstrame mi carrito',
      });
      expect(viewed.kind).toBe('handled');

      const adjust = jest.spyOn(f.cart, 'adjustItem');
      const set = jest.spyOn(f.cart, 'setItem');
      f.steps([
        call('getCart', {}),
        call('adjustCartItem', {
          selectionRef: f.refs.food,
          delta: 1,
          quantityText,
          continuation: false,
        }),
        say('Agregué otra unidad de croquetas a su carrito.'),
      ]);
      const reply = await f.agent.tryHandle({ senderId: SENDER, text });
      expect(reply.kind).toBe('handled');
      if (reply.kind !== 'handled') throw new Error('Expected handled reply');
      expect(reply.reply).not.toContain('Agregué otra unidad');
      expect(reply.reply).toContain('Croquetas Nupec');
      expect(adjust).toHaveBeenCalledTimes(1);
      expect(adjust.mock.calls[0][1]).toEqual({ productId: FOOD, delta: 1 });
      expect(set).not.toHaveBeenCalled();
      expect(await f.cart.view(SENDER)).toMatchObject({
        ok: true,
        items: [
          { productId: PRODUCT, variantId: SMALL, quantity: 2 },
          { productId: FOOD, quantity: 2 },
        ],
        totalCents: 116000,
      });
      expect(f.api.createSale).not.toHaveBeenCalled();
      expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    },
  );

  it.each(phraseCases)(
    'rejects a set total of one on the $label without writing',
    async ({ text, quantityText }) => {
      const f = fixture();
      await seedReportedCart(f);
      const before = await f.cart.view(SENDER);
      const set = jest.spyOn(f.cart, 'setItem');
      const adjust = jest.spyOn(f.cart, 'adjustItem');
      f.steps([
        call('getCart', {}),
        call('setCartItem', {
          selectionRef: f.refs.food,
          quantity: 1,
          quantityText,
          continuation: false,
        }),
        say('Fijé una unidad de croquetas.'),
      ]);
      const reply = await f.agent.tryHandle({ senderId: SENDER, text });
      expect(reply.kind).toBe('handled');
      if (reply.kind !== 'handled') throw new Error('Expected handled reply');
      expect(reply.reply).toMatch(/No pude confirmar esa operación/);
      expect(set).not.toHaveBeenCalled();
      expect(adjust).not.toHaveBeenCalled();
      expect(await f.cart.view(SENDER)).toEqual(before);
      expect(f.api.createSale).not.toHaveBeenCalled();
    },
  );
});
