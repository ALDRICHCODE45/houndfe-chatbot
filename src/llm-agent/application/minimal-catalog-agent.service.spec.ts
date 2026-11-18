import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { SYSTEM_PROMPT } from '../domain/system-prompt';
import type { MinimalCatalogSessionStore } from '../domain/minimal-catalog-session.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import {
  MinimalRestockRequestService,
  minimalRestockProposal,
} from './minimal-restock-request.service';
import { deriveRestockSourceRequestId } from '../../human-decisions/domain/restock-source-identity';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { MinimalCartService } from './minimal-cart.service';

const SENDER = '5215550001111';
const OTHER = '5215550002222';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '22222222-2222-4222-8222-222222222222';
const OUTSIDE = '99999999-9999-4999-8999-999999999999';
const usage = {
  inputTokens: { total: 2 },
  outputTokens: { total: 3 },
} as never;
const step = (content: unknown[], finish: string) => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage,
  warnings: [],
});
const say = (text: string) => step([{ type: 'text', text }], 'stop');
const call = (id: string, name: string, input: unknown) =>
  step(
    [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
// Core two-turn regression: simple product with NO variants (the incident).
const simpleItem = {
  productId: PRODUCT,
  name: 'Ibuprofeno 400 mg',
  price: { priceCents: 9900, fromPriceCents: 12900 },
  stock: { quantity: 50 },
  variants: [],
};
const simpleStock = {
  productId: PRODUCT,
  name: 'Ibuprofeno 400 mg',
  stock: { status: 'low_stock', quantity: 2 },
  variants: [],
};
const variant = {
  variantId: VARIANT,
  name: 'Caja',
  stock: { status: 'out_of_stock', quantity: 0 },
};
const variantItem = { ...simpleItem, variants: [variant] };
const variantStock = { ...simpleStock, variants: [variant] };
const variantFixtures = { item: variantItem, stock: variantStock };
// S13: a search turn's reply is the application's options message.
const IBUPROFENO_OPTIONS =
  'Encontré estas opciones:\n• *Ibuprofeno 400 mg*: $99.00 MXN\n\n¿Cuál le gustaría llevar?';
const flow = [
  call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
  say('¿Buscaba esa presentación?'),
  call('s2', 'searchCatalog', { q: 'ibuprofeno' }),
  call('c2', 'checkStock', { productId: PRODUCT }),
  say('Revisé las existencias del producto.'),
];

type Tool = {
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};
type Captured = {
  system?: unknown;
  prompt?: unknown;
  messages?: ModelMessage[];
  tools?: Record<string, Tool>;
  stopWhen?: (state: { steps: unknown[] }) => boolean;
};

function build(
  steps: unknown,
  over: Partial<{
    historyTurns: number;
    sessionStore: MinimalCatalogSessionStore;
    restock: (chatbotApi: ChatbotApiClient) => MinimalRestockRequestService;
    cart: (chatbotApi: ChatbotApiClient) => MinimalCartService;
  }> = {},
  fixtures: { item: unknown; stock: unknown } = {
    item: simpleItem,
    stock: simpleStock,
  },
) {
  const model = new MockLanguageModelV4({ doGenerate: steps } as never);
  const chatbotApi = {
    searchCatalog: jest.fn().mockResolvedValue([fixtures.item]),
    getStock: jest.fn().mockResolvedValue(fixtures.stock),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: () => ({
      model: 'm',
      maxSteps: 4,
      historyTurns: over.historyTurns ?? 12,
    }),
  } as unknown as ConfigService;
  const captured: Captured[] = [];
  const results: Array<{ responseMessages: ModelMessage[] }> = [];
  const costGuard = new CostGuardService(1_000_000);
  const sessionStore =
    over.sessionStore ?? new InMemoryMinimalCatalogSessionStore();
  const generate: GenerateTextFn = async (options) => {
    captured.push(options as unknown as Captured);
    const result = await generateText({ ...options, model });
    results.push(result);
    return result;
  };
  return {
    service: new MinimalCatalogAgentService(
      chatbotApi,
      generate,
      costGuard,
      config,
      sessionStore,
      over.restock?.(chatbotApi),
      undefined,
      over.cart?.(chatbotApi),
    ),
    chatbotApi,
    costGuard,
    captured,
    results,
    sessionStore,
  };
}

function captureLogs(): string[] {
  const logs: string[] = [];
  jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  return logs;
}

describe('MinimalCatalogAgentService (minimal SDK route)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('handles every sender with no allowlist or enable flag', async () => {
    // A sender that was never configured anywhere still runs the SDK turn.
    const stranger = '5215559998888';
    const { service, captured } = build([say('Hola'), say('Hola')]);
    await expect(
      service.tryHandle({ senderId: stranger, text: 'hola' }),
    ).resolves.toEqual({ kind: 'handled', reply: 'Hola' });
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'hola' }),
    ).resolves.toEqual({ kind: 'handled', reply: 'Hola' });
    expect(captured).toHaveLength(2);
  });

  it('sends the strengthened voice clauses and examples with the SYSTEM_PROMPT prefix and returns the model reply as WhatsApp text', async () => {
    const arbitrary = 'Eco literal del modelo: **{nombre}** 12345';
    const { service, captured } = build([say(arbitrary)]);
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'hola, busco ibuprofeno' }),
    ).resolves.toEqual({
      kind: 'handled',
      // H1: only the Markdown bold changes; the content is the model's.
      reply: 'Eco literal del modelo: *{nombre}* 12345',
    });
    const system = String(captured[0].system);
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain('¡Hola! Encontré {nombre} en nuestro catálogo.');
    expect(system).toContain('con los emojis del estilo del cliente');
    expect(system).not.toContain('Saluda cálido de usted con un emoji ligero');
    expect(system).toContain('Por ahora, {nombre} está agotado.');
    expect(system).toContain('sin "¿en qué puedo ayudarle?"');
    expect(system).toContain('Sin cierre automático');
    expect(system).toContain('sin emoji al informar agotado');
    expect(system).not.toContain('prepareRestock');
    expect(JSON.stringify(captured[0].messages)).toContain(
      'hola, busco ibuprofeno',
    );
  });

  it('runs confirm→re-search→checkStock and bounds tools/steps/usage', async () => {
    const { service, chatbotApi, costGuard, captured } = build(flow);
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'tienen ibuprofeno' }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: IBUPROFENO_OPTIONS, // S13: rendered by the application
    });
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'sí, esa' }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: 'Revisé las existencias del producto.',
    });

    expect(chatbotApi.searchCatalog).toHaveBeenCalledWith('ibuprofeno');
    expect(chatbotApi.getStock).toHaveBeenCalledWith(PRODUCT);
    expect(Object.keys(captured[0].tools!)).toEqual([
      'searchCatalog',
      'checkStock',
    ]);
    expect(String(captured[0].system).startsWith(SYSTEM_PROMPT)).toBe(true);
    const system = String(captured[0].system);
    expect(system).toContain('en catálogo');
    expect(system).toContain('agotado');
    expect(system).toContain('needs_human_review');
    expect(system).toContain('no prueba');
    expect(system).toContain('reservación');
    // S13: the model's own text is replaced by the rendered reply; the tool
    // call and result stay in history (verified identity for later turns).
    expect(captured[1].messages!.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(captured[1].messages)).not.toContain(
      '¿Buscaba esa presentación?',
    );
    expect(JSON.stringify(captured[1].messages)).toContain(
      'Encontré estas opciones:',
    );
    expect(costGuard.currentAggregate).toBe(25);
    const stopWhen = captured[0].stopWhen!;
    const ref = stepCountIs(4) as unknown as (state: {
      steps: unknown[];
    }) => boolean;
    expect(stopWhen({ steps: [1, 2, 3] })).toBe(ref({ steps: [1, 2, 3] }));
    expect(stopWhen({ steps: [1, 2, 3, 4] })).toBe(
      ref({ steps: [1, 2, 3, 4] }),
    );
  });

  it('strips stock, rejects an extra variantId, and never GETs an unknown id', async () => {
    const { service, chatbotApi, captured } = build(flow, {}, variantFixtures);
    await service.tryHandle({ senderId: SENDER, text: 'busca' });
    const { searchCatalog, checkStock } = captured[0].tools!;

    const search = JSON.stringify(await searchCatalog.execute({ q: 'x' }, {}));
    expect(search).not.toContain('"stock"');
    expect(search).toContain(PRODUCT);
    expect(search).toContain(VARIANT);
    const schema = checkStock.inputSchema;
    expect(schema.safeParse({ productId: PRODUCT }).success).toBe(true);
    expect(
      schema.safeParse({ productId: PRODUCT, variantId: VARIANT }).success,
    ).toBe(false);
    await expect(
      checkStock.execute({ productId: OUTSIDE }, {}),
    ).resolves.toEqual({ ok: false, error: 'unknown_product' });
    expect(chatbotApi.getStock).not.toHaveBeenCalled();

    await expect(
      checkStock.execute({ productId: PRODUCT }, {}),
    ).resolves.toMatchObject({
      // S12: with presentations the product-level /stock (low_stock, 2) is not
      // exposed; availability comes from the presentation (agotado).
      availability: { status: 'out_of_stock', agotado_presentations: ['Caja'] },
      variants: [{ stock: { status: 'out_of_stock', quantity: 0 } }],
    });
    chatbotApi.searchCatalog.mockRejectedValueOnce(new Error('leaked detail'));
    const failed = await searchCatalog.execute({ q: 'x' }, {});
    expect(failed).toEqual({ ok: false, error: 'catalog_unavailable' });
    expect(JSON.stringify(failed)).not.toContain('leaked');
  });

  describe('S7 search broadening', () => {
    const SECOND = '33333333-3333-4333-8333-333333333333';
    const other = {
      ...simpleItem,
      productId: SECOND,
      name: 'Pedigree Dentastix',
    };

    it('retries a 0-result multi-word query with the significant word and tells the model', async () => {
      const { service, chatbotApi, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      chatbotApi.searchCatalog
        .mockReset()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([other as never]);
      const out = (await captured[0].tools!.searchCatalog.execute(
        { q: 'croquetas pedigree' },
        {},
      )) as Record<string, unknown>;
      expect(chatbotApi.searchCatalog.mock.calls.map((c) => c[0])).toEqual([
        'croquetas pedigree',
        'pedigree',
      ]);
      expect(out).toMatchObject({
        ok: true,
        stock_verified: false,
        broadened_search: {
          original_query: 'croquetas pedigree',
          matched_query: 'pedigree',
          queries_tried: ['pedigree'],
        },
      });
      expect(JSON.stringify(out)).toContain(SECOND);
      expect((out.broadened_search as { note: string }).note).toContain(
        'croquetas pedigree',
      );
      // Broadened results are registered as presented: checkStock may use them.
      await expect(
        captured[0].tools!.checkStock.execute({ productId: SECOND }, {}),
      ).resolves.not.toEqual({ ok: false, error: 'unknown_product' });
    });

    it('does not retry when the first search has results or the query is a single word', async () => {
      const { service, chatbotApi, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      chatbotApi.searchCatalog.mockClear();
      const hit = (await captured[0].tools!.searchCatalog.execute(
        { q: 'croquetas pedigree' },
        {},
      )) as Record<string, unknown>;
      expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(1);
      expect(hit).not.toHaveProperty('broadened_search');
      chatbotApi.searchCatalog.mockClear().mockResolvedValue([]);
      const miss = await captured[0].tools!.searchCatalog.execute(
        { q: 'pedigree' },
        {},
      );
      expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(1);
      // S10a: the stated query now travels with the (empty) result.
      expect(miss).toEqual({
        ok: true,
        stock_verified: false,
        query: 'pedigree',
        results: [],
      });
    });

    it('reports a failed retry as the ordinary catalog_unavailable error', async () => {
      const { service, chatbotApi, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      chatbotApi.searchCatalog
        .mockReset()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('leaked detail'));
      const out = await captured[0].tools!.searchCatalog.execute(
        { q: 'croquetas pedigree' },
        {},
      );
      expect(out).toEqual({ ok: false, error: 'catalog_unavailable' });
    });

    it('instructs the model to use one broader refinement and present the broadened words', async () => {
      const { service, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      const system = JSON.stringify(captured[0].system);
      expect(system).toContain('broadened_search');
      expect(system).toContain('UNA sola búsqueda más amplia');
    });
  });

  describe('S10 catalog relevance', () => {
    const pid = (n: number) =>
      `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const product = (n: number, extra: Record<string, unknown> = {}) => ({
      ...simpleItem,
      productId: pid(n),
      name: `Croquetas ${n}`,
      description: `Descripción ${n}`,
      ...extra,
    });
    const search = async (items: unknown[], q = 'croquetas para cachorro') => {
      const { service, chatbotApi, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      chatbotApi.searchCatalog.mockReset().mockResolvedValue(items as never);
      const out = (await captured[0].tools!.searchCatalog.execute(
        { q },
        {},
      )) as Record<string, unknown>;
      return { out, captured };
    };
    const resultIds = (out: Record<string, unknown>) =>
      (out.results as Array<{ productId: string }>).map((r) => r.productId);

    it('brand rule (owner 2026-11-17) is now applied by the S13 renderer: the prompt no longer tells the model how to order or label options', async () => {
      const { service, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      const system = JSON.stringify(captured[0].system);
      expect(system).not.toContain(
        'Marca: si la marca pedida tiene productos del tipo pedido, ofrece SOLO esa marca',
      );
      expect(system).not.toContain('enumera las reales');
      expect(system).toContain('presented_by_application');
      expect(system).toContain('no escribas la lista ni el cierre');
    });

    it('S10a/c: prompt requires every stated attribute, alternatives only separately, plain no-match', async () => {
      const { service, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      const system = JSON.stringify(captured[0].system);
      expect(system).toContain('TODOS los atributos');
      for (const attribute of [
        'cachorro',
        'adulto',
        'senior',
        'especie',
        'marca',
        'tamaño de raza',
        'sabor',
      ])
        expect(system).toContain(attribute);
      expect(system).toContain('nunca lo presentes como coincidencia');
      expect(system).toContain('UNA sola vez');
      expect(system).toContain('di claro que no hay');
      expect(system).toContain('la alternativa más cercana');
    });

    it('S10b: prompt says never more than 3 options and not to list hidden results (the S13 renderer asks the narrowing question)', async () => {
      const { service, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      const system = JSON.stringify(captured[0].system);
      expect(system).toContain('Nunca ofrezcas más de 3 opciones');
      expect(system).not.toContain('máximo 5');
      expect(system).toContain('more_results');
    });

    it('S10a: the tool result carries the stated query, descriptions and a relevance check', async () => {
      const { out } = await search([product(1), product(2)]);
      expect(out).toMatchObject({
        ok: true,
        query: 'croquetas para cachorro',
        results: [
          { productId: pid(1), description: 'Descripción 1' },
          { productId: pid(2), description: 'Descripción 2' },
        ],
      });
      expect(out.relevance_check).toEqual(expect.stringContaining('query'));
      expect(out).not.toHaveProperty('more_results');
      expect(out).not.toHaveProperty('narrowing_instruction');
    });

    it('S10b: 10 results offer at most 3, with more_results and a narrowing instruction', async () => {
      const { out } = await search(
        Array.from({ length: 10 }, (_, i) => product(i + 1)),
      );
      expect(resultIds(out)).toEqual([pid(1), pid(2), pid(3)]);
      expect(out.more_results).toBe(7);
      expect(out.narrowing_instruction).toEqual(
        expect.stringContaining('UNA sola pregunta'),
      );
    });

    it('S10b: 3 or fewer results are unchanged (no more_results, no narrowing)', async () => {
      const { out } = await search([product(1), product(2), product(3)]);
      expect(resultIds(out)).toEqual([pid(1), pid(2), pid(3)]);
      expect(out).not.toHaveProperty('more_results');
      expect(out).not.toHaveProperty('narrowing_instruction');
    });

    it('S10b: hidden results are not registered (checkStock denies them, cart refs absent)', async () => {
      const { out, captured } = await search(
        Array.from({ length: 5 }, (_, i) => product(i + 1)),
      );
      const { checkStock } = captured[0].tools!;
      await expect(
        checkStock.execute({ productId: pid(4) }, {}),
      ).resolves.toEqual({ ok: false, error: 'unknown_product' });
      await expect(
        checkStock.execute({ productId: pid(3) }, {}),
      ).resolves.not.toEqual({ ok: false, error: 'unknown_product' });
      expect(JSON.stringify(out)).not.toContain(pid(4));
    });

    it('S10b: the cap also bounds a broadened search', async () => {
      const { service, chatbotApi, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      chatbotApi.searchCatalog
        .mockReset()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(
          Array.from({ length: 6 }, (_, i) => product(i + 1)) as never,
        );
      const out = (await captured[0].tools!.searchCatalog.execute(
        { q: 'croquetas pedigree' },
        {},
      )) as Record<string, unknown>;
      expect(resultIds(out)).toHaveLength(3);
      expect(out.more_results).toBe(3);
      expect(out).toHaveProperty('broadened_search');
    });

    it('S10d/S13b: partial matches never displace full ones; ≤ 3 options in total (S13 replaced the extra 4th partial slot)', async () => {
      const { out } = await search([
        product(1, { match: 'partial' }),
        product(2, { match: 'all' }),
        product(3, { match: 'all' }),
        product(4, { match: 'all' }),
        product(5, { match: 'all' }),
        product(6, { match: 'partial' }),
      ]);
      expect(resultIds(out)).toEqual([pid(2), pid(3), pid(4)]);
      expect(out.more_results).toBe(3);
      expect(out).not.toHaveProperty('match_note');
    });

    it('S10d: a partial match shown next to full ones still carries the alternative note', async () => {
      const { out } = await search([
        product(1, { match: 'partial' }),
        product(2, { match: 'all' }),
      ]);
      expect(resultIds(out)).toEqual([pid(2), pid(1)]);
      expect(out.match_note).toEqual(expect.stringContaining('partial'));
      expect(out.match_note).toEqual(expect.stringContaining('alternativa'));
    });

    it('S10d: when only partial matches exist the model is told nothing matches fully', async () => {
      const { out } = await search([
        product(1, { match: 'partial' }),
        product(2, { match: 'partial' }),
      ]);
      expect(resultIds(out)).toEqual([pid(1), pid(2)]);
      expect(out.match_note).toEqual(
        expect.stringContaining('Ningún producto cumple'),
      );
    });

    it('S10d: an absent flag adds no match note and no match key', async () => {
      const absent = await search([product(1), product(2)]);
      expect(absent.out).not.toHaveProperty('match_note');
      for (const result of absent.out.results as object[])
        expect(result).not.toHaveProperty('match');
    });
  });

  describe('S11/S12 out-of-stock options (availability from the search payload)', () => {
    const pid = (n: number) =>
      `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
    type S11Out = {
      ok: boolean;
      results: Array<{
        productId: string;
        availability: { status: string; agotado_presentations?: string[] };
        variants: Array<{ availability: string }>;
      }>;
      availability_instruction?: string;
      more_results?: number;
    };
    const OUT = { status: 'out_of_stock', quantity: 0 };
    const AVAILABLE = { status: 'available', quantity: 7 };
    const product = (
      n: number,
      stock: { status: string; quantity: number | null },
      extra: Record<string, unknown> = {},
    ) => ({
      ...simpleItem,
      productId: pid(n),
      name: `Pedigree ${n}`,
      description: `Alimento ${n}`,
      stock,
      variants: [],
      ...extra,
    });
    const presentation = (
      id: string,
      name: string,
      stock: { status: string; quantity: number | null },
    ) => ({ ...variant, variantId: id, name, stock });
    const INBOUND = {
      receivingPhoneNumberId: '123456789012345',
      senderId: SENDER,
      messageId: 'wamid.S11',
    };
    const restockWiring = (api: ChatbotApiClient) =>
      new MinimalRestockRequestService({
        chatbotApi: api,
        store: { get: jest.fn(async () => null) } as never,
        restock: {
          markers: {
            readForSender: jest.fn(async () => ({
              legacyRequestPending: false,
              restockIntentPresent: false,
            })),
          },
          coordinator: { coordinate: jest.fn() },
          recovery: { recover: jest.fn() },
        },
      });
    const search = async (
      items: unknown[],
      opts: { restock?: boolean; q?: string } = {},
    ) => {
      const { service, chatbotApi, captured } = build(
        flow,
        opts.restock === true ? { restock: restockWiring } : {},
      );
      await service.tryHandle({
        senderId: SENDER,
        text: 'busca',
        ...(opts.restock === true ? { inboundEvent: INBOUND } : {}),
      });
      chatbotApi.searchCatalog.mockReset().mockResolvedValue(items as never);
      chatbotApi.getStock.mockReset();
      const out = (await captured[0].tools!.searchCatalog.execute(
        { q: opts.q ?? 'croquetas pedigree' },
        {},
      )) as S11Out;
      return { out, chatbotApi, captured };
    };
    const ids = (out: S11Out) =>
      (out.results as Array<{ productId: string }>).map((r) => r.productId);

    it('a search makes exactly ONE backend call: no getStock per shown product', async () => {
      const { out, chatbotApi } = await search([
        product(1, AVAILABLE),
        product(2, OUT),
        product(3, AVAILABLE),
      ]);
      expect(out.results).toHaveLength(3);
      expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(1);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
    });

    it('prod case: croquetas pedigree lata out_of_stock in the payload is labelled agotado with an instruction', async () => {
      const lata = product(1, OUT, {
        name: 'Pedigree Adulto Trozos de Res en Salsa lata',
      });
      const { out, chatbotApi } = await search([lata]);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
      expect(out.results[0].availability).toMatchObject({
        status: 'out_of_stock',
      });
      expect(out.availability_instruction).toEqual(
        expect.stringContaining('agotado'),
      );
      expect(out.availability_instruction).toEqual(
        expect.stringContaining('nunca'),
      );
      // The stock-stripping boundary is unchanged: no stock/quantity leaks.
      expect(JSON.stringify(out)).not.toContain('"stock"');
      expect(JSON.stringify(out)).not.toContain('quantity');
    });

    it('S12: a variant product with product.quantity 0 but an available presentation is NOT agotado', async () => {
      const item = product(1, OUT, {
        variants: [
          presentation(VARIANT, 'Lata', OUT),
          presentation(OUTSIDE, 'Bolsa', AVAILABLE),
        ],
      });
      const { out, chatbotApi } = await search([item]);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
      expect(out.results[0].availability.status).toBe('available');
      expect(out.results[0].availability.agotado_presentations).toEqual([
        'Lata',
      ]);
      expect(out.results[0].variants.map((v) => v.availability)).toEqual([
        'out_of_stock',
        'available',
      ]);
      expect(out.availability_instruction).toEqual(
        expect.stringContaining('presentaciones'),
      );
    });

    it('S12: a variant product with product.quantity 0 and only available presentations has no agotado label or instruction', async () => {
      const item = product(1, OUT, {
        variants: [presentation(VARIANT, 'Lata', AVAILABLE)],
      });
      const { out } = await search([item]);
      expect(out.results[0].availability).toEqual({ status: 'available' });
      expect(out).not.toHaveProperty('availability_instruction');
    });

    it('S12: all presentations out_of_stock is agotado with the presentations named, whatever the product-level stock says', async () => {
      const item = product(1, AVAILABLE, {
        variants: [
          presentation(VARIANT, 'Lata', OUT),
          presentation(OUTSIDE, 'Bolsa', OUT),
        ],
      });
      const { out } = await search([item]);
      expect(out.results[0].availability).toEqual({
        status: 'out_of_stock',
        agotado_presentations: ['Lata', 'Bolsa'],
      });
      expect(out.results[0].variants.map((v) => v.availability)).toEqual([
        'out_of_stock',
        'out_of_stock',
      ]);
      expect(out.availability_instruction).toEqual(
        expect.stringContaining('agotado'),
      );
    });

    it('offers the existing restock flow only when it exists; never promises it otherwise', async () => {
      const without = await search([product(1, OUT)]);
      expect(without.out.availability_instruction).not.toContain(
        'prepareRestock',
      );
      expect(without.out.availability_instruction).toContain('no prometas');
      const withRestock = await search([product(1, OUT)], { restock: true });
      expect(withRestock.captured[0].tools).toHaveProperty('prepareRestock');
      expect(withRestock.out.availability_instruction).toContain(
        'prepareRestock',
      );
      // S13d: the offer itself is the application's rendered closing.
      expect(withRestock.out.availability_instruction).toContain(
        'La aplicación ya le ofrece',
      );
    });

    it('«Vendedor» closing (owner 2026-11-17) is now rendered by the application (S13d): the tool result no longer dictates a closing to the model', async () => {
      const mixed = await search([product(1, AVAILABLE), product(2, OUT)], {
        restock: true,
      });
      expect(mixed.out.availability_instruction).not.toContain(
        'La pregunta principal del cierre',
      );
      expect(mixed.out.availability_instruction).not.toContain(
        '¿Cuál le gustaría llevar?',
      );
      expect(mixed.out).toHaveProperty('presented_by_application');
    });

    it('available matches come first: an agotado product does not displace an available one from the 3', async () => {
      const { out, chatbotApi } = await search([
        product(1, OUT),
        product(2, AVAILABLE),
        product(3, AVAILABLE),
        product(4, AVAILABLE),
      ]);
      expect(ids(out)).toEqual([pid(2), pid(3), pid(4)]);
      expect(out.more_results).toBe(1);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
    });

    it('an all-presentations-agotado variant product does not displace an available match either', async () => {
      const allOut = product(1, AVAILABLE, {
        variants: [presentation(VARIANT, 'Lata', OUT)],
      });
      const { out } = await search([
        allOut,
        product(2, AVAILABLE),
        product(3, AVAILABLE),
        product(4, AVAILABLE),
      ]);
      expect(ids(out)).toEqual([pid(2), pid(3), pid(4)]);
    });

    it('an agotado product is still shown (last) when there is room', async () => {
      const { out } = await search([product(1, OUT), product(2, AVAILABLE)]);
      expect(ids(out)).toEqual([pid(2), pid(1)]);
      expect(out.results[1].availability.status).toBe('out_of_stock');
    });

    it('S13b available first: an available partial alternative precedes an agotado full match (shown on its own agotado line)', async () => {
      const { out } = await search([
        product(1, AVAILABLE, { match: 'partial' }),
        product(2, OUT, { match: 'all' }),
      ]);
      expect(ids(out)).toEqual([pid(1), pid(2)]);
    });

    it('caps at 3 offered products with no stock reads for any of them', async () => {
      const { out, chatbotApi } = await search(
        Array.from({ length: 10 }, (_, n) => product(n, AVAILABLE)),
        { q: 'croquetas' },
      );
      expect(out.results).toHaveLength(3);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
    });

    it('stock data that is inconsistent or missing in the payload is unverified (neither agotado nor available) and not a search error', async () => {
      const { out } = await search([
        product(1, { status: 'out_of_stock', quantity: 5 }),
        product(2, AVAILABLE),
        { ...product(3, AVAILABLE), stock: undefined },
      ]);
      expect(out.ok).toBe(true);
      const byId = Object.fromEntries(
        out.results.map((r) => [r.productId, r.availability.status]),
      );
      expect(byId).toEqual({
        [pid(1)]: 'unverified',
        [pid(2)]: 'available',
        [pid(3)]: 'unverified',
      });
      expect(out.availability_instruction).toEqual(
        expect.stringContaining('unverified'),
      );
    });

    it('adds no availability instruction when everything shown is available', async () => {
      const { out } = await search([product(1, AVAILABLE)]);
      expect(out.results[0].availability).toEqual({ status: 'available' });
      expect(out).not.toHaveProperty('availability_instruction');
    });

    it('traces only counts for the availability labels, never ids or names', async () => {
      const logs = captureLogs();
      await search([product(1, OUT), product(2, AVAILABLE)]);
      const line = logs
        .filter((l) => l.includes('searchCatalog availability'))
        .at(-1);
      expect(line).toMatch(
        /tool searchCatalog availability checked=2 agotado=1 unverified=0 trace=[0-9a-f-]+$/,
      );
      expect(line).not.toContain(pid(1));
      expect(line).not.toContain('Pedigree');
    });

    it('the prompt demands agotado, the restock offer and no agotado cart adds', async () => {
      const { service, captured } = build(flow);
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      const system = JSON.stringify(captured[0].system);
      expect(system).toContain('availability');
      expect(system).toContain('agotado');
      expect(system).toContain('nunca lo agregues al carrito');
      expect(system).toContain('cuáles presentaciones');
    });
  });

  describe('S13 code-rendered catalog options', () => {
    const pid = (n: number) =>
      `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const priced = (cents: number) => ({
      priceCents: cents,
      fromPriceCents: null,
      promoPriceCents: null,
      promotionEvaluationStatus: 'needs_human_review',
    });
    const AVAILABLE = { status: 'available', quantity: 7 };
    const OUT = { status: 'out_of_stock', quantity: 0 };
    // Production evidence (2026-11-17), "croquetas pedigree manejan?".
    const dentastix = {
      productId: pid(1),
      name: 'Pedigree Dentastix Premios Dentales Perro Mediano 7 pzas',
      brand: 'Pedigree',
      imageUrl: null,
      description: 'Premios para la limpieza dental de su perro.',
      price: priced(8900),
      stock: AVAILABLE,
      variants: [],
    };
    const naturales = {
      productId: pid(2),
      name: '[PRUEBA] Croquetas Naturales sin Grano Salmón y Camote 2 kg',
      brand: 'Naturales',
      imageUrl: null,
      description: 'Croquetas para perros adultos de raza grande. Sin granos.',
      price: priced(45000),
      stock: AVAILABLE,
      variants: [],
    };
    const LATA = 'Pedigree Adulto Trozos de Res en Salsa Lata 375 g';
    const lata = {
      productId: pid(3),
      name: LATA,
      brand: 'Pedigree',
      imageUrl: null,
      description: 'Alimento húmedo para perro adulto.',
      price: priced(4900),
      stock: OUT,
      variants: [],
    };
    const lataStock = {
      productId: pid(3),
      name: LATA,
      stock: OUT,
      variants: [],
    };
    const PROD_REPLY = [
      'Croquetas Pedigree no tengo, pero tengo estas opciones:',
      '• *[PRUEBA] Croquetas Naturales sin Grano Salmón y Camote 2 kg* (de otra marca): Croquetas para perros adultos de raza grande. $450.00 MXN',
      '• *Pedigree Dentastix Premios Dentales Perro Mediano 7 pzas*: Premios para la limpieza dental de su perro. $89.00 MXN',
      `Además, tengo ${LATA}, pero está agotado.`,
      '',
      `¿Cuál le gustaría llevar? Y si la que busca es ${LATA}, con gusto le averiguo cuándo nos vuelve a llegar.`,
    ].join('\n');
    // The production model text this change makes impossible to send.
    const MODEL_TEXT =
      'Tengo Pedigree Dentastix y [PRUEBA] Croquetas Naturales. Si buscas las croquetas de Pedigree, con gusto averiguo cuándo nos vuelve a llegar.';
    const inbound = (n: number) => ({
      receivingPhoneNumberId: '123456789012345',
      senderId: SENDER,
      messageId: `wamid.S13.${n}`,
    });
    const restockWiring = (api: ChatbotApiClient) =>
      new MinimalRestockRequestService({
        chatbotApi: api,
        store: { get: jest.fn(async () => null) } as never,
        restock: {
          markers: {
            readForSender: jest.fn(async () => ({
              legacyRequestPending: false,
              restockIntentPresent: false,
            })),
          },
          coordinator: { coordinate: jest.fn() },
          recovery: { recover: jest.fn() },
        },
      });
    const prodTurn = async (
      steps: unknown[],
      opts: { restock?: boolean; text?: string } = {},
    ) => {
      const built = build(
        steps,
        opts.restock === false ? {} : { restock: restockWiring },
        { item: dentastix, stock: lataStock },
      );
      built.chatbotApi.searchCatalog.mockResolvedValue([
        dentastix,
        naturales,
        lata,
      ] as never);
      const first = await built.service.tryHandle({
        senderId: SENDER,
        text: opts.text ?? 'croquetas pedigree manejan?',
        inboundEvent: inbound(1),
      });
      return { ...built, first };
    };

    it('prod case: the options message is rendered by code — other-brand croquetas first, Dentastix after, the lata as agotado, exact restock closing', async () => {
      const { first, captured } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say(MODEL_TEXT),
      ]);
      expect(first).toEqual({ kind: 'handled', reply: PROD_REPLY });
      if (first.kind !== 'handled') throw new Error('expected handled');
      expect(
        first.reply.startsWith(
          'Croquetas Pedigree no tengo, pero tengo estas opciones:',
        ),
      ).toBe(true);
      const closing = first.reply.split('\n').at(-1)!.toLowerCase();
      expect(closing).not.toContain('croquetas pedigree');
      expect(closing).not.toContain('croquetas de pedigree');
      expect(first.reply).not.toContain('Si buscas');
      // One model run: the rendered reply needs no extra render call.
      expect(captured).toHaveLength(1);
    });

    it('the model cannot override the rendered message in that turn, even with empty or competing text', async () => {
      const competing = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say('Encontré estas opciones:\n• *Croquetas Pedigree* $1 MXN'),
      ]);
      expect(competing.first).toEqual({ kind: 'handled', reply: PROD_REPLY });
      // A step budget ending on the tool call (no text) is not re-rendered
      // by the model either.
      const empty = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        call('s2', 'searchCatalog', { q: 'croquetas pedigree' }),
        call('s3', 'searchCatalog', { q: 'croquetas pedigree' }),
        call('s4', 'searchCatalog', { q: 'croquetas pedigree' }),
      ]);
      expect(empty.first).toEqual({ kind: 'handled', reply: PROD_REPLY });
      expect(empty.captured).toHaveLength(1);
    });

    it('the search result tells the model the application presents the options, and the prompt says not to write them', async () => {
      const { captured } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say(MODEL_TEXT),
      ]);
      const out = (await captured[0].tools!.searchCatalog.execute(
        { q: 'croquetas pedigree' },
        {},
      )) as { results: Array<{ productId: string }> };
      expect(out).toHaveProperty('presented_by_application');
      // The registry keeps exactly the rendered products, in rendered order.
      expect(out.results.map((r) => r.productId)).toEqual([
        pid(2),
        pid(1),
        pid(3),
      ]);
      expect(String(captured[0].system)).toContain(
        'no escribas la lista ni el cierre',
      );
    });

    it('tú styling applies to the fixed copy', async () => {
      const { first } = await prodTurn(
        [call('s1', 'searchCatalog', { q: 'croquetas pedigree' }), say('x')],
        { text: '¿tienes croquetas pedigree? ¿me ayudas?' },
      );
      if (first.kind !== 'handled') throw new Error('expected handled');
      expect(first.reply).toContain(
        `¿Cuál te gustaría llevar? Y si la que buscas es ${LATA}, con gusto te averiguo cuándo nos vuelve a llegar.`,
      );
    });

    it('without the restock capability the message makes no restock promise', async () => {
      const { first } = await prodTurn(
        [call('s1', 'searchCatalog', { q: 'croquetas pedigree' }), say('x')],
        { restock: false },
      );
      if (first.kind !== 'handled') throw new Error('expected handled');
      expect(first.reply).toContain(
        `Además, tengo ${LATA}, pero está agotado.`,
      );
      expect(first.reply.endsWith('\n\n¿Cuál le gustaría llevar?')).toBe(true);
      expect(first.reply).not.toContain('averiguo');
    });

    it('a later plain "sí" prepares the restock for the agotado productId only, without a model run', async () => {
      const { service, chatbotApi, captured } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say(MODEL_TEXT),
      ]);
      const second = await service.tryHandle({
        senderId: SENDER,
        text: 'sí',
        inboundEvent: inbound(2),
      });
      if (second.kind !== 'handled') throw new Error('expected handled');
      expect(second.reply).toContain(`«${LATA}»`);
      expect(second.onSent).toEqual(expect.any(Function));
      expect(chatbotApi.getStock).toHaveBeenCalledTimes(1);
      expect(chatbotApi.getStock).toHaveBeenCalledWith(pid(3));
      expect(captured).toHaveLength(1);
    });

    it('the restock offer belongs to the rendered turn only: after another turn a "sí" goes to the model', async () => {
      const { service, chatbotApi, captured } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say(MODEL_TEXT),
        say('Claro.'),
        say('De acuerdo.'),
      ]);
      await service.tryHandle({
        senderId: SENDER,
        text: 'gracias, lo pienso',
        inboundEvent: inbound(2),
      });
      await service.tryHandle({
        senderId: SENDER,
        text: 'sí',
        inboundEvent: inbound(3),
      });
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
      expect(captured).toHaveLength(3);
    });

    it('a non-plain acceptance reaches the model with the offered productId and the history keeps the verified tool result', async () => {
      const { service, captured } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say(MODEL_TEXT),
        say('Claro.'),
      ]);
      await service.tryHandle({
        senderId: SENDER,
        text: 'sí, averigüeme cuándo llega la lata',
        inboundEvent: inbound(2),
      });
      const system = String(captured[1].system);
      expect(system).toContain('Oferta de reposición del mensaje anterior');
      expect(system).toContain(pid(3));
      expect(system).not.toContain(`productId ${pid(1)}`);
      const history = JSON.stringify(captured[1].messages);
      expect(history).toContain(pid(3));
      expect(history).toContain('Croquetas Pedigree no tengo');
      expect(history).not.toContain('Si buscas las croquetas de Pedigree');
    });

    describe('S13d B2: cart-add closing next to an agotado restock offer', () => {
      const CROQ = 'Croquetas Pedigree Adulto Res 2 kg';
      const croquetas = {
        productId: pid(4),
        name: CROQ,
        brand: 'Pedigree',
        imageUrl: null,
        description: 'Croquetas para perro adulto.',
        price: priced(32000),
        stock: AVAILABLE,
        variants: [],
      };
      const croqStock = {
        productId: pid(4),
        name: CROQ,
        stock: AVAILABLE,
        variants: [],
      };
      const croqRef = (() => {
        const reference = new MinimalCartSelections(SENDER).register({
          productId: pid(4),
          productName: CROQ,
        });
        if (reference === null) throw new Error('fixture ref');
        return reference;
      })();
      const ADD_CLOSING = `¿Se lo agrego al carrito? Y si la que busca es ${LATA}, con gusto le averiguo cuándo nos vuelve a llegar.`;
      const cartTurn = async (steps: unknown[]) => {
        const built = build(steps, {
          restock: restockWiring,
          cart: (api) =>
            new MinimalCartService(api, new InMemoryConversationStore()),
        });
        built.chatbotApi.searchCatalog.mockResolvedValue([
          croquetas,
          lata,
        ] as never);
        built.chatbotApi.getStock.mockImplementation(
          async (id: string) =>
            (id === pid(3) ? lataStock : croqStock) as never,
        );
        (
          built.chatbotApi as unknown as { evaluateCart: jest.Mock }
        ).evaluateCart = jest.fn(
          async (
            items: Array<{
              productId: string;
              quantity: number;
              unitPriceCents: number;
            }>,
          ) => ({
            items: items.map((i) => ({
              ...i,
              variantId: null,
              originalPriceCents: i.quantity * i.unitPriceCents,
              finalPriceCents: i.quantity * i.unitPriceCents,
              discountAmountCents: 0,
              appliedPromotionTitle: null,
            })),
            promotionEvaluationStatus: 'fully_evaluated',
          }),
        );
        const first = await built.service.tryHandle({
          senderId: SENDER,
          text: 'croquetas pedigree manejan?',
          inboundEvent: inbound(1),
        });
        if (first.kind !== 'handled') throw new Error('expected handled');
        expect(first.reply.endsWith(ADD_CLOSING)).toBe(true);
        return built;
      };

      it('a plain "sí" answers the cart question only: no restock context, no restock prepared, the cart add happens', async () => {
        const { service, chatbotApi, captured } = await cartTurn([
          call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
          say(MODEL_TEXT),
          call('a1', 'adjustCartItem', {
            selectionRef: croqRef,
            delta: null,
            quantityText: null,
            continuation: false,
          }),
          say('Listo.'),
        ]);
        const second = await service.tryHandle({
          senderId: SENDER,
          text: 'sí',
          inboundEvent: inbound(2),
        });
        if (second.kind !== 'handled') throw new Error('expected handled');
        expect(captured).toHaveLength(2);
        const system = String(captured[1].system);
        expect(system).not.toContain(
          'Oferta de reposición del mensaje anterior',
        );
        // Deterministic: the restock tool is not exposed for that turn, so
        // the model cannot prepare a restock from a cart "sí"; cart tools are.
        const tools = Object.keys(captured[1].tools!);
        expect(tools).not.toContain('prepareRestock');
        expect(tools).toEqual(
          expect.arrayContaining(['adjustCartItem', 'setCartItem']),
        );
        expect(system).not.toContain('Herramienta prepareRestock');
        expect(second.reply).toMatch(/agregué 1 unidad/i);
        expect(second.reply).not.toContain(`«${LATA}»`);
        expect(second.onSent).toBeUndefined();
        expect(chatbotApi.getStock).not.toHaveBeenCalledWith(pid(3));
      });

      it('a "sí" that also asks about the agotado product still gets the restock context', async () => {
        const { service, captured } = await cartTurn([
          call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
          say(MODEL_TEXT),
          say('Claro.'),
        ]);
        await service.tryHandle({
          senderId: SENDER,
          text: 'sí, y avíseme cuando llegue la lata',
          inboundEvent: inbound(2),
        });
        const system = String(captured[1].system);
        expect(system).toContain('Oferta de reposición del mensaje anterior');
        expect(system).toContain(pid(3));
        expect(Object.keys(captured[1].tools!)).toContain('prepareRestock');
      });
    });

    it('checkStock and the rendered products stay usable on the next turn (registry unchanged)', async () => {
      const { service, captured } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        say(MODEL_TEXT),
        call('c1', 'checkStock', { productId: pid(2) }),
        say('Sí, lo tenemos disponible.'),
      ]);
      const second = await service.tryHandle({
        senderId: SENDER,
        text: 'quiero las croquetas naturales',
        inboundEvent: inbound(2),
      });
      // A checkStock after the options is the model's to answer.
      expect(second).toEqual({
        kind: 'handled',
        reply: 'Sí, lo tenemos disponible.',
      });
      expect(captured).toHaveLength(2);
    });

    it('a stock read after a search in the SAME turn leaves that turn to the model', async () => {
      const { first } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
        call('c1', 'checkStock', { productId: pid(2) }),
        say('Las croquetas naturales están disponibles.'),
      ]);
      expect(first).toEqual({
        kind: 'handled',
        reply: 'Las croquetas naturales están disponibles.',
      });
    });

    it('S10 prod case: "croquetas para cachorro" renders only the cachorro product; the adult croquetas are neither shown nor registered', async () => {
      const nupec = {
        ...dentastix,
        productId: pid(10),
        name: 'Nupec Cachorro Razas Medianas y Grandes',
        brand: 'Nupec',
        description:
          'Alimento seco premium para cachorros de razas medianas y grandes.',
      };
      const adult = {
        ...naturales,
        productId: pid(11),
        name: '[PRUEBA] Croquetas Naturales sin Grano Salmón y Camote para Perros Adultos de Raza Grande',
      };
      const built = build(
        [
          call('s1', 'searchCatalog', { q: 'croquetas para cachorro' }),
          say('Tengo Nupec y las croquetas Naturales para adulto.'),
        ],
        {},
        { item: nupec, stock: lataStock },
      );
      built.chatbotApi.searchCatalog.mockResolvedValue([adult, nupec] as never);
      const first = await built.service.tryHandle({
        senderId: SENDER,
        text: 'croquetas para cachorro',
      });
      if (first.kind !== 'handled') throw new Error('expected handled');
      expect(first.reply).toContain(
        '*Nupec Cachorro Razas Medianas y Grandes*',
      );
      expect(first.reply).not.toContain('Naturales');
      await expect(
        built.captured[0].tools!.checkStock.execute({ productId: pid(11) }, {}),
      ).resolves.toEqual({ ok: false, error: 'unknown_product' });
    });

    it('S10: only contradicting results → «{lo pedido} no tengo por ahora. ¿Quiere que le pregunte al equipo…?», nothing listed', async () => {
      const built = build(
        [
          call('s1', 'searchCatalog', { q: 'croquetas para cachorro' }),
          say('Tengo croquetas para adulto.'),
        ],
        {},
        { item: naturales, stock: lataStock },
      );
      built.chatbotApi.searchCatalog.mockResolvedValue([
        {
          ...naturales,
          name: 'Croquetas Naturales para Perros Adultos',
        },
      ] as never);
      await expect(
        built.service.tryHandle({
          senderId: SENDER,
          text: 'croquetas para cachorro',
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply:
          'Croquetas para cachorro no tengo por ahora. ¿Quiere que le pregunte al equipo si lo pueden conseguir, o le busco otra cosa?',
      });
    });

    it('nothing classifiable keeps the model reply (current behaviour)', async () => {
      const { first } = await prodTurn([
        call('s1', 'searchCatalog', { q: 'arena' }),
        say('No encontré arena; ¿qué producto busca?'),
      ]);
      expect(first).toEqual({
        kind: 'handled',
        reply: 'No encontré arena; ¿qué producto busca?',
      });
    });

    describe('S13c follow-up (L31, prod retest)', () => {
      const nupec = {
        ...dentastix,
        productId: pid(20),
        name: 'Nupec Cachorro Razas Medianas y Grandes',
        brand: 'Nupec',
        description:
          'Alimento seco premium para cachorros de razas medianas y grandes.',
      };

      it('«croquetas para cachorro tienen?» + model q «croquetas cachorro» + Nupec Cachorro → «Encontré estas opciones:», never «Croquetas cachorro no tengo»', async () => {
        const built = build(
          [
            call('s1', 'searchCatalog', { q: 'croquetas cachorro' }),
            say('Croquetas cachorro no tengo.'),
          ],
          {},
          { item: nupec, stock: lataStock },
        );
        built.chatbotApi.searchCatalog.mockResolvedValue([nupec] as never);
        const first = await built.service.tryHandle({
          senderId: SENDER,
          text: 'croquetas para cachorro tienen?',
        });
        if (first.kind !== 'handled') throw new Error('expected handled');
        expect(first.reply.split('\n')[0]).toBe('Encontré estas opciones:');
        expect(first.reply).not.toContain('no tengo');
      });

      it('{lo pedido} uses the customer words («Croquetas para cachorro»), not the model q', async () => {
        const built = build(
          [
            call('s1', 'searchCatalog', { q: 'croquetas cachorro' }),
            say('Tengo croquetas para adulto.'),
          ],
          {},
          { item: naturales, stock: lataStock },
        );
        built.chatbotApi.searchCatalog.mockResolvedValue([
          { ...naturales, name: 'Croquetas Naturales para Perros Adultos' },
        ] as never);
        const first = await built.service.tryHandle({
          senderId: SENDER,
          text: 'croquetas para cachorro tienen?',
        });
        if (first.kind !== 'handled') throw new Error('expected handled');
        expect(first.reply.startsWith('Croquetas para cachorro no tengo')).toBe(
          true,
        );
      });

      it('prod case «croquetas pedigree manejan?😊» → same message with one emoji closing it', async () => {
        const { first } = await prodTurn(
          [
            call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
            say(MODEL_TEXT),
          ],
          { text: 'croquetas pedigree manejan?😊' },
        );
        if (first.kind !== 'handled') throw new Error('expected handled');
        expect(first.reply).toMatch(/ \p{Extended_Pictographic}$/u);
        expect(
          (first.reply.match(/\p{Extended_Pictographic}/gu) ?? []).length,
        ).toBe(1);
        expect(first.reply.replace(/ \p{Extended_Pictographic}$/u, '')).toBe(
          PROD_REPLY,
        );
      });

      it("L33 prod case «alimento para aves manejan?😊»: jaula (species only), TetraMin (peces), Hill's (felino) → dead end with emoji, nothing listed", async () => {
        const jaula = {
          ...dentastix,
          productId: pid(30),
          name: 'Vision jaula para aves',
          brand: 'Vision',
          description: 'Jaula metálica para aves pequeñas.',
        };
        const tetra = {
          ...dentastix,
          productId: pid(31),
          name: 'TetraMin Hojuelas para Peces Tropicales',
          brand: 'Tetra',
          description: 'Alimento en hojuelas para peces tropicales.',
        };
        const hills = {
          ...dentastix,
          productId: pid(32),
          name: "Hill's Science Diet Felino Adult 7+",
          brand: "Hill's",
          description: 'Alimento seco para gatos sénior.',
        };
        const built = build(
          [
            call('s1', 'searchCatalog', { q: 'alimento para aves' }),
            say('Encontré estas opciones: Vision jaula para aves.'),
          ],
          {},
          { item: jaula, stock: lataStock },
        );
        built.chatbotApi.searchCatalog.mockResolvedValue([
          jaula,
          tetra,
          hills,
        ] as never);
        await expect(
          built.service.tryHandle({
            senderId: SENDER,
            text: 'alimento para aves manejan?😊',
          }),
        ).resolves.toEqual({
          kind: 'handled',
          reply:
            'Alimento para aves no tengo por ahora. ¿Quiere que le pregunte al equipo si lo pueden conseguir, o le busco otra cosa? 😊',
        });
      });

      describe('S14: prod shape with categories', () => {
        const withCategory = (
          over: Record<string, unknown>,
          category: { id: string; name: string },
        ) => ({ ...dentastix, ...over, category });
        const jaula = withCategory(
          {
            productId: pid(30),
            name: 'Vision jaula para aves',
            brand: 'Vision',
            description: 'Jaula metálica para aves pequeñas.',
          },
          { id: 'c-jaulas', name: 'Jaulas y accesorios' },
        );
        const tetra = withCategory(
          {
            productId: pid(31),
            name: 'TetraMin Hojuelas para Peces Tropicales',
            brand: 'Tetra',
            description: 'Alimento en hojuelas para peces tropicales.',
          },
          { id: 'c-peces', name: 'Alimento para peces' },
        );
        const hills = withCategory(
          {
            productId: pid(32),
            name: "Hill's Science Diet Felino Adult 7+",
            brand: "Hill's",
            description: 'Alimento seco para gatos sénior.',
          },
          { id: 'c-gato', name: 'Alimento para gato' },
        );
        const alpiste = withCategory(
          {
            productId: pid(33),
            name: 'Alpiste 1 kg',
            brand: null,
            description: null,
            price: priced(4500),
          },
          { id: 'c-aves', name: 'Alimento para aves' },
        );
        const turn = async (items: unknown[]) => {
          const built = build(
            [
              call('s1', 'searchCatalog', { q: 'alimento para aves' }),
              say('Encontré estas opciones: Vision jaula para aves.'),
            ],
            {},
            { item: jaula, stock: lataStock },
          );
          built.chatbotApi.searchCatalog.mockResolvedValue(items as never);
          return built.service.tryHandle({
            senderId: SENDER,
            text: 'alimento para aves manejan?😊',
          });
        };

        it('no bird food among the results → still the dead end, nothing listed', async () => {
          await expect(turn([jaula, tetra, hills])).resolves.toEqual({
            kind: 'handled',
            reply:
              'Alimento para aves no tengo por ahora. ¿Quiere que le pregunte al equipo si lo pueden conseguir, o le busco otra cosa? 😊',
          });
        });

        it('an Alpiste in «Alimento para aves» (name without species/type) → listed alone', async () => {
          const result = await turn([jaula, tetra, hills, alpiste]);
          if (result.kind !== 'handled') throw new Error('expected handled');
          expect(result.reply.startsWith('Encontré estas opciones:')).toBe(
            true,
          );
          expect(result.reply).toContain('*Alpiste 1 kg*');
          expect(result.reply).toContain('$45.00 MXN');
          expect(result.reply).not.toMatch(/jaula|Tetra|Hill/i);
          expect(result.reply).not.toContain('no tengo');
        });
      });

      it('no emoji in the customer style → no emoji in the rendered message', async () => {
        const { first } = await prodTurn([
          call('s1', 'searchCatalog', { q: 'croquetas pedigree' }),
          say(`${MODEL_TEXT} 😊`),
        ]);
        expect(first).toEqual({ kind: 'handled', reply: PROD_REPLY });
      });
    });
  });

  describe('S12 checkStock with presentations never claims from the product-level stock', () => {
    const run = async (
      item: unknown,
      stock: unknown,
    ): Promise<Record<string, unknown>> => {
      const { service, captured } = build(flow, {}, { item, stock });
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      await captured[0].tools!.searchCatalog.execute({ q: 'x' }, {});
      return (await captured[0].tools!.checkStock.execute(
        { productId: PRODUCT },
        {},
      )) as Record<string, unknown>;
    };
    const lata = { ...variant, variantId: VARIANT, name: 'Lata' };
    const bolsa = {
      ...variant,
      variantId: OUTSIDE,
      name: 'Bolsa',
      stock: { status: 'available', quantity: 4 },
    };

    it('product-level out_of_stock/0 from /stock with an available presentation: no product stock, availability from the presentations', async () => {
      const out = await run(
        {
          ...simpleItem,
          stock: { status: 'available', quantity: 4 },
          variants: [lata, bolsa],
        },
        {
          ...simpleStock,
          stock: { status: 'out_of_stock', quantity: 0 },
          variants: [lata, bolsa],
        },
      );
      expect(out.ok).toBe(true);
      expect(out).not.toHaveProperty('stock');
      expect(out.availability).toEqual({
        status: 'available',
        agotado_presentations: ['Lata'],
      });
      expect(
        (out.variants as Array<{ stock: { status: string } }>).map(
          (v) => v.stock.status,
        ),
      ).toEqual(['out_of_stock', 'available']);
    });

    it('product-level available from /stock with every presentation agotado is agotado', async () => {
      const out = await run(
        {
          ...simpleItem,
          stock: { status: 'available', quantity: 4 },
          variants: [lata],
        },
        {
          ...simpleStock,
          stock: { status: 'available', quantity: 9 },
          variants: [lata],
        },
      );
      expect(out).not.toHaveProperty('stock');
      expect(out.availability).toEqual({
        status: 'out_of_stock',
        agotado_presentations: ['Lata'],
      });
    });

    it('a product without presentations keeps its own stock unchanged', async () => {
      const out = await run(simpleItem, simpleStock);
      expect(out.stock).toEqual(simpleStock.stock);
      expect(out).not.toHaveProperty('availability');
    });
  });

  it('traces route entry and tool outcomes with one generated id per run, no raw data', async () => {
    const { service } = build(flow);
    const logs = captureLogs();
    await service.tryHandle({ senderId: SENDER, text: 'tienen ibuprofeno' });
    await service.tryHandle({ senderId: SENDER, text: 'sí, esa' });
    const entries = logs.filter((line) =>
      line.startsWith('minimal_catalog route_enter '),
    );
    expect(entries).toHaveLength(2);
    const idOf = (line: string) => /trace=(\S+)/.exec(line)![1];
    const [first, second] = entries.map(idOf);
    expect(first).not.toBe(second);
    expect(logs).toContain(
      `minimal_catalog tool searchCatalog result=ok searchResultCount=1 trace=${first}`,
    );
    expect(logs).toContain(
      `minimal_catalog tool searchCatalog result=ok searchResultCount=1 trace=${second}`,
    );
    expect(logs).toContain(
      `minimal_catalog tool checkStock result=ok parentStockStatus=low_stock parentStockQuantity=2 trace=${second}`,
    );
    const searchLine = logs.find(
      (line) => line.includes('tool searchCatalog') && line.includes(second),
    )!;
    expect(searchLine).not.toMatch(/Stock|Quantity|status/i);
    const joined = logs.join('\n');
    for (const raw of [SENDER, PRODUCT, VARIANT, 'ibuprofeno', 'Ibuprofeno']) {
      expect(joined).not.toContain(raw);
    }
  });

  it('logs closed status values and distinct deny/error codes', async () => {
    const { service, chatbotApi, captured } = build(
      [1, 2, 3].flatMap((n) => [
        call(`s${n}`, 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
      ]),
    );
    const notManaged = {
      ...simpleStock,
      stock: { status: 'not_managed' as const, quantity: null },
    };
    chatbotApi.getStock.mockResolvedValue(notManaged);
    await service.tryHandle({ senderId: SENDER, text: 'busca' });
    const { checkStock } = captured[0].tools!;
    const logs = captureLogs();
    await expect(
      checkStock.execute({ productId: OUTSIDE }, {}),
    ).resolves.toEqual({ ok: false, error: 'unknown_product' });
    expect(chatbotApi.getStock).not.toHaveBeenCalled();
    await expect(
      checkStock.execute({ productId: PRODUCT }, {}),
    ).resolves.toMatchObject({
      stock: { status: 'not_managed', quantity: null },
    });
    // A repeated read in one run reuses its first answer (G1), so each
    // further outcome is read through a fresh run's tools.
    const freshCheckStock = async () => {
      await service.tryHandle({ senderId: SENDER, text: 'busca' });
      return captured.at(-1)!.tools!.checkStock;
    };
    chatbotApi.getStock.mockResolvedValueOnce({
      ...notManaged,
      stock: { status: 'bogus', quantity: 'x' },
    } as never);
    await (await freshCheckStock()).execute({ productId: PRODUCT }, {});
    chatbotApi.getStock.mockRejectedValueOnce(new Error('leaked detail'));
    await expect(
      (await freshCheckStock()).execute({ productId: PRODUCT }, {}),
    ).resolves.toEqual({ ok: false, error: 'stock_unavailable' });
    const joined = logs.join('\n');
    expect(joined).toContain(
      'result=ok parentStockStatus=not_managed parentStockQuantity=null',
    );
    expect(joined).toContain(
      'result=ok parentStockStatus=unknown parentStockQuantity=null',
    );
    expect(joined).toContain('result=denied code=unknown_product');
    expect(joined).toContain('result=error code=stock_unavailable');
    expect(joined).not.toContain('leaked');
    expect(joined).not.toContain(PRODUCT);
  });

  it('keeps replies, history and tool calls intact when logging throws', async () => {
    const { service, chatbotApi, captured } = build(flow);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw new Error('sink down');
    });
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'tienen ibuprofeno' }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: IBUPROFENO_OPTIONS,
    });
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'sí, esa' }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: 'Revisé las existencias del producto.',
    });
    expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(2);
    expect(chatbotApi.getStock).toHaveBeenCalledTimes(1);
    expect(captured[1].messages!.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
  });

  it('answers a bounded busy reply to a concurrent same-sender turn without a second SDK run', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [say('hola')],
    } as never);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const generate: GenerateTextFn = async (options) => {
      calls += 1;
      await gate;
      return generateText({ ...options, model });
    };
    const config = {
      get: () => ({ model: 'm', maxSteps: 4, historyTurns: 12 }),
    } as unknown as ConfigService;
    const service = new MinimalCatalogAgentService(
      {
        searchCatalog: jest.fn(),
        getStock: jest.fn(),
      } as unknown as ChatbotApiClient,
      generate,
      new CostGuardService(1_000),
      config,
      new InMemoryMinimalCatalogSessionStore(),
    );
    const first = service.tryHandle({ senderId: SENDER, text: 'a' });
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'b' }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: 'Ya estoy atendiendo su consulta; por favor espere mi respuesta.',
    });
    release();
    await expect(first).resolves.toEqual({ kind: 'handled', reply: 'hola' });
    expect(calls).toBe(1);
  });

  it('answers the busy reply in the tú style of a customer who tutea', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [say('hola')],
    } as never);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate: GenerateTextFn = async (options) => {
      await gate;
      return generateText({ ...options, model });
    };
    const service = new MinimalCatalogAgentService(
      {
        searchCatalog: jest.fn(),
        getStock: jest.fn(),
      } as unknown as ChatbotApiClient,
      generate,
      new CostGuardService(1_000),
      {
        get: () => ({ model: 'm', maxSteps: 4, historyTurns: 12 }),
      } as unknown as ConfigService,
      new InMemoryMinimalCatalogSessionStore(),
    );
    const first = service.tryHandle({ senderId: SENDER, text: 'a' });
    await expect(
      service.tryHandle({
        senderId: SENDER,
        text: 'oye, ¿ya tienes mi respuesta?',
      }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: 'Ya estoy atendiendo tu consulta; por favor espera mi respuesta.',
    });
    release();
    await first;
  });

  describe('customer style mirroring (S2)', () => {
    it('tells the model to stay usted, sober and emoji-free for a serious customer', async () => {
      const { service, captured } = build([say('Buenos días.')]);
      await service.tryHandle({
        senderId: SENDER,
        text: 'Buenos días, ¿me puede decir si tienen arena para gato?',
      });
      const system = String(captured[0].system);
      expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(system).toContain(
        'Estilo del cliente: de usted, sin emojis, tono formal.',
      );
      expect(system).toContain('Responde de usted');
      expect(system).toContain('tono profesional y sobrio');
      expect(system).not.toContain('Responde de tú');
    });

    it('follows a customer who tutea and uses emojis across the session', async () => {
      const { service, captured } = build([say('Hola'), say('Claro')]);
      await service.tryHandle({ senderId: SENDER, text: 'hola 🐶' });
      // S5: emojis need one in the latest message (or 2 of the last 3).
      await service.tryHandle({
        senderId: SENDER,
        text: '¿tienes croquetas para cachorro? 😊',
      });
      expect(String(captured[0].system)).toContain(
        'Estilo del cliente: de usted, usa emojis, tono casual.',
      );
      const second = String(captured[1].system);
      expect(second).toContain(
        'Estilo del cliente: tutea, usa emojis, tono casual.',
      );
      expect(second).toContain('Responde de tú');
      expect(second).toContain('1 emoji natural como máximo por mensaje');
    });

    it('never sends model emojis to a customer who uses none, and keeps them for one who does', async () => {
      const { service } = build([
        say('¡Claro! 😊 Tenemos croquetas.'),
        say('¡Claro! 😊 Tenemos croquetas.'),
      ]);
      await expect(
        service.tryHandle({ senderId: SENDER, text: '¿tienen croquetas?' }),
      ).resolves.toEqual({
        kind: 'handled',
        reply: '¡Claro! Tenemos croquetas.',
      });
      await expect(
        service.tryHandle({ senderId: OTHER, text: '¿tienen croquetas? 🐶' }),
      ).resolves.toEqual({
        kind: 'handled',
        reply: '¡Claro! 😊 Tenemos croquetas.',
      });
    });
  });

  it('retains each turn through the injected session store, not a private map', async () => {
    const sessionStore = new InMemoryMinimalCatalogSessionStore();
    const { service } = build([say('hola')], { sessionStore });
    await service.tryHandle({ senderId: SENDER, text: 'hola' });
    expect(sessionStore.read(SENDER)).toHaveLength(1);
  });

  // The cross-turn guarantee: a productId verified by an earlier turn's
  // search may be checked directly once the customer confirms it; stock reads,
  // greetings and user text never grant or renew that identity.
  describe('cross-turn identity (retained verified productIds)', () => {
    const outOfStock = {
      ...simpleStock,
      stock: { status: 'out_of_stock', quantity: 0 },
    };

    it('reuses a retained verified productId on a later turn without re-search', async () => {
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('Sí, está agotado por ahora.'),
      ];
      const { service, chatbotApi, results } = build(
        steps,
        {},
        { item: simpleItem, stock: outOfStock },
      );
      await service.tryHandle({ senderId: SENDER, text: 'tienen ibuprofeno' });
      await expect(
        service.tryHandle({ senderId: SENDER, text: 'sí, esa' }),
      ).resolves.toEqual({
        kind: 'handled',
        reply: 'Sí, está agotado por ahora.',
      });
      expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(1);
      expect(chatbotApi.getStock).toHaveBeenCalledWith(PRODUCT);
      const turnB = JSON.stringify(results[1].responseMessages);
      expect(turnB).toContain('"ok":true');
      expect(turnB).toContain('"out_of_stock"');
      expect(turnB).not.toContain('unknown_product');
    });

    it('isolates retained identity per sender', async () => {
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('No puedo revisarlo así.'),
      ];
      const { service, chatbotApi, results } = build(steps);
      await service.tryHandle({ senderId: SENDER, text: 'tienen ibuprofeno' });
      await service.tryHandle({ senderId: OTHER, text: 'esa' });
      expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(1);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
      expect(JSON.stringify(results[1].responseMessages)).toContain(
        'unknown_product',
      );
    });

    it('expires identity after historyTurns and never renews it on a stock read', async () => {
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('Está agotado.'),
        call('c2', 'checkStock', { productId: PRODUCT }),
        say('Necesito confirmarlo de nuevo.'),
      ];
      const { service, chatbotApi, results, captured } = build(
        steps,
        { historyTurns: 1 },
        { item: simpleItem, stock: outOfStock },
      );
      await service.tryHandle({ senderId: SENDER, text: 'bu' });
      await service.tryHandle({ senderId: SENDER, text: 'sí' });
      await service.tryHandle({ senderId: SENDER, text: 'y el stock' });
      expect(chatbotApi.getStock).toHaveBeenCalledTimes(1);
      expect(chatbotApi.getStock).toHaveBeenCalledWith(PRODUCT);
      expect(JSON.stringify(results[1].responseMessages)).toContain(
        '"out_of_stock"',
      );
      expect(JSON.stringify(results[2].responseMessages)).toContain(
        'unknown_product',
      );
      expect(captured[2].messages!.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
        'user',
      ]);
    });

    it('never GETs an id mentioned only in user text', async () => {
      const steps = [
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('No puedo confirmarlo.'),
      ];
      const { service, chatbotApi, results } = build(steps);
      await service.tryHandle({
        senderId: SENDER,
        text: `mi producto es ${PRODUCT}`,
      });
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
      expect(JSON.stringify(results[0].responseMessages)).toContain(
        'unknown_product',
      );
    });

    it('forgets retained identity when the service restarts', async () => {
      const first = build([
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
      ]);
      await first.service.tryHandle({
        senderId: SENDER,
        text: 'tienen ibuprofeno',
      });
      const restarted = build([
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('No puedo confirmarlo.'),
      ]);
      await restarted.service.tryHandle({ senderId: SENDER, text: 'sí, esa' });
      expect(restarted.chatbotApi.getStock).not.toHaveBeenCalled();
    });

    it('grants no identity when search fails or its projection rejects', async () => {
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('No pude consultar.'),
        call('s2', 'searchCatalog', { q: 'ibuprofeno' }),
        call('c2', 'checkStock', { productId: PRODUCT }),
        say('Sigo sin poder.'),
      ];
      const { service, chatbotApi, results } = build(steps);
      chatbotApi.searchCatalog.mockRejectedValueOnce(new Error('http down'));
      await service.tryHandle({ senderId: SENDER, text: 'bu' });
      chatbotApi.searchCatalog.mockResolvedValueOnce([
        { ...simpleItem, variants: undefined } as never,
      ]);
      await service.tryHandle({ senderId: SENDER, text: 'sí' });
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
      expect(JSON.stringify(results[0].responseMessages)).toContain(
        'unknown_product',
      );
      expect(JSON.stringify(results[1].responseMessages)).toContain(
        'unknown_product',
      );
    });

    it('does not persist identity when generation fails after a search', async () => {
      let modelCall = 0;
      const doGenerate = async () => {
        modelCall += 1;
        if (modelCall === 1) {
          return call('s1', 'searchCatalog', { q: 'ibuprofeno' });
        }
        if (modelCall === 2) throw new Error('model down');
        if (modelCall === 3) {
          return call('c1', 'checkStock', { productId: PRODUCT });
        }
        return say('No puedo confirmarlo.');
      };
      const { service, chatbotApi } = build(
        doGenerate,
        {},
        { item: simpleItem, stock: outOfStock },
      );
      await expect(
        service.tryHandle({ senderId: SENDER, text: 'a' }),
      ).rejects.toThrow('model down');
      await service.tryHandle({ senderId: SENDER, text: 'b' });
      expect(chatbotApi.searchCatalog).toHaveBeenCalledTimes(1);
      expect(chatbotApi.getStock).not.toHaveBeenCalled();
    });
  });

  describe('RESTOCK confirmation wiring (real service, real preflight)', () => {
    const INBOUND = {
      receivingPhoneNumberId: '123456789012345',
      senderId: SENDER,
      messageId: 'wamid.A',
    };
    const CONFIRM = { ...INBOUND, messageId: 'wamid.B' };
    const THIRD = { ...INBOUND, messageId: 'wamid.C' };
    const oos = {
      ...simpleStock,
      stock: { status: 'out_of_stock', quantity: 0 },
    };
    // S2: these customers write no emojis, so the fixed copy carries none.
    const QUESTION =
      'Por ahora no tenemos «Ibuprofeno 400 mg». ¿Quiere que consulte si hay una fecha estimada de reposición?';

    const wire = () => {
      const instances: MinimalRestockRequestService[] = [];
      const coordinate = jest.fn<
        Promise<{ decision: string }>,
        [
          {
            senderId: string;
            intake: { productId: string; sourceRequestId: string };
          },
        ]
      >(async () => ({ decision: 'recorded' }));
      const recover = jest.fn(async () => ({ outcome: 'unavailable' }));
      const markers = {
        readForSender: jest.fn(async () => ({
          legacyRequestPending: false,
          restockIntentPresent: false,
        })),
      };
      const store = { get: jest.fn(async () => null) };
      return {
        coordinate,
        recover,
        markers,
        instances,
        restock: (api: ChatbotApiClient) => {
          const service = new MinimalRestockRequestService({
            chatbotApi: api,
            store: store as never,
            restock: {
              markers,
              coordinator: { coordinate },
              recovery: { recover },
            } as never,
          });
          instances.push(service);
          return service;
        },
      };
    };

    it('proposes the offer proactively after selection and writes only on a NEW SÍ, with no extra SDK run', async () => {
      const w = wire();
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        call('p1', 'prepareRestock', { productId: PRODUCT }),
        call('p2', 'prepareRestock', { productId: PRODUCT }),
        say('listo'),
      ];
      const { service, chatbotApi, captured } = build(
        steps,
        { restock: w.restock },
        { item: simpleItem, stock: oos },
      );
      // Turn 1: a mere search presents the product and offers nothing yet. The
      // mock scripts tool calls, so this pins the plumbing/gates, NOT that a
      // real model would pick the tool without pressure.
      const first = await service.tryHandle({
        senderId: SENDER,
        text: 'tienen ibuprofeno',
        inboundEvent: INBOUND,
      });
      expect(first).toMatchObject({
        kind: 'handled',
        reply: IBUPROFENO_OPTIONS, // S13: rendered by the application
      });
      expect(w.coordinate).not.toHaveBeenCalled();
      // Turn 2: the product-selection SÍ. The model checks stock, sees agotado
      // and prepares the offer in the SAME run without a date question. The
      // SERVER copy (not the model text) states the shortage and asks SÍ/NO.
      const second = await service.tryHandle({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: CONFIRM,
      });
      expect(second).toMatchObject({ kind: 'handled', reply: QUESTION });
      expect(String(captured[1].system)).toContain('prepareRestock');
      expect(chatbotApi.getStock).toHaveBeenCalledTimes(2);
      expect(w.coordinate).not.toHaveBeenCalled();
      if (second.kind !== 'handled') throw new Error('expected handled');
      second.onSent?.();
      // Arming the offer never writes: product selection is NOT approval.
      expect(w.coordinate).not.toHaveBeenCalled();
      // Replaying the SAME selection message must not run the SDK again nor
      // write; it only re-exposes the checked question.
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: CONFIRM,
        }),
      ).resolves.toMatchObject({ kind: 'handled', reply: QUESTION });
      expect(captured).toHaveLength(2);
      expect(w.coordinate).not.toHaveBeenCalled();
      // Only a NEW trusted SÍ after the outbound send writes exactly once.
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: THIRD,
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply:
          '¡Listo! Ya quedó registrada su consulta sobre la reposición de «Ibuprofeno 400 mg». ¡Gracias!',
      });
      expect(w.coordinate).toHaveBeenCalledTimes(1);
      const [arg] = w.coordinate.mock.calls[0];
      expect(arg.senderId).toBe(SENDER);
      expect(arg.intake.productId).toBe(PRODUCT);
      expect(arg.intake.sourceRequestId).toBe(
        deriveRestockSourceRequestId(THIRD),
      );
      expect(w.recover).not.toHaveBeenCalled();
    });

    // Shared shape for the proactive-preparation tests: turn 1 presents the
    // product, turn 2 runs the scripted tail after the trusted checkStock.
    const proactive = async (
      stock: unknown,
      tail: unknown[],
      item: unknown = simpleItem,
      arrange?: (ctx: {
        chatbotApi: jest.Mocked<ChatbotApiClient>;
        prepare: jest.SpyInstance;
      }) => void,
    ) => {
      const w = wire();
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        ...tail,
      ];
      const { service, chatbotApi } = build(
        steps,
        { restock: w.restock },
        { item, stock },
      );
      await service.tryHandle({
        senderId: SENDER,
        text: 'tienen ibuprofeno',
        inboundEvent: INBOUND,
      });
      const prepare = jest.spyOn(w.instances[0], 'prepare');
      arrange?.({ chatbotApi, prepare });
      const second = await service.tryHandle({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: CONFIRM,
      });
      return { w, service, prepare, second };
    };

    it('prepares the canonical simple-product offer proactively from a trusted checkStock, with no explicit prepare call', async () => {
      // The model reads stock and only PROMISES a notification — it never calls
      // prepareRestock, and mentions a 400 mg presentation the read denies.
      const { w, service, prepare, second } = await proactive(oos, [
        say('Le aviso cuando llegue el ibuprofeno 400 mg.'),
      ]);
      // The SERVER offer replaces the model's unfounded promise.
      expect(second).toMatchObject({ kind: 'handled', reply: QUESTION });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0][0]).toMatchObject({ productId: PRODUCT });
      expect(prepare.mock.calls[0][0]).not.toHaveProperty('variantId');
      expect(w.coordinate).not.toHaveBeenCalled();
      if (second.kind !== 'handled') throw new Error('expected handled');
      second.onSent?.();
      expect(w.coordinate).not.toHaveBeenCalled();
      // Replaying the selection never runs the SDK nor writes.
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: CONFIRM,
        }),
      ).resolves.toMatchObject({ kind: 'handled', reply: QUESTION });
      expect(w.coordinate).not.toHaveBeenCalled();
      // A NEW polite affirmative coordinates exactly once under its own id.
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'Sí, por favor',
          inboundEvent: THIRD,
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply:
          '¡Listo! Ya quedó registrada su consulta sobre la reposición de «Ibuprofeno 400 mg». ¡Gracias!',
      });
      expect(w.coordinate).toHaveBeenCalledTimes(1);
      const [coord] = w.coordinate.mock.calls[0];
      expect(coord.intake.productId).toBe(PRODUCT);
      expect(coord.intake.sourceRequestId).toBe(
        deriveRestockSourceRequestId(THIRD),
      );
    });

    it('keeps the cautious copy over a model notification claim when the proactive preparation closes', async () => {
      // The trusted depleted read triggers the proactive attempt, but the
      // preparation's own read fails, so it closes; the model then claims a
      // notification. The SERVER cautious reply must win, never the promise.
      const { w, prepare, second } = await proactive(
        oos,
        [say('Le aviso en cuanto llegue.')],
        simpleItem,
        ({ chatbotApi }) => {
          chatbotApi.getStock
            .mockResolvedValueOnce(oos as never)
            .mockRejectedValueOnce(new Error('read down'));
        },
      );
      expect(second).toEqual({
        kind: 'handled',
        reply: 'Por ahora no puedo preparar esa consulta de reposición.',
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(w.coordinate).not.toHaveBeenCalled();
    });

    it('never auto-prepares a variantful product from a depleted parent read', async () => {
      // S13d: an agotado search label would arm the rendered restock offer
      // and a plain "SÍ" would accept it; the search payload says available
      // here so this test keeps isolating the checkStock proactive gate.
      const { w, prepare, second } = await proactive(
        { ...oos, variants: [variant] },
        [say('El producto está agotado.')],
        {
          ...variantItem,
          variants: [
            { ...variant, stock: { status: 'available', quantity: 3 } },
          ],
        },
      );
      expect(second).toEqual({
        kind: 'handled',
        reply: 'El producto está agotado.',
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(w.coordinate).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      [
        'an available parent',
        { ...simpleStock, stock: { status: 'available', quantity: 4 } },
      ],
      [
        'a not_managed parent',
        { ...simpleStock, stock: { status: 'not_managed', quantity: null } },
      ],
      [
        'an out_of_stock parent with a nonzero quantity',
        { ...simpleStock, stock: { status: 'out_of_stock', quantity: 3 } },
      ],
      ['a malformed read', { ...simpleStock, variants: undefined }],
      [
        'a mismatched product identity',
        {
          ...simpleStock,
          productId: OUTSIDE,
          stock: { status: 'out_of_stock', quantity: 0 },
        },
      ],
    ])('prepares nothing on %s', async (_name, stock) => {
      const { w, prepare, second } = await proactive(stock, [
        say('Texto del modelo verbatim.'),
      ]);
      expect(second).toEqual({
        kind: 'handled',
        reply: 'Texto del modelo verbatim.',
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(w.coordinate).not.toHaveBeenCalled();
    });

    it('keeps the valid proactive offer when the model redundantly prepares with an invented variant', async () => {
      const { w, prepare, second } = await proactive(oos, [
        call('p1', 'prepareRestock', {
          productId: PRODUCT,
          variantId: VARIANT,
        }),
        say('listo'),
      ]);
      // Only the proactive attempt reached the service; the model's invented
      // variant was blocked and could not clobber the valid offer.
      expect(second).toMatchObject({ kind: 'handled', reply: QUESTION });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0][0]).not.toHaveProperty('variantId');
      expect(w.coordinate).not.toHaveBeenCalled();
    });

    it('a NO decline clears the pending, claims nothing and writes nothing', async () => {
      const w = wire();
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        call('p1', 'prepareRestock', { productId: PRODUCT }),
        say('listo'),
      ];
      const { service, captured } = build(
        steps,
        { restock: w.restock },
        { item: simpleItem, stock: oos },
      );
      const first = await service.tryHandle({
        senderId: SENDER,
        text: 'avísenme',
        inboundEvent: INBOUND,
      });
      if (first.kind !== 'handled') throw new Error('expected handled');
      first.onSent?.();
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'NO',
          inboundEvent: CONFIRM,
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply: 'Entendido, no registraré su consulta de reposición. ¡Gracias!',
      });
      expect(w.coordinate).not.toHaveBeenCalled();
      expect(captured).toHaveLength(1);
    });

    it('a closed preparation yields the cautious copy and never a model claim or write', async () => {
      const w = wire();
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        call('p1', 'prepareRestock', { productId: PRODUCT }),
        say('¡Ya la registré!'),
      ];
      const { service } = build(
        steps,
        { restock: w.restock },
        { item: simpleItem, stock: simpleStock },
      );
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'avísenme',
          inboundEvent: INBOUND,
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply: 'Por ahora no puedo preparar esa consulta de reposición.',
      });
      expect(w.coordinate).not.toHaveBeenCalled();
    });

    it('traces the private closed prepare reason while the model sees only the generic error', async () => {
      const w = wire();
      const { service, captured } = build(
        flow,
        { restock: w.restock },
        { item: simpleItem, stock: simpleStock },
      );
      await service.tryHandle({
        senderId: SENDER,
        text: 'busca',
        inboundEvent: INBOUND,
      });
      const logs = captureLogs();
      await expect(
        captured[0].tools!.prepareRestock.execute({ productId: PRODUCT }, {}),
      ).resolves.toEqual({ ok: false, error: 'restock_unavailable' });
      const joined = logs.join('\n');
      expect(joined).toContain(
        'tool prepareRestock result=closed code=parent_not_depleted',
      );
      expect(joined).not.toContain('not_available');
    });

    it('keeps an unexpected prepare failure generic and free of raw values', async () => {
      const boom = {
        prepare: jest.fn().mockRejectedValue(new Error('RAW_SENTINEL_9f3')),
        consume: jest.fn(async () => null),
      } as unknown as MinimalRestockRequestService;
      const { service, captured } = build(flow, { restock: () => boom });
      await service.tryHandle({
        senderId: SENDER,
        text: 'busca',
        inboundEvent: INBOUND,
      });
      const logs = captureLogs();
      await expect(
        captured[0].tools!.prepareRestock.execute({ productId: PRODUCT }, {}),
      ).resolves.toEqual({ ok: false, error: 'restock_unavailable' });
      const joined = logs.join('\n');
      expect(joined).toContain(
        'tool prepareRestock result=error code=restock_unavailable',
      );
      expect(joined).not.toContain('RAW_SENTINEL_9f3');
    });

    it('an unexpected consume failure never falls back to the legacy/SDK path', async () => {
      const boom = {
        consume: jest.fn().mockRejectedValue(new Error('boom')),
      } as unknown as MinimalRestockRequestService;
      const { service, captured } = build([say('legacy?')], {
        restock: () => boom,
      });
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: CONFIRM,
        }),
      ).rejects.toThrow('boom');
      expect(captured).toHaveLength(0);
    });

    it('exposes the restock tool, its natural-date instruction and a closed capability diagnostic only when bound', async () => {
      // The mock scripts tool calls, so this pins the prompt/gates and the
      // closed diagnostic; it does not prove a real model chooses the tool.
      const w = wire();
      const off = build(flow);
      const unbound = build(flow, { restock: w.restock });
      const bound = build(flow, { restock: w.restock });
      const logs = captureLogs();
      await off.service.tryHandle({ senderId: SENDER, text: '¿fecha?' });
      await unbound.service.tryHandle({ senderId: SENDER, text: '¿fecha?' });
      await bound.service.tryHandle({
        senderId: SENDER,
        text: '¿fecha?',
        inboundEvent: INBOUND,
      });

      // Tool inventory, not just the prompt, must match the capability.
      expect(Object.keys(off.captured[0].tools!)).not.toContain(
        'prepareRestock',
      );
      expect(Object.keys(unbound.captured[0].tools!)).not.toContain(
        'prepareRestock',
      );
      expect(Object.keys(bound.captured[0].tools!)).toContain('prepareRestock');
      // The natural-date instruction reaches generateText ONLY when available.
      expect(String(off.captured[0].system)).not.toContain('¿cuándo vuelve?');
      expect(String(unbound.captured[0].system)).not.toContain(
        '¿cuándo vuelve?',
      );
      expect(String(bound.captured[0].system)).toContain('¿cuándo vuelve?');
      // The proactive post-confirmation trigger reaches generateText ONLY when
      // the tool is actually exposed.
      expect(String(off.captured[0].system)).not.toContain(
        'por iniciativa propia',
      );
      expect(String(unbound.captured[0].system)).not.toContain(
        'por iniciativa propia',
      );
      expect(String(bound.captured[0].system)).toContain(
        'por iniciativa propia',
      );

      const caps = logs.filter((line) =>
        line.startsWith('minimal_catalog capability prepareRestock='),
      );
      const kinds = caps.map(
        (line) => /prepareRestock=(\w+) trace=\S+$/.exec(line)![1],
      );
      expect(caps).toHaveLength(3);
      expect(kinds).toEqual(['disabled', 'unbound', 'available']);
      const joined = logs.join('\n');
      for (const raw of [SENDER, OTHER, PRODUCT, VARIANT, 'ibuprofeno']) {
        expect(joined).not.toContain(raw);
      }
    });

    it('routes a natural affirmative through the real SDK classifier and writes once (plumbing, not model judgment)', async () => {
      const w = wire();
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        call('p1', 'prepareRestock', { productId: PRODUCT }),
        say('listo'),
        say('{"result":"accept"}'),
      ];
      const { service, captured, costGuard } = build(
        steps,
        { restock: w.restock },
        { item: simpleItem, stock: oos },
      );
      await service.tryHandle({
        senderId: SENDER,
        text: 'tienen ibuprofeno',
        inboundEvent: INBOUND,
      });
      const offer = await service.tryHandle({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: CONFIRM,
      });
      expect(offer).toMatchObject({ kind: 'handled', reply: QUESTION });
      if (offer.kind !== 'handled') throw new Error('expected handled');
      offer.onSent?.();
      const logs = captureLogs();
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'sí, muchas gracias, me ayudaría mucho',
          inboundEvent: THIRD,
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply:
          '¡Listo! Ya quedó registrada su consulta sobre la reposición de «Ibuprofeno 400 mg». ¡Gracias!',
      });
      expect(w.coordinate).toHaveBeenCalledTimes(1);
      // Classifier call is tool-less and history-less, bound to the exact sent
      // question and the current reply; no classifier JSON reaches the logs.
      const classify = captured[2];
      expect(classify.tools).toBeUndefined();
      expect(classify.messages).toBeUndefined();
      // The classifier reads the canonical pending question (usted copy);
      // only the sent text is styled for the customer.
      expect(String(classify.prompt)).toContain(
        minimalRestockProposal('Ibuprofeno 400 mg'),
      );
      expect(String(classify.prompt)).toContain(
        'sí, muchas gracias, me ayudaría mucho',
      );
      expect(costGuard.currentAggregate).toBeGreaterThan(0);
      expect(logs.join('\n')).not.toContain('"result"');
    });

    it('keeps pending without any catalog generation when the classifier says unclear', async () => {
      const w = wire();
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        call('p1', 'prepareRestock', { productId: PRODUCT }),
        say('listo'),
        say('{"result":"unclear"}'),
      ];
      const { service, chatbotApi, captured } = build(
        steps,
        { restock: w.restock },
        { item: simpleItem, stock: oos },
      );
      await service.tryHandle({
        senderId: SENDER,
        text: 'tienen ibuprofeno',
        inboundEvent: INBOUND,
      });
      const offer = await service.tryHandle({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: CONFIRM,
      });
      if (offer.kind !== 'handled') throw new Error('expected handled');
      offer.onSent?.();
      chatbotApi.searchCatalog.mockClear();
      await expect(
        service.tryHandle({
          senderId: SENDER,
          text: 'no sé',
          inboundEvent: THIRD,
        }),
      ).resolves.toEqual({
        kind: 'handled',
        reply:
          'Perdón, no estoy seguro de haberle entendido. ¿Quiere que consulte si hay una fecha estimada de reposición?',
      });
      expect(chatbotApi.searchCatalog).not.toHaveBeenCalled();
      expect(captured).toHaveLength(3);
      expect(w.coordinate).not.toHaveBeenCalled();
    });
  });
});
