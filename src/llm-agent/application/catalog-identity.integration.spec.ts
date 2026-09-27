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
  system: string;
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
      expect(invocation.system).toBe('BOOT');
      expect(JSON.stringify(invocation.messages)).toContain('UNSELECTED');
      expect(JSON.stringify(invocation.messages)).toContain('stock unknown');
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
});
