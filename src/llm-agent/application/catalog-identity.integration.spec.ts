import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { AgentRunner } from './agent-runner.service';
import { CostGuardService } from './cost-guard.service';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { VercelAiLlmAgent } from '../infrastructure/vercel-ai-llm-agent';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { makeSearchCatalogTool } from '../../sale-flow/application/tools/search-catalog.tool';
import { makeCheckStockTool } from '../../sale-flow/application/tools/check-stock.tool';
import { makeRequestHumanAssistanceTool } from '../../sale-flow/application/tools/request-human-assistance.tool';
import type { ToolDeps } from '../../sale-flow/application/tool-deps';

const productId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const product = {
  productId,
  name: 'Medicine 400 mg',
  variants: [],
  stock: { status: 'out_of_stock', quantity: 0 },
};
type Invocation = {
  tools: Record<
    string,
    { execute: (input: unknown, options: unknown) => Promise<unknown> }
  >;
  toolsContext: Record<string, unknown>;
  messages: unknown[];
  system?: string;
  instructions?: { role: 'system'; content: string }[];
};
type Step = (
  call: (name: string, input: unknown) => Promise<unknown>,
  invocation: Invocation,
) => Promise<void>;
function fixture(historyTurns = 4) {
  const store = new InMemoryConversationStore();
  const getStock = jest.fn().mockResolvedValue(product);
  const searchCatalog = jest
    .fn()
    .mockResolvedValue([
      product,
      { ...product, productId: otherId, name: 'Medicine 800 mg' },
    ]);
  const intakes: unknown[] = [];
  const coordinate = jest.fn(async (input: unknown) => {
    intakes.push(input);
    return { decision: 'recorded' };
  });
  const deps = {
    store,
    chatbotApi: { getStock, searchCatalog },
    cashierUserId: productId,
    humanHandoffService: { create: jest.fn() },
    restock: {
      enabled: true,
      markers: {
        readForSender: jest.fn().mockResolvedValue({
          legacyRequestPending: false,
          restockIntentPresent: false,
        }),
      },
      coordinator: { coordinate },
    },
  } as unknown as ToolDeps;
  const tools = {
    searchCatalog: makeSearchCatalogTool(deps),
    checkStock: makeCheckStockTool(deps),
    requestHumanAssistance: makeRequestHumanAssistanceTool(deps),
  };
  const steps: Step[] = [];
  const generator = jest.fn(async (invocation: Invocation) => {
    await steps.shift()!(
      (name, input) =>
        invocation.tools[name].execute(input, {
          toolCallId: 'test',
          messages: invocation.messages,
          context: invocation.toolsContext[name],
        }),
      invocation,
    );
    return { text: 'reply', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const runner = AgentRunner.forTest(
    store,
    new VercelAiLlmAgent(generator as unknown as GenerateTextFn, 'offline', 4),
    { getTools: () => tools },
    new CostGuardService(1000000),
    { systemPrompt: 'BOOT', historyTurns, idleTimeoutMs: 1000 },
  );
  return { store, runner, steps, getStock, searchCatalog, intakes, coordinate };
}
type ToolStep = Array<{
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: string;
}>;
type SdkStep = ToolStep | string;

const sdkUsage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const sdkToolStep = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolStep => [
  {
    type: 'tool-call',
    toolCallId,
    toolName,
    input: JSON.stringify(input),
  },
];

/**
 * Reuse the real InMemoryConversationStore / AgentRunner / tool factories and
 * backend client mocks, but inject the ACTUAL AI SDK (`generateText`) plus a
 * scripted MockLanguageModelV4. This exercises the genuine native tool loop
 * and the runner's real read/write path instead of manually executing tools
 * and fabricating assistant history.
 */
function sdkFixture(
  steps: SdkStep[],
  catalog: readonly unknown[],
  historyTurns = 10,
) {
  const store = new InMemoryConversationStore();
  const getStock = jest.fn().mockResolvedValue(catalog[0]);
  const searchCatalog = jest.fn().mockResolvedValue(catalog);
  const deps = {
    chatbotApi: { getStock, searchCatalog },
    cashierUserId: productId,
    humanHandoffService: { create: jest.fn() },
    restock: { enabled: false },
  } as unknown as ToolDeps;
  const tools = {
    searchCatalog: makeSearchCatalogTool(deps),
    checkStock: makeCheckStockTool(deps),
  };
  const model = new MockLanguageModelV4({
    doGenerate: steps.map((step) =>
      typeof step === 'string'
        ? {
            content: [{ type: 'text' as const, text: step }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: sdkUsage,
            warnings: [],
          }
        : {
            content: step,
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: sdkUsage,
            warnings: [],
          },
    ),
  } as never);
  const generator: GenerateTextFn = (input) =>
    generateText({ ...input, model });
  const runner = AgentRunner.forTest(
    store,
    new VercelAiLlmAgent(generator, 'offline', 4),
    { getTools: () => tools },
    new CostGuardService(1000000),
    { systemPrompt: 'BOOT', historyTurns, idleTimeoutMs: 1000 },
  );
  return { store, runner, getStock, searchCatalog, model, catalog };
}

const event = {
  senderId: 'sender',
  receivingPhoneNumberId: '12345',
  messageId: 'wamid.test',
};

describe('catalog identity through the real runner, adapter and tools', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10000);
  });
  afterEach(() => jest.useRealTimers());

  it('persists ambiguous unselected evidence and rejects forged IDs before real-search recovery', async () => {
    const f = fixture();
    f.steps.push(async (call) => {
      await call('searchCatalog', { q: 'Medicine', limit: 20 });
    });
    await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
    expect(f.getStock).not.toHaveBeenCalled();
    f.steps.push(async (call, invocation) => {
      expect(invocation.system).toBeUndefined();
      expect(invocation.instructions).toEqual([
        { role: 'system', content: 'BOOT' },
        {
          role: 'system',
          content:
            'UNSELECTED catalog evidence; stock unknown. Ask for explicit customer choice.\n' +
            JSON.stringify([
              { productId, name: product.name, variants: [] },
              { productId: otherId, name: 'Medicine 800 mg', variants: [] },
            ]),
        },
      ]);
      expect(invocation.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'system' })]),
      );
      expect(JSON.stringify(invocation.messages)).not.toContain('UNSELECTED');
      expect(
        await call('checkStock', {
          productId: '00000000-0000-4000-8000-000000000099',
        }),
      ).toMatchObject({ ok: false });
      expect(f.getStock).not.toHaveBeenCalled();
      await call('searchCatalog', { q: 'Medicine', limit: 20 });
      expect(
        await call('checkStock', { productId, name: product.name }),
      ).toMatchObject({ ok: true });
    });
    await f.runner.handle({ senderId: 'sender', text: 'The 400 mg product' });
    expect(f.getStock).toHaveBeenCalledTimes(1);
    expect((await f.store.get('sender'))!.data.messages).toHaveLength(4);
  });

  it('returns a stock-free projection while preserving raw catalog identity', async () => {
    const f = fixture();
    let observed: unknown;
    f.steps.push(async (call) => {
      observed = await call('searchCatalog', { q: 'Medicine', limit: 20 });
    });
    await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
    const envelope = observed as {
      ok?: unknown;
      requires_check_stock?: unknown;
      results?: Array<Record<string, unknown>>;
    };
    // The model never receives inventory from a search.
    expect(envelope.ok).toBe(true);
    expect(envelope.requires_check_stock).toBe(true);
    expect(envelope.results).toHaveLength(2);
    expect(envelope.results?.[0]).not.toHaveProperty('stock');
    expect(envelope.results?.[0]).toMatchObject({
      productId,
      name: product.name,
    });
    // Identity survives: the raw id still gates a real stock check next turn.
    f.steps.push(async (call) => {
      expect(await call('checkStock', { productId })).toMatchObject({
        ok: true,
      });
    });
    await f.runner.handle({ senderId: 'sender', text: 'The 400 mg one' });
    expect(f.getStock).toHaveBeenCalledTimes(1);
  });

  it('rejects hostile search context without crashing or calling the backend', async () => {
    const f = fixture();
    f.steps.push(async (call, invocation) => {
      invocation.toolsContext.searchCatalog = {
        catalogSession: new Proxy(new CatalogSession('sender', 1000, 0), {}),
      };
      expect(
        await call('searchCatalog', { q: 'Medicine', limit: 20 }),
      ).toMatchObject({ ok: false });
    });
    await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
    expect(f.searchCatalog).not.toHaveBeenCalled();
  });

  it('does not resurrect an older search after the latest search fails', async () => {
    const f = fixture();
    let completeOld!: (value: unknown) => void;
    f.searchCatalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeOld = resolve;
        }),
    );
    f.searchCatalog.mockRejectedValueOnce(new Error('latest failed'));
    f.steps.push(async (call) => {
      const old = call('searchCatalog', { q: 'old', limit: 20 });
      await expect(
        call('searchCatalog', { q: 'latest', limit: 20 }),
      ).rejects.toThrow('latest failed');
      completeOld([product]);
      await old;
      expect(await call('checkStock', { productId })).toMatchObject({
        ok: false,
      });
    });
    await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
    expect(f.getStock).not.toHaveBeenCalled();
    expect((await f.store.get('sender'))!.data.catalogReferences).toBeNull();
  });

  it('isolates customers even though tool factories are shared', async () => {
    const f = fixture();
    f.steps.push(async (call) => {
      await call('searchCatalog', { q: 'Medicine', limit: 20 });
    });
    await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
    f.steps.push(async (call) => {
      expect(await call('checkStock', { productId })).toMatchObject({
        ok: false,
      });
    });
    await f.runner.handle({ senderId: 'another', text: productId });
    expect(f.getStock).not.toHaveBeenCalled();
  });

  it.each(['truncation', 'idle', 'non-sliding expiry'])(
    'clears evidence on %s without resurrection',
    async (mode) => {
      const f = fixture(mode === 'truncation' ? 1 : 10);
      f.steps.push(async (call) => {
        await call('searchCatalog', { q: 'Medicine', limit: 20 });
      });
      await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
      if (mode === 'non-sliding expiry') {
        jest.setSystemTime(10900);
        f.steps.push(async () => {});
        await f.runner.handle({ senderId: 'sender', text: 'Thanks' });
      }
      if (mode !== 'truncation') jest.setSystemTime(11001);
      for (let i = 0; i < 2; i += 1) {
        f.steps.push(async (call, invocation) => {
          expect(JSON.stringify(invocation.messages)).not.toContain(
            'UNSELECTED',
          );
          expect(await call('checkStock', { productId })).toMatchObject({
            ok: false,
          });
        });
        await f.runner.handle({ senderId: 'sender', text: 'Check it' });
      }
      expect(f.getStock).not.toHaveBeenCalled();
      expect((await f.store.get('sender'))!.data.catalogReferences).toBeNull();
    },
  );

  it('does not undo an already-recorded intake when final history CAS loses', async () => {
    const f = fixture();
    f.steps.push(async (call) => {
      await call('searchCatalog', { q: 'Medicine', limit: 20 });
    });
    await f.runner.handle({ senderId: 'sender', text: 'Medicine' });
    f.steps.push(async (call) => {
      expect(
        await call('requestHumanAssistance', {
          kind: 'out_of_stock',
          digest: { productId, name: product.name },
        }),
      ).toEqual({
        ok: true,
        outcome: 'historical_intake_recorded',
        customerNotified: false,
      });
      const state = (await f.store.get('sender'))!;
      expect(
        await f.store.commitAgentTurn('sender', {
          expected: {
            messages: state.data.messages!,
            revision: state.data.agentRevision,
          },
          messages: [{ role: 'user', content: 'winning concurrent turn' }],
          catalogReferences: null,
          lastMessageAt: new Date().toISOString(),
        }),
      ).toBe(true);
    });
    await expect(
      f.runner.handle({
        senderId: 'sender',
        text: 'Yes, report it',
        inboundEvent: event,
      }),
    ).resolves.toEqual({ reply: 'reply' });
    expect(f.intakes).toHaveLength(1);
    expect(f.coordinate).toHaveBeenCalledTimes(1);
    expect((await f.store.get('sender'))!.data.messages).toEqual([
      { role: 'user', content: 'winning concurrent turn' },
    ]);
  });

  it('persists one immutable catalog identity across two real runner turns', async () => {
    const f = fixture();
    // ONE frozen catalog/search DTO, reused on both turns: no variant-count
    // trick between turns. This proves runner persistence only; the SDK-level
    // stock veto itself is covered in the infrastructure spec.
    const immutableCatalog = Object.freeze([
      Object.freeze({
        productId,
        name: 'Medicine 400 mg',
        variants: Object.freeze([]),
        stock: Object.freeze({ status: 'out_of_stock', quantity: 0 }),
      }),
    ]);
    f.searchCatalog.mockResolvedValue(immutableCatalog);
    f.steps.push(async (call) => {
      await call('searchCatalog', { q: 'Medicine', limit: 20 });
      expect(await call('checkStock', { productId })).toMatchObject({
        ok: true,
      });
    });
    await f.runner.handle({
      senderId: 'sender',
      text: '¿Tienen Medicine 400 mg?',
    });
    expect(
      (await f.store.get('sender'))!.data.catalogReferences,
    ).not.toBeNull();
    expect(Object.isFrozen(immutableCatalog[0])).toBe(true);

    f.steps.push(async (call, invocation) => {
      // The second turn receives the text the runner actually persisted.
      expect(invocation.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: '¿Tienen Medicine 400 mg?',
          }),
        ]),
      );
      await call('searchCatalog', { q: 'Medicine', limit: 20 });
      expect(await call('checkStock', { productId })).toMatchObject({
        ok: true,
      });
    });
    await f.runner.handle({ senderId: 'sender', text: '¿Y el precio?' });

    expect(f.searchCatalog).toHaveBeenCalledTimes(2);
    expect(await f.searchCatalog.mock.results[0].value).toBe(immutableCatalog);
    expect(await f.searchCatalog.mock.results[1].value).toBe(immutableCatalog);
    expect(f.getStock).toHaveBeenCalledTimes(2);
    expect((await f.store.get('sender'))!.data.messages).toHaveLength(4);
  });

  // S3c1 genuine native-loop integration. Native bad A -> search B -> the
  // model's OWN explicit check B, driven by the REAL generateText + a scripted
  // MockLanguageModelV4 through the real AgentRunner. The frozen DTO is reused
  // across both runs. Today the unresolved A globally vetoes the verified B
  // answer, so the persisted assistant turn is the generic fallback.
  // S3c2 MUST convert this to an ordinary passing test.
  it('grounds a verified shortage through the real runner and SDK despite a failed subject (S3c1 integration)', async () => {
    const frozenCatalog = Object.freeze([
      Object.freeze({
        productId,
        name: 'Ibuprofeno de 400 mg',
        variants: Object.freeze([]),
        stock: Object.freeze({ status: 'out_of_stock', quantity: 0 }),
      }),
    ]);
    const f = sdkFixture(
      [
        // Turn 1: bad A, fresh search B, then the model's OWN check B.
        sdkToolStep('fail', 'checkStock', { productId: otherId }),
        sdkToolStep('search', 'searchCatalog', {
          q: 'Ibuprofeno',
          limit: 20,
        }),
        sdkToolStep('check-b', 'checkStock', { productId }),
        'Déjame confirmarlo de nuevo.',
        // Turn 2 re-searches the SAME frozen DTO.
        sdkToolStep('search-2', 'searchCatalog', {
          q: 'Ibuprofeno',
          limit: 20,
        }),
        sdkToolStep('check-2', 'checkStock', { productId }),
        'Sí, sigue agotado.',
      ],
      frozenCatalog,
    );

    const first = await f.runner.handle({
      senderId: 'sender',
      text: 'Buenas tardes, ¿tienen ibuprofeno de 400 mg?',
    });

    // Real runner write: the persisted assistant turn is exactly the reply
    // the real SDK produced, never fabricated history.
    const persisted = (await f.store.get('sender'))!.data.messages;
    expect(persisted).toEqual([
      {
        role: 'user',
        content: 'Buenas tardes, ¿tienen ibuprofeno de 400 mg?',
      },
      { role: 'assistant', content: first.reply },
    ]);

    await f.runner.handle({
      senderId: 'sender',
      text: '¿Me lo confirmas de nuevo?',
    });

    // Real runner read into the real SDK: the second-turn prompt received
    // the actual persisted first-turn assistant message.
    const secondTurnPrompt = f.model.doGenerateCalls.find((entry) =>
      JSON.stringify(entry.prompt).includes('¿Me lo confirmas de nuevo?'),
    )!.prompt;
    expect(secondTurnPrompt).toEqual(
      expect.arrayContaining([
        {
          role: 'assistant',
          content: [{ type: 'text', text: first.reply }],
        },
      ]),
    );
    // ONE frozen catalog DTO reused across both runs; never mutated.
    expect(Object.isFrozen(frozenCatalog)).toBe(true);
    expect(Object.isFrozen(frozenCatalog[0])).toBe(true);
    expect(await f.searchCatalog.mock.results[0].value).toBe(frozenCatalog);
    expect(await f.searchCatalog.mock.results[1].value).toBe(frozenCatalog);
    // Executed backend arguments: identity validation let only the trusted
    // B reach the backend, once per run.
    expect(f.getStock).toHaveBeenCalledTimes(2);
    expect(f.getStock).toHaveBeenNthCalledWith(1, productId);
    expect(f.getStock).toHaveBeenNthCalledWith(2, productId);

    // DESIRED (fails today): the verified B shortage is grounded by the
    // trusted backend name instead of the current global-veto fallback.
    expect(first.reply).toBe(
      'Por el momento no tenemos existencias de Ibuprofeno de 400 mg.',
    );
  });
});
