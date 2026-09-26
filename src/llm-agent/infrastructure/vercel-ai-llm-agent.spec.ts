import { Logger } from '@nestjs/common';
import { stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { LlmRunInput } from '../domain/llm-agent.port';
import { SYSTEM_PROMPT } from '../domain/system-prompt';
import { GENERATE_TEXT, type GenerateTextFn } from './generate-text.provider';
import { VercelAiLlmAgent } from './vercel-ai-llm-agent';

/**
 * Unit tests for VercelAiLlmAgent.
 *
 * Critical: the `usage` map from the SDK's `inputTokens/outputTokens`
 * to the port's `promptTokens/completionTokens` MUST default
 * `undefined` fields to `0`. The cost guard sums these values; an
 * `undefined` would propagate to NaN and silently defeat the
 * 80%/100% threshold scenarios. This file's undefined-usage test
 * is the gate-fix for that failure mode.
 */
describe('temporary catalog diagnostics', () => {
  const secret = 'PRIVATE_SENTINEL';
  const input: LlmRunInput = {
    senderId: secret,
    text: secret,
    systemPrompt: secret,
    history: [{ role: 'user', content: secret }],
    tools: {},
    inboundEvent: {
      senderId: secret,
      messageId: secret,
      receivingPhoneNumberId: secret,
    },
  };
  type Hooks = {
    onStepFinish: (event: unknown) => void;
    onToolExecutionEnd: (event: unknown) => void;
  };
  let log: jest.SpyInstance;
  const records = () =>
    log.mock.calls.map(([record]) => record as Record<string, unknown>);
  const step = (hooks: Hooks, count = 0) =>
    hooks.onStepFinish?.({
      toolCalls: Array(count).fill(secret),
      text: secret,
      request: { headers: secret, apiKey: secret },
      response: { id: secret, body: secret },
      providerMetadata: { private: secret },
    });
  const end = (hooks: Hooks, output: unknown, name = 'searchCatalog') =>
    hooks.onToolExecutionEnd?.({
      callId: secret,
      toolExecutionMs: 1,
      messages: [secret],
      toolContext: { headers: secret, cookies: secret },
      toolCall: { toolName: name, toolCallId: secret, input: secret },
      toolOutput: output,
    });
  const generate = jest.fn();
  const agent = new VercelAiLlmAgent(generate, 'test', 3);
  const run = (act: (hooks: Hooks) => void | Promise<void>) => {
    generate.mockImplementationOnce(async (options: unknown) => {
      await act(options as Hooks);
      return { text: secret, usage: { inputTokens: 2, outputTokens: 3 } };
    });
    return agent.run(input);
  };
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    // Inspect every argument, not just the structured message.
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });

  it('records an observed text-only completion without changing the reply/history', async () => {
    const result = await run((hooks) => step(hooks));
    expect(result).toEqual({
      reply: secret,
      messages: [
        ...input.history,
        { role: 'user', content: secret },
        { role: 'assistant', content: secret },
      ],
      usage: { promptTokens: 2, completionTokens: 3 },
    });
    expect(records()).toHaveLength(1);
    expect(records()[0].runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(records()[0]).toEqual({
      prefix: 'catalog_diagnostic',
      runId: records()[0].runId,
      event: 'run_completed',
      observedSteps: 1,
      toolCalls: 0,
      observationComplete: true,
    });
  });

  const product = { name: secret, productId: secret, stock: { quantity: 0 } };
  const outputOf = (output: unknown) => ({ type: 'tool-result', output });
  it.each([
    [outputOf({ ok: true, results: [] }), 'success', 0],
    [outputOf({ ok: true, results: [product] }), 'success', 1],
    [outputOf({ ok: false, error: secret }), 'mapped_error', undefined],
    [{ type: 'tool-error', error: secret }, 'execution_error', undefined],
    [outputOf({ ok: true, results: secret }), 'unknown_output', undefined],
    [outputOf(null), 'unknown_output', undefined],
    [{ type: secret }, 'unknown_output', undefined],
  ])('classifies output %s', async (output, category, resultCount) => {
    await run((hooks) => {
      end(hooks, output);
      step(hooks, 1);
      step(hooks);
    });
    expect(records()[0]).toEqual({
      prefix: 'catalog_diagnostic',
      runId: records()[1].runId,
      event: 'search_catalog_end',
      category,
      ...(resultCount === undefined ? {} : { resultCount }),
    });
    expect(records()[1]).toMatchObject({
      observedSteps: 2,
      toolCalls: category === 'unknown_output' ? null : 1,
      observationComplete: category !== 'unknown_output',
    });
  });

  it('ignores arbitrary tools and never traverses catalog array items', async () => {
    const results = new Array(2);
    const getter = jest.fn(() => {
      throw new Error(secret);
    });
    Object.defineProperty(results, 0, { get: getter });
    await run((hooks) => {
      end(hooks, new Proxy({}, { get: getter }), secret);
      end(hooks, { type: 'tool-result', output: { ok: true, results } });
      step(hooks, 2);
    });
    expect(getter).not.toHaveBeenCalled();
    expect(records()).toHaveLength(2);
    expect(records()[0]).toMatchObject({ category: 'success', resultCount: 2 });
    expect(records()[1]).toMatchObject({
      toolCalls: 2,
      observationComplete: true,
    });
  });

  it.each(['missing', 'step', 'tool', 'length', 'output'])(
    'marks %s observation incomplete without changing output',
    async (kind) => {
      const hostile = new Proxy([], {
        get() {
          throw new Error(secret);
        },
      });
      await expect(
        run((hooks) => {
          if (kind === 'step') hooks.onStepFinish?.({ toolCalls: null });
          if (kind === 'tool') hooks.onToolExecutionEnd?.(null);
          if (kind === 'length') hooks.onStepFinish?.({ toolCalls: hostile });
          if (kind === 'output') end(hooks, hostile);
        }),
      ).resolves.toMatchObject({ reply: secret });
      expect(records().at(-1)).toMatchObject({
        event: 'run_completed',
        toolCalls: null,
        observationComplete: false,
      });
    },
  );

  it('preserves the identical SDK exception and never asserts zero calls on failure', async () => {
    const error = new Error(secret);
    await expect(
      run((hooks) => {
        step(hooks);
        throw error;
      }),
    ).rejects.toBe(error);
    expect(records().at(-1)).toMatchObject({
      event: 'run_failed',
      observedSteps: 1,
      toolCalls: null,
      observationComplete: false,
    });
  });

  it('isolates interleaved runs with distinct random UUIDs and counters', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(async (hooks) => {
      end(hooks, { type: 'tool-result', output: { ok: true, results: [] } });
      step(hooks, 1);
      await gate;
      step(hooks);
    });
    await run((hooks) => step(hooks));
    release();
    await first;
    const [search, second, completedFirst] = records();
    expect(search.runId).toBe(completedFirst.runId);
    expect(second.runId).not.toBe(search.runId);
    expect(second).toMatchObject({ observedSteps: 1, toolCalls: 0 });
    expect(completedFirst).toMatchObject({ observedSteps: 2, toolCalls: 1 });
  });

  it('contains logger failures on both successful and rejected generation', async () => {
    log.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    await expect(
      run((hooks) => {
        end(hooks, { type: 'tool-error', error: secret });
        step(hooks);
      }),
    ).resolves.toMatchObject({ reply: secret });
    expect(records().at(-1)).toMatchObject({ observationComplete: false });
    log.mockImplementation(() => {
      throw new Error(secret);
    });
    await expect(run((hooks) => step(hooks))).resolves.toMatchObject({
      reply: secret,
    });
    const error = new Error(secret);
    await expect(
      run(() => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe('VercelAiLlmAgent', () => {
  let generateTextFn: jest.MockedFunction<GenerateTextFn>;
  let agent: VercelAiLlmAgent;

  beforeEach(() => {
    generateTextFn = jest.fn();
    agent = new VercelAiLlmAgent(
      generateTextFn,
      'anthropic/claude-sonnet-4.5',
      3,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Scenario: Adapter returns usage and forwards the step cap
  // ────────────────────────────────────────────────────────────────────
  describe('run (happy path)', () => {
    it('forwards toolsContext with { senderId: input.senderId } for the cart-touching tools', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'Hola',
        usage: { inputTokens: 10, outputTokens: 5 },
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      await agent.run({
        senderId: '5215550001111',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {
          evaluateCart: {
            description: 'e',
            inputSchema: {},
            execute: () => {},
          },
          createSale: { description: 's', inputSchema: {}, execute: () => {} },
        },
      });

      const callArgs = generateTextFn.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      // toolsContext is a per-tool map keyed by tool name. Every tool
      // that declares `contextSchema: z.object({ senderId })` MUST have
      // its own entry here — the SDK scopes `execute`'s `options.context`
      // to the matching tool name. The map is sparse: stateless tools
      // are omitted.
      expect(callArgs.toolsContext).toEqual({
        evaluateCart: { senderId: '5215550001111' },
        createSale: { senderId: '5215550001111' },
        cancelSale: { senderId: '5215550001111' },
        // Human-handoff slice: 12th tool needs senderId context too.
        requestHumanAssistance: { senderId: '5215550001111' },
      });
    });

    it('forwards the configured stopWhen: stepCountIs(MAX_STEPS)', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'Hola',
        // The mock returns whatever we set; the adapter maps to its port shape.
        usage: { inputTokens: 10, outputTokens: 5 },
        // generateTextResult returns many more fields; the adapter only reads text/usage.
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      await agent.run({
        senderId: 's',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
      });

      expect(generateTextFn).toHaveBeenCalledTimes(1);
      const callArgs = generateTextFn.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      // stopWhen forwarding is the critical cap (runaway loop guard).
      // stepCountIs(N) returns a fresh closure each call, so we assert
      // shape (function) and behavioural equivalence via the SDK helper.
      const stopWhen = callArgs.stopWhen as {
        (s: { steps: unknown[] }): boolean;
      };
      expect(typeof stopWhen).toBe('function');
      const reference = stepCountIs(3) as (s: { steps: unknown[] }) => boolean;
      // Same step count and same trigger result for empty steps.
      expect(stopWhen({ steps: [] })).toBe(reference({ steps: [] }));
      // After 3 steps, the reference returns true; ours must too.
      const fakeSteps = [{}, {}, {}];
      expect(stopWhen({ steps: fakeSteps })).toBe(true);
    });

    it('forwards model via openai(MODEL), system, messages, and tools', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'Hola',
        usage: { inputTokens: 10, outputTokens: 5 },
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      await agent.run({
        senderId: 's',
        text: 'hola',
        history: [{ role: 'user', content: 'hola' }],
        systemPrompt: SYSTEM_PROMPT,
        tools: { getCurrentTime: { description: 't' } },
      });

      const callArgs = generateTextFn.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      // Model forwarded via the openai provider (assert modelId, since
      // openai() returns a fresh LanguageModelV4 reference each call).
      const model = callArgs.model as { modelId?: string; provider?: string };
      expect(model.modelId).toBe('anthropic/claude-sonnet-4.5');
      expect(model.provider).toBe('openai.responses');
      // System prompt forwarded verbatim.
      expect(callArgs.system).toBe(SYSTEM_PROMPT);
      // Messages forwarded including the new user turn.
      const messages = callArgs.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages).toContainEqual({ role: 'user', content: 'hola' });
      // Tools forwarded.
      expect(callArgs.tools).toEqual({ getCurrentTime: { description: 't' } });
    });

    it('maps usage.inputTokens → promptTokens and usage.outputTokens → completionTokens', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'Hola',
        usage: { inputTokens: 10, outputTokens: 5 },
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      const result = await agent.run({
        senderId: 's',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
      });

      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
      expect(result.reply).toBe('Hola');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // R3b3-c4c2: toolsContext.requestHumanAssistance inbound identity
  // ────────────────────────────────────────────────────────────────────
  describe('toolsContext.requestHumanAssistance inbound identity', () => {
    const EVENT = {
      receivingPhoneNumberId: '123456789012345',
      senderId: 's',
      messageId: 'wamid.ABC123',
    };

    const run = async (overrides: Partial<LlmRunInput> = {}) => {
      generateTextFn.mockResolvedValueOnce({
        text: 'ok',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as never);
      await agent.run({
        senderId: 's',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
        ...overrides,
      });
      const calls = generateTextFn.mock.calls;
      return calls[calls.length - 1][0] as Record<string, unknown>;
    };
    const slot = (args: Record<string, unknown>) =>
      (args.toolsContext as Record<string, unknown>)
        .requestHumanAssistance as Record<string, unknown>;

    it('adds a frozen copy to requestHumanAssistance alone for a valid matching event', async () => {
      const args = await run({ inboundEvent: EVENT });
      expect(slot(args)).toEqual({ senderId: 's', inboundEvent: EVENT });
      expect(slot(args).inboundEvent).not.toBe(EVENT);
      expect(Object.isFrozen(slot(args).inboundEvent)).toBe(true);
      const ctx = args.toolsContext as Record<string, unknown>;
      expect(ctx.evaluateCart).toEqual({ senderId: 's' });
      expect(ctx.createSale).toEqual({ senderId: 's' });
      expect(ctx.cancelSale).toEqual({ senderId: 's' });
    });

    it('omits the property for an absent event, preserving the exact envelope', async () => {
      const args = await run();
      expect(slot(args)).toEqual({ senderId: 's' });
      expect(
        Object.prototype.hasOwnProperty.call(slot(args), 'inboundEvent'),
      ).toBe(false);
    });

    it('omits the event for mismatched, malformed, or hostile input', async () => {
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
        { ...EVENT, receivingPhoneNumberId: '12a' },
        { ...EVENT, extra: 'x' },
        new Proxy({ ...EVENT }, { get: () => 'tampered' }),
        rotating,
        throwing,
        accessor,
      ];
      for (const inboundEvent of cases) {
        const args = await run({ inboundEvent: inboundEvent as never });
        expect(slot(args)).toEqual({ senderId: 's' });
      }
    });

    it('never leaks the identity into system, messages, or tools', async () => {
      const tools = { requestHumanAssistance: { description: 'r' } };
      const args = await run({ inboundEvent: EVENT, tools });
      expect(args.system).toBe(SYSTEM_PROMPT);
      expect(args.tools).toBe(tools);
      const serialized = JSON.stringify(args.messages);
      expect(serialized).not.toContain(EVENT.messageId);
      expect(serialized).not.toContain(EVENT.receivingPhoneNumberId);
    });
  });

  describe('toolsContext gating for getShippingQuote', () => {
    it('adds getShippingQuote context only when the tool is present', async () => {
      generateTextFn.mockResolvedValueOnce({ text: 'ok' } as never);
      await agent.run({
        senderId: '5215550001111',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {
          getShippingQuote: {
            description: 'q',
            inputSchema: {},
            execute: () => {},
          },
        },
      });
      const callArgs = generateTextFn.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArgs.toolsContext).toEqual({
        evaluateCart: { senderId: '5215550001111' },
        createSale: { senderId: '5215550001111' },
        cancelSale: { senderId: '5215550001111' },
        requestHumanAssistance: { senderId: '5215550001111' },
        getShippingQuote: { senderId: '5215550001111' },
      });
    });

    it('omits getShippingQuote context when the tool is absent', async () => {
      generateTextFn.mockResolvedValueOnce({ text: 'ok' } as never);
      await agent.run({
        senderId: '5215550001111',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
      });

      const callArgs = generateTextFn.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArgs.toolsContext).toEqual({
        evaluateCart: { senderId: '5215550001111' },
        createSale: { senderId: '5215550001111' },
        cancelSale: { senderId: '5215550001111' },
        requestHumanAssistance: { senderId: '5215550001111' },
      });
      expect(callArgs.toolsContext).not.toHaveProperty('getShippingQuote');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CRITICAL GATE: undefined usage → 0 (prevents NaN aggregate in CostGuard)
  // ────────────────────────────────────────────────────────────────────
  describe('run with undefined usage fields (CRITICAL)', () => {
    it('returns promptTokens: 0 when SDK usage.inputTokens is undefined', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'ok',
        usage: { inputTokens: undefined, outputTokens: 7 },
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 0, outputTokens: 7 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      const result = await agent.run({
        senderId: 's',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
      });

      expect(result.usage.promptTokens).toBe(0);
      expect(result.usage.completionTokens).toBe(7);
      // Aggregate must remain numeric (cost guard sums these).
      expect(result.usage.promptTokens + result.usage.completionTokens).toBe(7);
    });

    it('returns completionTokens: 0 when SDK usage.outputTokens is undefined', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'ok',
        usage: { inputTokens: 9, outputTokens: undefined },
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 9, outputTokens: 0 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      const result = await agent.run({
        senderId: 's',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
      });

      expect(result.usage.promptTokens).toBe(9);
      expect(result.usage.completionTokens).toBe(0);
      expect(result.usage.promptTokens + result.usage.completionTokens).toBe(9);
    });

    it('returns {0, 0} when usage is undefined entirely', async () => {
      generateTextFn.mockResolvedValueOnce({
        text: 'ok',
        usage: undefined,
        content: [],
        files: [],
        reasoning: [],
        reasoningText: undefined,
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: 'stop',
        rawFinishReason: undefined,
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        warnings: undefined,
        request: {} as never,
        response: {} as never,
        providerMetadata: undefined,
        responseMessages: [],
        steps: [],
        finalStep: {} as never,
      } as never);

      const result = await agent.run({
        senderId: 's',
        text: 'hola',
        history: [],
        systemPrompt: SYSTEM_PROMPT,
        tools: {},
      });

      expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
      // No NaN: aggregate must be finite.
      expect(
        Number.isFinite(
          result.usage.promptTokens + result.usage.completionTokens,
        ),
      ).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GENERATE_TEXT provider token wiring
  // ────────────────────────────────────────────────────────────────────
  describe('GENERATE_TEXT provider', () => {
    it('is exported as the same symbol from the provider module', () => {
      const providerModule = jest.requireActual<{ GENERATE_TEXT: unknown }>(
        './generate-text.provider',
      );
      expect(providerModule.GENERATE_TEXT).toBe(GENERATE_TEXT);
      // openai() from the SDK returns a model reference (proves the
      // SDK is loaded and the call typechecks).
      const m = openai('anthropic/claude-sonnet-4.5') as { provider: string };
      expect(m.provider).toBe('openai.responses');
    });
  });
});
