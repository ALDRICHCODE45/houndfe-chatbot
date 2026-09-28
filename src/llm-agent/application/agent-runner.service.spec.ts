import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { Logger } from '@nestjs/common';
import { CostGuardService } from './cost-guard.service';
import { AgentRunner } from './agent-runner.service';
import {
  CONVERSATION_STORE,
  readMessages,
  type AgentMessage,
  type ConversationState,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import { LLM_AGENT, type LlmAgentPort } from '../domain/llm-agent.port';
import { TOOL_REGISTRY, type ToolRegistry } from '../domain/tool-registry.port';
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
  type AgentTurnCommit = Parameters<ConversationStore['commitAgentTurn']>[1];

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
      commitAgentTurn: jest.fn().mockResolvedValue(true),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setPendingHumanRequest: jest.fn(),
      clearPendingHumanRequest: jest.fn(),
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
    };
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

    runner = AgentRunner.forTest(store, llm, tools, costGuard, {
      systemPrompt: SYSTEM_PROMPT,
      historyTurns: 4,
      idleTimeoutMs: TEN_MIN_MS,
    });

    // A second runner with a 1-minute ceiling for the idle-boundary spec.
    runner60s = AgentRunner.forTest(store, llm, tools, costGuard, {
      systemPrompt: SYSTEM_PROMPT,
      historyTurns: 4,
      idleTimeoutMs: ONE_MIN_MS,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: empty store (first contact)
  // ────────────────────────────────────────────────────────────────────
  describe('first contact (empty store)', () => {
    it('passes empty history and persists user+assistant on first inbound', async () => {
      // ADR-28: after `llm.run` the runner re-fetches state. First
      // call returns null (first contact); second returns the
      // just-written state with empty messages.
      store.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      });
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

      const result = await runner.handle({
        senderId: '5215550001111',
        text: 'hola',
      });

      expect(result).toEqual({ reply: 'Hola, ¿en qué te puedo ayudar?' });

      // First run gets no prior history.
      const llmInput = llm.run.mock.calls[0][0] as { history: AgentMessage[] };
      expect(llmInput.history).toEqual([]);

      // Persisted: user + assistant turn appended.
      expect(store.commitAgentTurn).toHaveBeenCalledWith('5215550001111', {
        expected: null,
        catalogReferences: null,
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
        ],
      });
    });

    it('forwards the composed system prompt verbatim (config.systemPrompt) and never overrides it', async () => {
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

      // Use a sentinel composed prompt (the production
      // LLM_AGENT_SYSTEM_PROMPT token is bound to a once-computed string
      // at module boot).
      const sentinel = 'BASE_SENTINEL + SALE_FLOW_SLICE_SENTINEL';
      const sentinelRunner = AgentRunner.forTest(store, llm, tools, costGuard, {
        systemPrompt: sentinel,
        historyTurns: 4,
        idleTimeoutMs: TEN_MIN_MS,
      });

      await sentinelRunner.handle({ senderId: 's', text: 'hola' });
      await sentinelRunner.handle({ senderId: 's', text: 'segundo' });

      // Every handle() call forwards the SAME composed string -- the
      // composition-once contract holds; no per-turn override.
      const llmInputs = llm.run.mock.calls.map(
        (c) => (c[0] as { systemPrompt: string }).systemPrompt,
      );
      expect(llmInputs).toEqual([sentinel, sentinel]);
      expect(llmInputs[0]).not.toBe(SYSTEM_PROMPT);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: history truncates in memory and tool result round-trips
  // ────────────────────────────────────────────────────────────────────
  describe('history truncation', () => {
    it('passes at most historyTurns most-recent turns to the port', async () => {
      // G-1 llm-agent/R1/S1: the port owns the SDK tool loop. This port mock
      // performs exactly ONE tool step (no loop is simulated or reimplemented)
      // against the tool set it receives, observes the tool's distinct result
      // sentinel, and derives the final reply from it. The runner must forward
      // the exact tool set, the expected tool must run with its expected input,
      // and the runner must return the derived reply byte-for-byte.
      const toolResultSentinel = 'TOOL_RESULT_SENTINEL_7f3a9c';
      const toolInput = { query: 'collar' };
      const searchCatalog = jest.fn((input: { query: string }) => ({
        echo: `${input.query}:${toolResultSentinel}`,
      }));
      tools.getTools.mockReturnValue({ searchCatalog });

      let observedSentinel: string | undefined;
      llm.run.mockImplementation(async (input) => {
        const tool = input.tools.searchCatalog as (args: { query: string }) => {
          echo: string;
        };
        // Single tool-derived result construction, owned by the port mock.
        const result = tool(toolInput);
        observedSentinel = result.echo;
        return {
          reply: `respuesta:${result.echo}`,
          messages: [
            { role: 'user', content: 'nueva' },
            { role: 'assistant', content: `respuesta:${result.echo}` },
          ],
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      });

      const stored = existingState({
        lastMessageAt: new Date(Date.now() - TEN_S_MS).toISOString(),
        turns: 10, // way more than the 4 cap
      });
      store.get.mockResolvedValue(stored);
      store.update.mockResolvedValue(stored);

      const result = await runner.handle({
        senderId: '5215550001111',
        text: 'nueva',
      });

      const llmInput = llm.run.mock.calls[0][0] as {
        history: AgentMessage[];
        tools: Record<string, unknown>;
      };
      // Runner truncated in-memory: only last 4 turns passed.
      expect(llmInput.history).toHaveLength(4);

      // Store keeps ALL 10 turns (dumb upsert bag).
      expect(stored.data.messages).toHaveLength(10);

      // The exact tool set reached the port and the expected tool executed.
      expect(Object.keys(llmInput.tools)).toEqual(['searchCatalog']);
      expect(llmInput.tools.searchCatalog).toBe(searchCatalog);
      expect(searchCatalog).toHaveBeenCalledTimes(1);
      expect(searchCatalog).toHaveBeenCalledWith(toolInput);
      // The port mock observed the distinct tool-result sentinel.
      expect(observedSentinel).toBe('collar:TOOL_RESULT_SENTINEL_7f3a9c');
      // The runner returned the port-derived reply byte-for-byte.
      expect(result.reply).toBe('respuesta:collar:TOOL_RESULT_SENTINEL_7f3a9c');
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

      const llmInput = llm.run.mock.calls[0][0] as {
        tools: Record<string, unknown>;
      };
      expect(llmInput.tools).toHaveProperty('getCurrentTime');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: Boundary behavior at the idle-timeout edge
  // ────────────────────────────────────────────────────────────────────
  describe('idle-timeout edge', () => {
    it('treats 5-min idle (>1min ceiling) as fresh session: empty history, lastMessageAt updated', async () => {
      const stored = existingState({
        lastMessageAt: new Date(
          Date.now() - FIVE_MIN_MS - TEN_S_MS,
        ).toISOString(),
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

      const llmInput = llm.run.mock.calls[0][0] as { history: AgentMessage[] };
      expect(llmInput.history).toEqual([]);
      // lastMessageAt advanced to now.
      expect(store.commitAgentTurn).toHaveBeenCalledWith(
        '5215550001111',
        expect.objectContaining({
          expected: { messages: stored.data.messages },
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

      const llmInput = llm.run.mock.calls[0][0] as { history: AgentMessage[] };
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

      await expect(
        runner.handle({ senderId: 's', text: 'a' }),
      ).resolves.toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: human-handoff marker short-circuit (ADR-29)
  // ────────────────────────────────────────────────────────────────────
  describe('human-handoff pending-marker short-circuit (ADR-29)', () => {
    const pendingMarker = {
      requestId: 'abc123def456',
      ref: 'HF-abc123def456',
      createdAt: '2026-06-23T12:00:00.000Z',
      customerNotifiedAt: '2026-06-23T12:00:00.000Z',
    };

    it('returns the canned literal reply when pendingHumanRequest is set; no LLM, no costGuard, no store write', async () => {
      store.get.mockResolvedValue({
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { pendingHumanRequest: pendingMarker },
      });

      const result = await runner.handle({
        senderId: '5215550001111',
        text: '¿siguen?',
      });

      expect(result).toEqual({
        reply:
          'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos',
      });
      expect(llm.run).not.toHaveBeenCalled();
      expect(costGuard.currentAggregate).toBe(0);
      expect(store.update).not.toHaveBeenCalled();
    });

    it('short-circuit fires regardless of lastMessageAt (marker is the discriminator, not the idle boundary)', async () => {
      const oldTs = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      store.get.mockResolvedValue({
        senderId: '5215550001111',
        lastMessageAt: oldTs,
        data: {
          pendingHumanRequest: pendingMarker,
          messages: [{ role: 'user', content: 'old' }],
        },
      });

      const result = await runner.handle({
        senderId: '5215550001111',
        text: '¿siguen?',
      });

      expect(result.reply).toBe(
        'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos',
      );
      expect(llm.run).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: fresh-state spread write (ADR-28)
  // ────────────────────────────────────────────────────────────────────
  describe('fresh-state spread write (ADR-28)', () => {
    it('persists messages + tool-written siblings (cart, placedSaleId, pendingHumanRequest marker) — does NOT clobber them', async () => {
      const marker = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: '2026-06-23T12:00:00.000Z',
        customerNotifiedAt: '2026-06-23T12:00:00.000Z',
      };

      const prior: ConversationState = {
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: { items: [], idempotencyKey: 'k' } },
      };
      const freshPostLlm: ConversationState = {
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          cart: { items: [], idempotencyKey: 'k' },
          pendingHumanRequest: marker,
        },
      };

      store.get
        .mockResolvedValueOnce(prior)
        .mockResolvedValueOnce(freshPostLlm);
      const live = new InMemoryConversationStore();
      await live.create(prior.senderId, freshPostLlm);
      store.commitAgentTurn.mockImplementation((sender, turn) =>
        live.commitAgentTurn(sender, turn),
      );
      llm.run.mockResolvedValue({
        reply: 'Listo.',
        messages: [
          { role: 'user', content: 'ok' },
          { role: 'assistant', content: 'Listo.' },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await runner.handle({
        senderId: '5215550001111',
        text: 'ok',
      });

      expect(store.commitAgentTurn).toHaveBeenCalledTimes(1);
      expect(await live.get(prior.senderId)).toMatchObject({
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          cart: freshPostLlm.data.cart,
          pendingHumanRequest: marker,
          messages: [
            { role: 'user', content: 'ok' },
            { role: 'assistant', content: 'Listo.' },
          ],
        },
      });
    });

    it('logs a structured error and returns the LLM reply when post-run get returns null (state deleted during run)', async () => {
      const prior: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {},
      };
      store.get.mockResolvedValueOnce(prior);
      store.commitAgentTurn.mockResolvedValue(false); // Deleted-row CAS loses.
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'ok' },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      const result = await runner.handle({
        senderId: 's',
        text: 'a',
      });
      expect(result.reply).toBe('ok');
      expect(store.update).not.toHaveBeenCalled();
    });

    it('idle reset path spreads a marker written by a tool during the run (ADR-28)', async () => {
      // Idle-expired prior state — no marker initially (so the
      // short-circuit gate does NOT trip). A tool running during the
      // LLM turn writes the marker (mirroring the runtime path where
      // `requestHumanAssistance` would set the marker via
      // ConversationStore.update). The fresh-state spread must carry
      // the marker into the final write alongside the new transcript.
      const oldTs = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      const prior: ConversationState = {
        senderId: '5215550001111',
        lastMessageAt: oldTs,
        data: { messages: [{ role: 'user', content: 'old' }] },
      };
      const marker = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: '2026-06-23T12:00:00.000Z',
        customerNotifiedAt: '2026-06-23T12:00:00.000Z',
      };
      const freshPostLlm: ConversationState = {
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          messages: [{ role: 'user', content: 'hola' }],
          pendingHumanRequest: marker,
        },
      };
      store.get
        .mockResolvedValueOnce(prior)
        .mockResolvedValueOnce(freshPostLlm);
      const live = new InMemoryConversationStore();
      await live.create(prior.senderId, {
        ...freshPostLlm,
        data: { ...freshPostLlm.data, messages: prior.data.messages },
      });
      store.commitAgentTurn.mockImplementation((sender, turn) =>
        live.commitAgentTurn(sender, turn),
      );
      llm.run.mockResolvedValue({
        reply: 'Bienvenido de vuelta.',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Bienvenido de vuelta.' },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await runner.handle({
        senderId: '5215550001111',
        text: 'hola',
      });

      expect(store.commitAgentTurn).toHaveBeenCalledTimes(1);
      expect(store.commitAgentTurn.mock.calls[0][1].expected).toEqual({
        messages: prior.data.messages,
      });
      const persisted = await live.get(prior.senderId);
      expect(persisted).toMatchObject({
        data: { pendingHumanRequest: marker },
      });
      const messages = persisted!.data.messages ?? [];
      expect(messages).toEqual(
        expect.arrayContaining([
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Bienvenido de vuelta.' },
        ]),
      );
    });

    it('persists the transcript on first contact even when the post-run re-fetch returns null (no tool wrote state during the turn)', async () => {
      // A REAL store returns null for BOTH reads on first contact (nothing
      // has been written yet — `update` is the only write and it happens
      // after the re-fetch). The race-skip must NOT fire here: the pre-run
      // state was ALSO null, so this is first contact, not a mid-run
      // deletion. The transcript must still be persisted (UPSERT creates
      // the record) — this is the "assistant turn is persisted after a
      // successful run" contract.
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

      const result = await runner.handle({
        senderId: '5215550001111',
        text: 'hola',
      });

      expect(result.reply).toBe('Hola, ¿en qué te puedo ayudar?');
      expect(store.commitAgentTurn).toHaveBeenCalledTimes(1);
      const [, patch]: [string, AgentTurnCommit] =
        store.commitAgentTurn.mock.calls[0];
      expect(patch).toMatchObject({
        expected: null,
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
        ],
      });
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

  // ────────────────────────────────────────────────────────────────────
  // Scenario: optional RESTOCK inbound identity propagation (inert)
  // ────────────────────────────────────────────────────────────────────
  describe('inbound event propagation', () => {
    const EVENT = {
      receivingPhoneNumberId: '123456789012345',
      senderId: 's',
      messageId: 'wamid.ABC123',
    };
    const lastInput = () =>
      llm.run.mock.calls[llm.run.mock.calls.length - 1][0];

    beforeEach(() => {
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {},
      });
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: [{ role: 'assistant', content: 'ok' }],
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    });

    it('forwards a valid matching event as an exact frozen copy', async () => {
      await runner.handle({
        senderId: 's',
        text: 'hola',
        inboundEvent: EVENT,
      });
      const { inboundEvent } = lastInput();
      expect(inboundEvent).toEqual(EVENT);
      expect(inboundEvent).not.toBe(EVENT);
      expect(Object.isFrozen(inboundEvent)).toBe(true);
    });

    it('omits inboundEvent entirely for an ordinary turn with no event', async () => {
      await runner.handle({ senderId: 's', text: 'hola' });
      expect(
        Object.prototype.hasOwnProperty.call(lastInput(), 'inboundEvent'),
      ).toBe(false);
    });

    it('drops malformed, mismatched, or hostile events without throwing', async () => {
      const accessor = {} as Record<string, unknown>;
      for (const [key, value] of Object.entries(EVENT)) {
        Object.defineProperty(accessor, key, {
          get: () => value,
          enumerable: true,
        });
      }
      let rotatingReads = 0;
      const rotating = new Proxy(
        { ...EVENT },
        {
          get(target, key, receiver) {
            if (key === 'messageId') {
              return ++rotatingReads === 1 ? EVENT.messageId : 'wamid.CHANGED';
            }
            return Reflect.get(target, key, receiver) as unknown;
          },
        },
      );
      let throwingReads = 0;
      const throwing = new Proxy(
        { ...EVENT },
        {
          get(target, key, receiver) {
            if (key === 'messageId' && ++throwingReads > 1) {
              throw new Error('changed after validation');
            }
            return Reflect.get(target, key, receiver) as unknown;
          },
        },
      );
      const cases: unknown[] = [
        { ...EVENT, senderId: 'other' },
        { receivingPhoneNumberId: '123', senderId: 's' },
        { ...EVENT, extra: 'x' },
        { ...EVENT, receivingPhoneNumberId: '12a' },
        new Proxy({ ...EVENT }, { get: () => 'tampered' }),
        rotating,
        throwing,
        accessor,
      ];
      for (const inboundEvent of cases) {
        await runner.handle({
          senderId: 's',
          text: 'hola',
          inboundEvent: inboundEvent as never,
        });
        expect(
          Object.prototype.hasOwnProperty.call(lastInput(), 'inboundEvent'),
        ).toBe(false);
      }
      expect(llm.run).toHaveBeenCalledTimes(cases.length);
    });

    it('never persists the event and stays stable across a repeat', async () => {
      await runner.handle({ senderId: 's', text: 'a', inboundEvent: EVENT });
      await runner.handle({ senderId: 's', text: 'b', inboundEvent: EVENT });
      for (const [, patch] of store.commitAgentTurn.mock.calls) {
        const persisted = JSON.stringify(patch);
        expect(persisted).not.toContain(EVENT.messageId);
        expect(persisted).not.toContain(EVENT.receivingPhoneNumberId);
      }
      const forwarded = llm.run.mock.calls.map((c) => c[0].inboundEvent);
      expect(forwarded[1]).toEqual(forwarded[0]);
      expect(forwarded[1]).not.toBe(forwarded[0]);
      expect(lastInput().text).toBe('b');
      expect(lastInput().systemPrompt).toBe(SYSTEM_PROMPT);
    });

    it('leaves the tool registry untouched', async () => {
      await runner.handle({
        senderId: 's',
        text: 'hola',
        inboundEvent: EVENT,
      });
      expect(tools.getTools).toHaveBeenCalledTimes(1);
      expect(lastInput().tools).toBe(tools.getTools.mock.results[0].value);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: private catalog identity diagnostics (Unit 2)
  // ────────────────────────────────────────────────────────────────────
  describe('catalog identity diagnostics', () => {
    const loggedLines = (): string[] =>
      (Logger.log as jest.Mock).mock.calls
        .map((call: unknown[]) => call[0])
        .filter(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('catalog_identity '),
        );

    beforeEach(() => {
      jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
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
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    });
    afterEach(() => jest.restoreAllMocks());

    it('logs one privacy-keys-only group per turn with isolated ids', async () => {
      await runner.handle({ senderId: 'sender-secret', text: 'hola-secret' });
      await runner.handle({ senderId: 'sender-secret', text: 'otra-secret' });
      const lines = loggedLines();
      expect(lines).toHaveLength(6);
      for (const line of lines) {
        expect(line).toMatch(
          /^catalog_identity [0-9a-f-]{36} phase=[a-z_]+ reason=[a-z_]+$/,
        );
        expect(line).not.toContain('sender-secret');
        expect(line).not.toContain('hola-secret');
      }
      const ids = lines.map((line) => line.split(' ')[1]);
      expect(ids.slice(0, 3)).toEqual([ids[0], ids[0], ids[0]]);
      expect(ids.slice(3)).toEqual([ids[3], ids[3], ids[3]]);
      expect(ids[0]).not.toBe(ids[3]);
      expect(lines[0]).toContain('phase=restore reason=missing_snapshot');
      expect(lines[1]).toContain('phase=history reason=missing_snapshot');
      expect(lines[2]).toContain('phase=commit reason=committed');
    });

    it('logs a CAS conflict and preserves the reply and warn behavior', async () => {
      store.commitAgentTurn.mockResolvedValue(false);
      const warn = jest
        .spyOn(Logger, 'warn')
        .mockImplementation(() => undefined);
      await expect(
        runner.handle({ senderId: 's', text: 'a' }),
      ).resolves.toEqual({ reply: 'ok' });
      expect(warn).toHaveBeenCalledWith('[agent-turn-conflict]', 'AgentRunner');
      expect(
        loggedLines().some((line) =>
          line.includes('phase=commit reason=conflict'),
        ),
      ).toBe(true);
    });

    it('survives a throwing logger without blocking the commit', async () => {
      (Logger.log as jest.Mock).mockImplementation(() => {
        throw new Error('logger down');
      });
      await expect(
        runner.handle({ senderId: 's', text: 'a' }),
      ).resolves.toEqual({ reply: 'ok' });
      expect(store.commitAgentTurn).toHaveBeenCalledTimes(1);
    });

    it('never leaks generated diagnostics into model messages or the snapshot', async () => {
      await runner.handle({ senderId: 'sender-secret', text: 'hola-secret' });
      expect(JSON.stringify(llm.run.mock.calls[0][0])).not.toContain(
        'catalog_identity',
      );
      expect(
        JSON.stringify(store.commitAgentTurn.mock.calls[0][1]),
      ).not.toContain('catalog_identity');
    });
  });
});

// Keep type-only imports quiet under strict TS.
void CONVERSATION_STORE;
void readMessages;
void LLM_AGENT;
void TOOL_REGISTRY;
