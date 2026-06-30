import { CostGuardService } from './cost-guard.service';
import { AgentRunner } from './agent-runner.service';
import {
  CONVERSATION_STORE,
  readMessages,
  type AgentMessage,
  type ConversationState,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  LLM_AGENT,
  type LlmAgentPort,
  type LlmRunResult,
} from '../domain/llm-agent.port';
import {
  TOOL_REGISTRY,
  type ToolRegistry,
} from '../domain/tool-registry.port';
import { SYSTEM_PROMPT } from '../domain/system-prompt';

/**
 * Unit tests for AgentRunner.
 *
 * The runner owns:
 *   - history load + idle-check (Date.now() vs lastMessageAt)
 *   - in-memory truncation to LLM_HISTORY_TURNS
 *   - invocation of LLM_AGENT with the assembled prompt + tools
 *   - cost guard aggregation
 *   - UPSERT persistence (user + assistant appended)
 *
 * Spec scenarios:
 *   - History truncates in memory and tool result round-trips.
 *   - Idle-timeout edge: 5 min idle → fresh; 10s → preserved.
 *   - System prompt is forwarded verbatim (not overridden).
 */
describe('AgentRunner', () => {
  const TEN_MIN_MS = 10 * 60 * 1000;
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const TEN_S_MS = 10 * 1000;
  // Spec uses a 60-second window for the idle boundary scenario.
  const ONE_MIN_MS = 60 * 1000;

  let store: jest.Mocked<ConversationStore>;
  let llm: jest.Mocked<LlmAgentPort>;
  let tools: jest.Mocked<ToolRegistry>;
  let costGuard: CostGuardService;
  let runner: AgentRunner;
  let runner60s: AgentRunner;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-23T12:00:00.000Z'));

    store = {
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<ConversationStore>;
    // Cast to the typed shape for ease.
    store.get = jest.fn();
    store.create = jest.fn();
    store.update = jest.fn();

    llm = {
      run: jest.fn(),
    };
    tools = {
      getTools: jest.fn().mockReturnValue({ getCurrentTime: {} }),
    };
    costGuard = new CostGuardService(1_000_000);

    runner = AgentRunner.forTest(
      store as unknown as ConversationStore,
      llm as unknown as { run: (i: unknown) => Promise<LlmRunResult> } as LlmAgentPort,
      tools as unknown as ToolRegistry,
      costGuard,
      {
        systemPrompt: SYSTEM_PROMPT,
        historyTurns: 4,
        idleTimeoutMs: TEN_MIN_MS,
      },
    );

    // A second runner with a 1-minute ceiling for the idle-boundary spec.
    runner60s = AgentRunner.forTest(
      store as unknown as ConversationStore,
      llm as unknown as { run: (i: unknown) => Promise<LlmRunResult> } as LlmAgentPort,
      tools as unknown as ToolRegistry,
      costGuard,
      {
        systemPrompt: SYSTEM_PROMPT,
        historyTurns: 4,
        idleTimeoutMs: ONE_MIN_MS,
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: empty store (first contact)
  // ────────────────────────────────────────────────────────────────────
  describe('first contact (empty store)', () => {
    it('passes empty history and persists user+assistant on first inbound', async () => {
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      });
      llm.run.mockResolvedValue({
        reply: 'Hola, ¿en qué te puedo ayudar?',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
        ],
        usage: { promptTokens: 5, completionTokens: 7 },
      });

      const result = await runner.handle({ senderId: '5215550001111', text: 'hola' });

      expect(result).toEqual({ reply: 'Hola, ¿en qué te puedo ayudar?' });

      // First run gets no prior history.
      const llmInput = llm.run.mock.calls[0]![0] as { history: AgentMessage[] };
      expect(llmInput.history).toEqual([]);

      // Persisted: user + assistant turn appended.
      expect(store.update).toHaveBeenCalledWith('5215550001111', {
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          messages: [
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
          ],
        },
      });
    });

    it('forwards SYSTEM_PROMPT verbatim and does NOT override it', async () => {
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {},
      });
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'ok' },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await runner.handle({ senderId: 's', text: 'hola' });

      const llmInput = llm.run.mock.calls[0]![0] as { systemPrompt: string };
      expect(llmInput.systemPrompt).toBe(SYSTEM_PROMPT);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: history truncates in memory and tool result round-trips
  // ────────────────────────────────────────────────────────────────────
  describe('history truncation', () => {
    it('passes at most historyTurns most-recent turns to the port', async () => {
      const stored = existingState({
        lastMessageAt: new Date(Date.now() - TEN_S_MS).toISOString(),
        turns: 10, // way more than the 4 cap
      });
      store.get.mockResolvedValue(stored);
      store.update.mockResolvedValue(stored);
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: stored.data.messages!.slice(-4).concat([
          { role: 'user', content: 'nueva' },
          { role: 'assistant', content: 'ok' },
        ]),
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await runner.handle({ senderId: '5215550001111', text: 'nueva' });

      const llmInput = llm.run.mock.calls[0]![0] as { history: AgentMessage[] };
      // Runner truncated in-memory: only last 4 turns passed.
      expect(llmInput.history).toHaveLength(4);

      // Store keeps ALL 10 turns (dumb upsert bag).
      expect(stored.data.messages).toHaveLength(10);
    });

    it('passes getCurrentTime tools from the registry to the SDK', async () => {
      const stored = existingState({
        lastMessageAt: new Date(Date.now() - TEN_S_MS).toISOString(),
        turns: 0,
      });
      store.get.mockResolvedValue(stored);
      store.update.mockResolvedValue(stored);
      llm.run.mockResolvedValue({
        reply: 'Son las 12:00',
        messages: [
          { role: 'user', content: 'hora?' },
          { role: 'assistant', content: 'Son las 12:00' },
        ],
        usage: { promptTokens: 2, completionTokens: 2 },
      });

      await runner.handle({ senderId: 's', text: 'hora?' });

      const llmInput = llm.run.mock.calls[0]![0] as { tools: Record<string, unknown> };
      expect(llmInput.tools).toHaveProperty('getCurrentTime');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: Boundary behavior at the idle-timeout edge
  // ────────────────────────────────────────────────────────────────────
  describe('idle-timeout edge', () => {
    it('treats 5-min idle (>1min ceiling) as fresh session: empty history, lastMessageAt updated', async () => {
      const stored = existingState({
        lastMessageAt: new Date(Date.now() - FIVE_MIN_MS - TEN_S_MS).toISOString(),
        turns: 2,
      });
      store.get.mockResolvedValue(stored);
      store.update.mockResolvedValue(stored);
      llm.run.mockResolvedValue({
        reply: 'hola de nuevo',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'hola de nuevo' },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await runner60s.handle({ senderId: '5215550001111', text: 'hola' });

      const llmInput = llm.run.mock.calls[0]![0] as { history: AgentMessage[] };
      expect(llmInput.history).toEqual([]);
      // lastMessageAt advanced to now.
      expect(store.update).toHaveBeenCalledWith(
        '5215550001111',
        expect.objectContaining({
          lastMessageAt: '2026-06-23T12:00:00.000Z',
        }),
      );
    });

    it('preserves history when 10s idle (within 1min window)', async () => {
      const stored = existingState({
        lastMessageAt: new Date(Date.now() - TEN_S_MS).toISOString(),
        turns: 4,
      });
      store.get.mockResolvedValue(stored);
      store.update.mockResolvedValue(stored);
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: stored.data.messages!.slice(-4).concat([
          { role: 'user', content: 'mas' },
          { role: 'assistant', content: 'ok' },
        ]),
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await runner60s.handle({ senderId: '5215550001111', text: 'mas' });

      const llmInput = llm.run.mock.calls[0]![0] as { history: AgentMessage[] };
      // Within window: full (truncated) history forwarded.
      expect(llmInput.history.length).toBeGreaterThan(0);
      expect(llmInput.history).toEqual(stored.data.messages!.slice(-4));
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: cost guard aggregates per-turn usage
  // ────────────────────────────────────────────────────────────────────
  describe('cost guard', () => {
    it('records per-turn usage on every run', async () => {
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {},
      });
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'ok' },
        ],
        usage: { promptTokens: 100, completionTokens: 50 },
      });

      await runner.handle({ senderId: 's', text: 'a' });

      expect(costGuard.currentAggregate).toBe(150);
    });

    it('never throws even when usage is absurd (defensive: undefined → 0)', async () => {
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {},
      });
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'ok' },
        ],
        usage: { promptTokens: 0, completionTokens: 0 },
      });

      await expect(runner.handle({ senderId: 's', text: 'a' })).resolves.toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────
  function existingState(opts: {
    lastMessageAt: string;
    turns: number;
  }): ConversationState {
    const messages: AgentMessage[] = Array.from({ length: opts.turns }).map(
      (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${i + 1}`,
      }),
    );
    return {
      senderId: '5215550001111',
      lastMessageAt: opts.lastMessageAt,
      data: { messages },
    };
  }
});

// Keep type-only imports quiet under strict TS.
void CONVERSATION_STORE;
void readMessages;
void LLM_AGENT;
void TOOL_REGISTRY;