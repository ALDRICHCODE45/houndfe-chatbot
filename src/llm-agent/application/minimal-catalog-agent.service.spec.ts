import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { SYSTEM_PROMPT } from '../domain/system-prompt';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

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
  messages?: ModelMessage[];
  tools?: Record<string, Tool>;
  stopWhen?: (state: { steps: unknown[] }) => boolean;
};

function build(
  steps: unknown,
  over: Partial<{
    enabled: boolean;
    allowedSenders: string[];
    historyTurns: number;
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
    get: (path: string) =>
      path === 'minimalCatalogAgent'
        ? {
            enabled: over.enabled ?? true,
            allowedSenders: over.allowedSenders ?? [SENDER],
          }
        : { model: 'm', maxSteps: 4, historyTurns: over.historyTurns ?? 12 },
  } as unknown as ConfigService;
  const captured: Captured[] = [];
  const results: Array<{ responseMessages: ModelMessage[] }> = [];
  const costGuard = new CostGuardService(1_000_000);
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
    ),
    chatbotApi,
    costGuard,
    captured,
    results,
  };
}

function captureLogs(): string[] {
  const logs: string[] = [];
  jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    logs.push(String(message));
  });
  return logs;
}

describe('MinimalCatalogAgentService (experimental read-only SDK route)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('handles only an exact enabled allowlisted sender, else not-handled', async () => {
    const off = build([], { enabled: false });
    const other = build([], { allowedSenders: [OUTSIDE] });
    await expect(
      off.service.tryHandle({ senderId: SENDER, text: 'x' }),
    ).resolves.toEqual({ kind: 'not-handled' });
    await expect(
      other.service.tryHandle({ senderId: SENDER, text: 'x' }),
    ).resolves.toEqual({ kind: 'not-handled' });
    expect([...off.captured, ...other.captured]).toHaveLength(0);
  });

  it('runs confirm→re-search→checkStock and bounds tools/steps/usage', async () => {
    const { service, chatbotApi, costGuard, captured } = build(flow);
    await expect(
      service.tryHandle({ senderId: SENDER, text: 'tienen ibuprofeno' }),
    ).resolves.toEqual({
      kind: 'handled',
      reply: '¿Buscaba esa presentación?',
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
    expect(captured[1].messages!.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
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
      stock: { status: 'low_stock', quantity: 2 },
      variants: [{ stock: { status: 'out_of_stock', quantity: 0 } }],
    });
    chatbotApi.searchCatalog.mockRejectedValueOnce(new Error('leaked detail'));
    const failed = await searchCatalog.execute({ q: 'x' }, {});
    expect(failed).toEqual({ ok: false, error: 'catalog_unavailable' });
    expect(JSON.stringify(failed)).not.toContain('leaked');
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
    const { service, chatbotApi, captured } = build(flow);
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
    chatbotApi.getStock.mockResolvedValueOnce({
      ...notManaged,
      stock: { status: 'bogus', quantity: 'x' },
    } as never);
    await checkStock.execute({ productId: PRODUCT }, {});
    chatbotApi.getStock.mockRejectedValueOnce(new Error('leaked detail'));
    await expect(
      checkStock.execute({ productId: PRODUCT }, {}),
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
      reply: '¿Buscaba esa presentación?',
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
      get: (path: string) =>
        path === 'minimalCatalogAgent'
          ? { enabled: true, allowedSenders: [SENDER] }
          : { model: 'm', maxSteps: 4, historyTurns: 12 },
    } as unknown as ConfigService;
    const service = new MinimalCatalogAgentService(
      {
        searchCatalog: jest.fn(),
        getStock: jest.fn(),
      } as unknown as ChatbotApiClient,
      generate,
      new CostGuardService(1_000),
      config,
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

    it('isolates retained identity per allowed sender', async () => {
      const steps = [
        call('s1', 'searchCatalog', { q: 'ibuprofeno' }),
        say('¿Buscaba esa presentación?'),
        call('c1', 'checkStock', { productId: PRODUCT }),
        say('No puedo revisarlo así.'),
      ];
      const { service, chatbotApi, results } = build(steps, {
        allowedSenders: [SENDER, OTHER],
      });
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
});
