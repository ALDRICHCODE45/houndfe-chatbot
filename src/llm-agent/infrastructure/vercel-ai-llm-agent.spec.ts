import { Logger } from '@nestjs/common';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { UpstreamError } from '../../chatbot-api/domain/errors';
import { makeCheckStockTool } from '../../sale-flow/application/tools/check-stock.tool';
import { makeSearchCatalogTool } from '../../sale-flow/application/tools/search-catalog.tool';
import { makeRequestHumanAssistanceTool } from '../../sale-flow/application/tools/request-human-assistance.tool';
import type { ToolDeps } from '../../sale-flow/application/tool-deps';
import { openai } from '@ai-sdk/openai';
import type { LlmRunInput } from '../domain/llm-agent.port';
import { SYSTEM_PROMPT } from '../domain/system-prompt';
import { composeSaleFlowSystemPrompt } from '../../sale-flow/domain/sale-flow-instructions';
import { GENERATE_TEXT, type GenerateTextFn } from './generate-text.provider';
import {
  createInventorySeparationGate,
  INVENTORY_CLARIFICATION_REPLY,
  INVENTORY_UNCONFIRMED_REPLY,
  RECOVERY_LOCK_REASON,
  STOCK_FIRST_DENIAL_REASON,
  VercelAiLlmAgent,
} from './vercel-ai-llm-agent';

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
describe('real SDK catalog context isolation', () => {
  it.each([false, true])('forwards voice (shipping=%s)', async (shipping) => {
    const systemPrompt = composeSaleFlowSystemPrompt(SYSTEM_PROMPT, {
      shippingQuoteAvailable: shipping,
    });
    const senderId = 'PRIVATE_OFFLINE_SENDER';
    const catalogSession = new CatalogSession(senderId, 60000, 0);
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'Offline catalog reply' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    });
    const sdkInputs: Pick<
      Parameters<GenerateTextFn>[0],
      'system' | 'instructions' | 'messages' | 'allowSystemInMessages'
    >[] = [];
    const offlineGenerate: GenerateTextFn = (options) => {
      sdkInputs.push(options);
      return generateText({ ...options, model });
    };
    const agent = new VercelAiLlmAgent(offlineGenerate, 'unused', 2);
    const tools = {
      requestHumanAssistance: makeRequestHumanAssistanceTool({} as ToolDeps),
      checkStock: makeCheckStockTool({
        chatbotApi: { getStock: jest.fn() },
      } as unknown as ToolDeps),
    };
    const first = await agent.run({
      senderId,
      text: 'Busca un producto',
      history: [],
      systemPrompt,
      tools,
      catalogSession,
    });
    expect(sdkInputs[0].system).toBe(systemPrompt);
    expect(sdkInputs[0].instructions).toBeUndefined();
    expect(model.doGenerateCalls[0].prompt).toEqual([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Busca un producto' }],
      },
    ]);

    // Recreate the persisted search evidence available on the next inbound turn.
    catalogSession.installSearch(catalogSession.beginSearch(), [
      {
        productId: '00000000-0000-4000-8000-000000000001',
        name: 'Offline catalog product',
        variants: [],
      },
    ]);
    const catalogEvidence = catalogSession.evidence(0);
    expect(catalogEvidence).toContain(
      'UNSELECTED catalog evidence; stock unknown.',
    );
    const text = '¿Tienes existencias de ese producto?';
    const pending = agent.run({
      senderId,
      text,
      history: first.messages,
      systemPrompt,
      tools,
      catalogSession,
      catalogEvidence: catalogEvidence!,
    });
    await expect(pending).resolves.toMatchObject({
      reply: 'Offline catalog reply',
    });
    const result = await pending;
    const expectedMessages = [
      ...first.messages,
      { role: 'user', content: text },
    ];
    expect(sdkInputs[1].messages).toEqual(expectedMessages);
    expect(sdkInputs[1].system).toBeUndefined();
    expect(sdkInputs[1].instructions).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'system', content: catalogEvidence },
    ]);
    for (const input of sdkInputs) {
      expect(input.messages?.some((message) => message.role === 'system')).toBe(
        false,
      );
      expect(input.allowSystemInMessages).toBeUndefined();
    }
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(model.doGenerateCalls[1].prompt).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'system', content: catalogEvidence },
      ...expectedMessages.map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
    ]);
    expect(result.messages).toEqual([
      ...expectedMessages,
      { role: 'assistant', content: 'Offline catalog reply' },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain(catalogEvidence!);
    for (const call of model.doGenerateCalls) {
      // Scripted replies prove transport only, not generated voice quality.
      expect(call.prompt[0]).toEqual({ role: 'system', content: systemPrompt });
      expect(systemPrompt.includes('# Cotización de envío')).toBe(shipping);
      const assistance = call.tools?.find(
        (tool) => tool.name === 'requestHumanAssistance',
      );
      expect(assistance).toMatchObject({
        type: 'function',
        description: tools.requestHumanAssistance.description,
      });
      if (assistance?.type !== 'function') {
        throw new Error('Expected the real assistance function tool');
      }
      for (const instructions of [systemPrompt, assistance.description]) {
        expect(instructions).toContain(
          'Ya quedó registrada su consulta sobre cuándo tendremos [presentación] de nuevo.',
        );
        expect(instructions).toContain('no afirmes que acabas de enviarla');
        expect(instructions).toContain(
          'Por ahora no puedo confirmar que su consulta haya quedado registrada.',
        );
        expect(instructions).not.toContain('Registramos su interés');
        expect(instructions).not.toContain('ni hay seguimiento');
      }
      // Match the exact origin token, not legitimate price-schema fields
      // such as originalTotalCents. The boot prompt is checked above.
      const providerData = JSON.stringify({
        prompt: call.prompt.slice(1),
        tools: call.tools,
      });
      for (const privateValue of [
        senderId,
        'senderId',
        'observedAt',
        '"origin"',
        'catalogSession',
        'toolsContext',
      ]) {
        expect(providerData).not.toContain(privateValue);
      }
    }
  });

  it.each([false, true])(
    'transmits the approved brand voice to the provider (shipping=%s)',
    async (shipping) => {
      const systemPrompt = composeSaleFlowSystemPrompt(SYSTEM_PROMPT, {
        shippingQuoteAvailable: shipping,
      });
      const catalogSession = new CatalogSession(
        'PRIVATE_VOICE_SENDER',
        60000,
        0,
      );
      const model = new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: 'text', text: 'Offline voice reply' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        },
      });
      const agent = new VercelAiLlmAgent(
        ((options: Parameters<GenerateTextFn>[0]) =>
          generateText({ ...options, model })) as GenerateTextFn,
        'unused',
        2,
      );
      const tools = {
        requestHumanAssistance: makeRequestHumanAssistanceTool({} as ToolDeps),
      };
      // Turn 1: no catalog evidence. Turn 2: the same voice beside evidence.
      const firstTurn = await agent.run({
        senderId: 'PRIVATE_VOICE_SENDER',
        text: 'Busca ibuprofeno de 400 mg',
        history: [],
        systemPrompt,
        tools,
        catalogSession,
      });
      catalogSession.installSearch(catalogSession.beginSearch(), [
        {
          productId: '00000000-0000-4000-8000-000000000001',
          name: 'Ibuprofeno 400 mg',
          variants: [],
        },
      ]);
      const catalogEvidence = catalogSession.evidence(0)!;
      await agent.run({
        senderId: 'PRIVATE_VOICE_SENDER',
        text: '¿Tiene existencias?',
        history: firstTurn.messages,
        systemPrompt,
        tools,
        catalogSession,
        catalogEvidence,
      });

      expect(model.doGenerateCalls).toHaveLength(2);
      for (const call of model.doGenerateCalls) {
        const transmitted = call.prompt[0];
        if (
          transmitted.role !== 'system' ||
          typeof transmitted.content !== 'string'
        ) {
          throw new Error('Expected a string system message first');
        }
        // Scripted replies prove transport only: this asserts the instructions
        // the provider actually received, not the warmth of a real generation.
        expect(transmitted.content).toBe(systemPrompt);
        for (const voice of [
          'devuélvelo una sola vez con la misma cortesía',
          'la misma franja del día que él usó',
          'Hola, buenas tardes! 🤗✨',
          'sin inventar hora ni zona horaria',
          'no repitas el saludo',
          'Hola, buenas noches! 😊✨ Sí, tenemos',
          'no repitas una confirmación del cliente ya establecida en el historial o el contexto',
          'para entregar un dato verificado puedes escribir "Le comparto…"',
          '¡Gracias a usted por su preferencia! 🤗✨ Que tenga una excelente noche.',
          'agradece la paciencia solo si realmente esperó',
          'mientras la consulta siga abierta no te despidas ni cierres por preferencia',
          'es parte de esta voz',
          'no un extra opcional',
          'celebrar un faltante confirmado, un error o un rechazo',
          'Al cerrar de verdad una gestión resuelta, agradece la preferencia',
          'agradece la paciencia solo si el contexto muestra una espera real',
          'Sí puedes agradecer información o paciencia cuando el contexto lo amerite',
          'identidad de una persona real del equipo',
        ]) {
          expect(transmitted.content).toContain(voice);
        }
        for (const obsolete of [
          'Saludo opcional y contextual',
          '1–2 emojis discretos',
          'no son obligatorios',
        ]) {
          expect(transmitted.content).not.toContain(obsolete);
        }
        expect(transmitted.content.includes('# Cotización de envío')).toBe(
          shipping,
        );
        // Fixed literals and operational gates survive the voice rewrite.
        for (const fixed of [
          'esa función aún no está disponible',
          'en un momento un agente te comparte los datos de pago',
          '¿Confirmas la cancelación? Sí/No',
          'Ya quedó registrada su consulta sobre cuándo tendremos [presentación] de nuevo.',
          'Aún no tengo una fecha confirmada para que vuelva a estar disponible.',
        ]) {
          expect(transmitted.content).toContain(fixed);
        }
      }
    },
  );

  it('keeps server context out of provider requests and ignores model-supplied context', async () => {
    const productId = '00000000-0000-4000-8000-000000000001';
    const wrongId = '00000000-0000-4000-8000-000000000002';
    const catalogSession = new CatalogSession(
      'PRIVATE_SERVER_SENDER',
      60000,
      0,
    );
    catalogSession.installSearch(catalogSession.beginSearch(), [
      { productId, name: 'Catalog product', variants: [] },
    ]);
    const getStock = jest.fn().mockResolvedValue({
      productId,
      name: 'Catalog product',
      stock: { status: 'available', quantity: 1 },
      variants: [],
    });
    const tool = makeCheckStockTool({
      chatbotApi: { getStock },
    } as unknown as ToolDeps);
    const usage = {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'forged',
              toolName: 'checkStock',
              input: JSON.stringify({
                productId: wrongId,
                catalogSession: { products: [{ productId: wrongId }] },
                context: { catalogSession: 'forged' },
              }),
            },
            {
              type: 'tool-call',
              toolCallId: 'valid',
              toolName: 'checkStock',
              input: JSON.stringify({ productId }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'Offline reply' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    const offlineGenerate: GenerateTextFn = (options) =>
      generateText({ ...options, model });
    const agent = new VercelAiLlmAgent(offlineGenerate, 'unused', 2);
    await expect(
      agent.run({
        senderId: 'PRIVATE_SERVER_SENDER',
        text: 'check',
        history: [],
        systemPrompt: 'BOOT',
        tools: { checkStock: tool },
        catalogSession,
      }),
      // R2: the forged checkStock is rejected (catalog_identity_unverified),
      // so an unresolved stock failure exists with no executed mutation. The
      // conservative R2 reply override therefore replaces the opaque model
      // text; the identity/isolation assertions below are unchanged.
    ).resolves.toMatchObject({ reply: INVENTORY_UNCONFIRMED_REPLY });
    expect(getStock).toHaveBeenCalledTimes(1);
    expect(getStock).toHaveBeenCalledWith(productId);
    expect(JSON.stringify(model.doGenerateCalls[0])).not.toContain(
      'PRIVATE_SERVER_SENDER',
    );
    expect(JSON.stringify(model.doGenerateCalls[0])).not.toContain(
      'observedAt',
    );
    expect(JSON.stringify(model.doGenerateCalls[0].tools)).not.toContain(
      'catalogSession',
    );
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
      'catalog_identity_unverified',
    );
  });
});

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
  let otherLogs: jest.SpyInstance[];
  const records = () =>
    log.mock.calls.map(([record]) => record as Record<string, unknown>);
  const step = (hooks: Hooks, count = 0) =>
    hooks.onStepFinish?.({
      toolCalls: Array(count).fill({
        toolName: 'searchCatalog',
        input: secret,
      }),
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
    otherLogs = (['error', 'warn', 'debug', 'verbose', 'fatal'] as const).map(
      (method) =>
        jest.spyOn(Logger.prototype, method).mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    // Inspect every argument, not just the structured message.
    for (const spy of [log, ...otherLogs]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      spy.mockRestore();
    }
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
      runId: records().at(-1)?.runId,
      event: 'search_catalog_end',
      category,
      ...(resultCount === undefined ? {} : { resultCount }),
    });
    expect(records().at(-1)).toMatchObject({
      observedSteps: 2,
      toolCalls: category === 'unknown_output' ? null : 1,
      observationComplete: category !== 'unknown_output',
    });
  });

  it('labels arbitrary tools without inspecting output or catalog array items', async () => {
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
    expect(records()[0]).toMatchObject({
      toolName: 'other',
      category: 'unknown_output',
    });
    expect(records()[1]).toMatchObject({ category: 'success', resultCount: 2 });
    expect(records().at(-1)).toMatchObject({ observationComplete: false });
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
    const [search, , second, completedFirst] = records();
    expect(search.runId).toBe(completedFirst.runId);
    expect(second.runId).not.toBe(search.runId);
    expect(second).toMatchObject({ observedSteps: 1, toolCalls: 0 });
    expect(completedFirst).toMatchObject({ observedSteps: 2, toolCalls: 1 });
  });

  const stock = { ok: true, stock: { status: 'available' } };
  const intake = {
    ok: true,
    outcome: 'historical_intake_recorded',
    customerNotified: false,
  };
  it.each([
    ['checkStock', stock, 'success'],
    [
      'checkStock',
      { ...stock, humanAssistance: { kind: 'out_of_stock' } },
      'out_of_stock_signal',
    ],
    ['checkStock', { ok: false, error: { kind: secret } }, 'returned_error'],
    ['checkStock', { ok: true }, 'unknown_output'],
    ['checkStock', { ...stock, humanAssistance: {} }, 'unknown_output'],
    ['requestHumanAssistance', intake, 'historical_intake_recorded'],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'pending',
        customerNotified: false,
      },
      'existing_receipt',
    ],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'response_recorded',
        customerNotified: false,
      },
      'existing_receipt',
    ],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'stale',
        customerNotified: false,
      },
      'existing_receipt',
    ],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'current_status_unknown',
        customerNotified: false,
      },
      'existing_receipt',
    ],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'pending',
      },
      'unknown_output',
    ],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'pending',
        customerNotified: true,
      },
      'unknown_output',
    ],
    [
      'requestHumanAssistance',
      {
        ok: true,
        outcome: 'existing_restock_recorded',
        status: 'not_a_status',
        customerNotified: false,
      },
      'unknown_output',
    ],
    [
      'requestHumanAssistance',
      { ok: true, customerNotified: true },
      'legacy_customer_notified',
    ],
    [
      'requestHumanAssistance',
      { ok: false, error: { kind: 'disabled' } },
      'disabled',
    ],
    [
      'requestHumanAssistance',
      { ok: false, error: { kind: 'restock_unavailable' } },
      'restock_unavailable',
    ],
    [
      'requestHumanAssistance',
      { ok: false, error: { kind: secret } },
      'returned_error',
    ],
    [
      'requestHumanAssistance',
      { ...intake, customerNotified: true },
      'unknown_output',
    ],
    ['requestHumanAssistance', { ok: true }, 'unknown_output'],
    ['requestHumanAssistance', { ok: false }, 'unknown_output'],
    ['requestHumanAssistance', null, 'unknown_output'],
  ])('observes %s envelope as %s', async (name, output, category) => {
    await run((hooks) => {
      end(hooks, outputOf(output), name);
      step(hooks);
    });
    expect(records()[0]).toEqual({
      prefix: 'catalog_diagnostic',
      runId: records().at(-1)?.runId,
      event: 'tool_execution_end',
      toolName: name,
      category,
      // Additive, closed-vocabulary diagnostics for the checkStock
      // returned-error envelope only; a non-allowlisted string kind is
      // mapped to the fixed `unknown` label, never echoed.
      ...(name === 'checkStock' && category === 'returned_error'
        ? { errorKind: 'unknown' }
        : {}),
    });
    expect(records()[1].observationComplete).toBe(
      category !== 'unknown_output',
    );
  });

  it.each([
    'catalog_identity_unverified',
    'auth',
    'forbidden',
    'notFound',
    'rateLimit',
    'validation',
    'upstream',
  ])(
    'maps allowlisted checkStock returned error kind %s',
    async (errorKind) => {
      await run((hooks) => {
        end(
          hooks,
          outputOf({ ok: false, error: { kind: errorKind } }),
          'checkStock',
        );
        step(hooks);
      });
      expect(records()[0]).toEqual({
        prefix: 'catalog_diagnostic',
        runId: records().at(-1)?.runId,
        event: 'tool_execution_end',
        toolName: 'checkStock',
        category: 'returned_error',
        errorKind,
      });
    },
  );

  it('maps a non-allowlisted checkStock kind to fixed unknown without echoing it', async () => {
    const kind = `${secret}_kind`;
    await run((hooks) => {
      end(hooks, outputOf({ ok: false, error: { kind } }), 'checkStock');
      step(hooks);
    });
    expect(records()[0]).toMatchObject({
      toolName: 'checkStock',
      category: 'returned_error',
      errorKind: 'unknown',
    });
    expect(JSON.stringify(records())).not.toContain(kind);
  });

  it.each([
    ['non-string kind', { ok: false, error: { kind: 7 } }],
    ['null error', { ok: false, error: null }],
    ['missing kind', { ok: false, error: {} }],
    ['missing error', { ok: false }],
  ])(
    'keeps a malformed checkStock error envelope as unknown_output (%s)',
    async (_label, output) => {
      await run((hooks) => {
        end(hooks, outputOf(output), 'checkStock');
        step(hooks);
      });
      expect(records()[0]).toMatchObject({
        toolName: 'checkStock',
        category: 'unknown_output',
      });
      expect(records()[0]).not.toHaveProperty('errorKind');
    },
  );

  it('ignores additional sensitive error props while mapping an allowlisted kind', async () => {
    await run((hooks) => {
      end(
        hooks,
        outputOf({
          ok: false,
          error: { kind: 'auth', message: secret, payload: { raw: secret } },
        }),
        'checkStock',
      );
      step(hooks);
    });
    expect(records()[0]).toEqual({
      prefix: 'catalog_diagnostic',
      runId: records().at(-1)?.runId,
      event: 'tool_execution_end',
      toolName: 'checkStock',
      category: 'returned_error',
      errorKind: 'auth',
    });
  });

  it('never attaches errorKind to success or non-checkStock envelopes', async () => {
    await run((hooks) => {
      end(hooks, outputOf(stock), 'checkStock');
      end(
        hooks,
        outputOf({ ok: false, error: { kind: 'disabled' } }),
        'requestHumanAssistance',
      );
      end(
        hooks,
        outputOf({ ok: false, error: { kind: 'auth' } }),
        'evaluateCart',
      );
      step(hooks);
    });
    const ends = records().filter((r) => r.event === 'tool_execution_end');
    expect(ends).toHaveLength(3);
    for (const record of ends) expect(record).not.toHaveProperty('errorKind');
  });

  it('does not attach errorKind to the step-completion fallback requests', async () => {
    await run((hooks) =>
      hooks.onStepFinish({ toolCalls: [{ toolName: 'checkStock' }] }),
    );
    expect(records()[0]).toMatchObject({
      event: 'tool_requested',
      toolName: 'checkStock',
    });
    expect(records()[0]).not.toHaveProperty('errorKind');
  });

  it.each(['checkStock', 'requestHumanAssistance'])(
    'records %s execution errors without reading the error',
    async (name) => {
      await run((hooks) =>
        end(hooks, { type: 'tool-error', error: secret }, name),
      );
      expect(records()[0]).toMatchObject({
        toolName: name,
        category: 'execution_error',
      });
    },
  );

  it('observes requested names without asserting execution, including unknown names', async () => {
    await run((hooks) =>
      hooks.onStepFinish({
        toolCalls: [
          { toolName: 'checkStock', input: secret },
          { toolName: 'requestHumanAssistance', input: secret },
          { toolName: secret, input: secret },
        ],
      }),
    );
    expect(
      records()
        .filter((r) => r.event === 'tool_requested')
        .map((r) => r.toolName),
    ).toEqual(['checkStock', 'requestHumanAssistance', 'other']);
    expect(records().some((r) => r.event === 'tool_execution_end')).toBe(false);
    expect(records().at(-1)).toMatchObject({ observationComplete: false });
  });

  const registeredNames = [
    'searchCatalog',
    'checkStock',
    'requestHumanAssistance',
    'evaluateCart',
    'getCustomerByPhone',
    'upsertCustomer',
    'createSale',
    'attachReceipt',
    'updateDelivery',
    'getOrderHistory',
    'getPaymentDetails',
    'cancelSale',
    'getShippingQuote',
  ];
  it.each(registeredNames)('retains requested name %s', async (toolName) => {
    await run((hooks) => hooks.onStepFinish({ toolCalls: [{ toolName }] }));
    expect(records()[0]).toMatchObject({ event: 'tool_requested', toolName });
    expect(records().at(-1)?.observationComplete).toBe(true);
  });

  it.each(registeredNames.slice(3))(
    'reads generic flags for %s',
    async (name) => {
      const flagOnly = Object.defineProperty({ ok: true }, 'customerNotified', {
        get() {
          throw new Error(secret);
        },
      });
      const cases = [
        [outputOf(flagOnly), 'returned_ok'],
        [outputOf({ ok: true, customerNotified: true }), 'returned_ok'],
        [outputOf({ ok: false }), 'returned_error'],
        [outputOf({ ok: 'true' }), 'unknown_output'],
        [outputOf(null), 'unknown_output'],
        [outputOf({}), 'unknown_output'],
        [{ type: 'tool-error', error: secret }, 'execution_error'],
      ] as const;
      for (const [output, category] of cases) {
        await run((hooks) => {
          end(hooks, output, name);
          step(hooks);
        });
        expect(records().at(-2)).toMatchObject({
          event: 'tool_execution_end',
          toolName: name,
          category,
        });
      }
    },
  );

  it('records a known requested call with no execution-end callback', async () => {
    await run((hooks) =>
      hooks.onStepFinish({
        toolCalls: [
          { toolName: 'requestHumanAssistance', invalid: true, input: secret },
        ],
      }),
    );
    expect(records().map((r) => r.event)).toEqual([
      'tool_requested',
      'run_completed',
    ]);
    expect(records()[0]).toMatchObject({
      toolName: 'requestHumanAssistance',
      truncated: false,
    });
    expect(records()[1]).toMatchObject({ observedSteps: 1, toolCalls: 1 });
  });

  it('bounds requested metadata reads to sixteen entries', async () => {
    const calls = Array(17).fill({ toolName: 'checkStock' });
    const beyondBound = jest.fn(() => {
      throw new Error(secret);
    });
    Object.defineProperty(calls, 16, { get: beyondBound });
    await run((hooks) => hooks.onStepFinish({ toolCalls: calls }));
    expect(beyondBound).not.toHaveBeenCalled();
    expect(records().filter((r) => r.event === 'tool_requested')).toHaveLength(
      16,
    );
    expect(records()[0]).toMatchObject({ truncated: true });
    expect(records().at(-1)).toMatchObject({
      observationComplete: false,
      toolCalls: null,
    });
  });

  it.each(['missing', 'name', 'nested', 'unused'])(
    'guards %s metadata and never serializes nested objects',
    async (kind) => {
      const getter = jest.fn(() => {
        throw new Error(secret);
      });
      const hostile = new Proxy({}, { get: getter });
      await expect(
        run((hooks) => {
          if (kind === 'missing') hooks.onStepFinish({ toolCalls: Array(1) });
          if (kind === 'name') hooks.onStepFinish({ toolCalls: [hostile] });
          if (kind === 'nested')
            end(
              hooks,
              outputOf({ ok: true, humanAssistance: hostile }),
              'checkStock',
            );
          if (kind === 'unused') {
            end(
              hooks,
              outputOf({ ...intake, debug: hostile, requestId: secret }),
              'requestHumanAssistance',
            );
            hooks.onStepFinish({
              toolCalls: [{ toolName: 'checkStock', input: hostile }],
            });
          }
        }),
      ).resolves.toMatchObject({ reply: secret });
      expect(records().at(-1)?.observationComplete).toBe(kind === 'unused');
      if (kind === 'unused') expect(getter).not.toHaveBeenCalled();
    },
  );

  it('contains logger failures on both successful and rejected generation', async () => {
    log.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    await expect(
      run((hooks) => {
        end(hooks, { type: 'tool-error', error: secret }, 'checkStock');
        step(hooks);
      }),
    ).resolves.toMatchObject({ reply: secret });
    expect(records().at(-1)).toMatchObject({ observationComplete: false });
    log.mockImplementation(() => {
      throw new Error(secret);
    });
    await expect(run((hooks) => step(hooks, 1))).resolves.toMatchObject({
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

describe('inventory evidence separation (R2)', () => {
  const productId = '00000000-0000-4000-8000-000000000001';
  const availableStock = {
    productId,
    name: 'Medicine 400 mg',
    stock: { status: 'available', quantity: 5 },
    variants: [],
  };
  const usage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const toolCall = (toolCallId: string, toolName: string, input: string) => ({
    type: 'tool-call' as const,
    toolCallId,
    toolName,
    input,
  });

  function session() {
    const catalogSession = new CatalogSession('sender', 60000, 0);
    catalogSession.installSearch(catalogSession.beginSearch(), [
      { productId, name: 'Medicine 400 mg', variants: [] },
    ]);
    return catalogSession;
  }

  function stub(name: string) {
    const execute = jest.fn(async () => ({ ok: true }));
    const definition = tool({
      description: `${name} stub`,
      inputSchema: z.object({}),
      execute,
    });
    return { definition, execute };
  }

  function checkStockTool(getStock: jest.Mock) {
    return makeCheckStockTool({
      chatbotApi: { getStock },
    } as unknown as ToolDeps);
  }

  async function run(
    tools: Record<string, unknown>,
    steps: Array<
      Array<{ toolCallId: string; toolName: string; input: string }> | string
    >,
    catalogSession: CatalogSession,
  ) {
    const doGenerate = steps.map((step) =>
      typeof step === 'string'
        ? {
            content: [{ type: 'text', text: step }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: [],
          }
        : {
            content: step,
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
            warnings: [],
          },
    );
    const model = new MockLanguageModelV4({ doGenerate } as never);
    let captured:
      | { steps: Array<{ content: Array<Record<string, unknown>> }> }
      | undefined;
    const generate: GenerateTextFn = async (options) => {
      const result = await generateText({ ...options, model });
      captured = result as unknown as typeof captured;
      return result;
    };
    const agent = new VercelAiLlmAgent(generate, 'unused', 6);
    const result = await agent.run({
      senderId: 'sender',
      text: 'check stock',
      history: [],
      systemPrompt: 'BOOT',
      tools,
      catalogSession,
    });
    return { result, model, captured: captured! };
  }

  const MUTATING = [
    'evaluateCart',
    'upsertCustomer',
    'createSale',
    'updateDelivery',
    'cancelSale',
    'requestHumanAssistance',
    'getShippingQuote',
  ];
  const READ_ONLY = [
    'searchCatalog',
    'getCustomerByPhone',
    'getOrderHistory',
    'getPaymentDetails',
    'attachReceipt',
  ];

  it.each(MUTATING)(
    'denies the mutating sibling %s without executing it and without an approval UI',
    async (name) => {
      const getStock = jest.fn().mockResolvedValue(availableStock);
      const mutation = stub(name);
      const tools = {
        checkStock: checkStockTool(getStock),
        [name]: mutation.definition,
      } as Record<string, unknown>;
      const { captured } = await run(
        tools,
        [
          [
            toolCall('c1', 'checkStock', JSON.stringify({ productId })),
            toolCall('m1', name, '{}'),
          ],
          'final',
        ],
        session(),
      );
      expect(mutation.execute).not.toHaveBeenCalled();
      expect(getStock).toHaveBeenCalledTimes(1);
      const content = captured.steps[0].content;
      expect(
        content.find((part) => part.type === 'tool-approval-response'),
      ).toMatchObject({ approved: false, reason: STOCK_FIRST_DENIAL_REASON });
      expect(
        content.find((part) => part.type === 'tool-approval-request'),
      ).toMatchObject({ isAutomatic: true });
      expect(
        content.some(
          (part) =>
            part.type === 'tool-approval-request' && part.isAutomatic !== true,
        ),
      ).toBe(false);
    },
  );

  it.each(READ_ONLY)(
    'executes the read-only sibling %s in a checkStock batch',
    async (name) => {
      const getStock = jest.fn().mockResolvedValue(availableStock);
      const readOnly = stub(name);
      const tools = {
        checkStock: checkStockTool(getStock),
        [name]: readOnly.definition,
      } as Record<string, unknown>;
      await run(
        tools,
        [
          [
            toolCall('c1', 'checkStock', JSON.stringify({ productId })),
            toolCall('r1', name, '{}'),
          ],
          'final',
        ],
        session(),
      );
      expect(readOnly.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('executes the read-only checkStock sibling and no mutation', async () => {
    const getStock = jest.fn().mockResolvedValue(availableStock);
    const tools = { checkStock: checkStockTool(getStock) };
    await run(
      tools,
      [[toolCall('c1', 'checkStock', JSON.stringify({ productId }))], 'final'],
      session(),
    );
    expect(getStock).toHaveBeenCalledTimes(1);
  });

  it('denies a mutation-only batch after a failed stock check even when the model ignores inactive tools', async () => {
    const getStock = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', 503));
    const sale = stub('createSale');
    const tools = {
      checkStock: checkStockTool(getStock),
      createSale: sale.definition,
    };
    const { result, model, captured } = await run(
      tools,
      [
        [toolCall('c1', 'checkStock', JSON.stringify({ productId }))],
        [toolCall('m1', 'createSale', '{}')],
        'final',
      ],
      session(),
    );
    expect(sale.execute).not.toHaveBeenCalled();
    // The mutation is already hidden from the provider presentation...
    expect(
      (model.doGenerateCalls[1].tools ?? []).map(
        (definition) => definition.name,
      ),
    ).not.toContain('createSale');
    // ...and a model that emits it anyway is denied, never queued.
    const content = captured.steps[1].content;
    expect(
      content.find((part) => part.type === 'tool-approval-response'),
    ).toMatchObject({ approved: false, reason: STOCK_FIRST_DENIAL_REASON });
    expect(
      content.some(
        (part) =>
          part.type === 'tool-approval-request' && part.isAutomatic !== true,
      ),
    ).toBe(false);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('overrides the reply from the first non-authoritative stock result when nothing executed', async () => {
    const getStock = jest.fn().mockResolvedValue({
      productId,
      name: 'Medicine 400 mg',
      stock: { status: 'not_managed', quantity: null },
      variants: [],
    });
    const tools = { checkStock: checkStockTool(getStock) };
    const { result } = await run(
      tools,
      [[toolCall('c1', 'checkStock', JSON.stringify({ productId }))], 'final'],
      session(),
    );
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('denies an unknown executable tool name in a checkStock batch', async () => {
    const getStock = jest.fn().mockResolvedValue(availableStock);
    const mystery = stub('mysteryTool');
    const tools = {
      checkStock: checkStockTool(getStock),
      mysteryTool: mystery.definition,
    };
    await run(
      tools,
      [
        [
          toolCall('c1', 'checkStock', JSON.stringify({ productId })),
          toolCall('x1', 'mysteryTool', '{}'),
        ],
        'final',
      ],
      session(),
    );
    expect(mystery.execute).not.toHaveBeenCalled();
  });

  it('executes a mutating reissue exactly once after a valid stock result', async () => {
    const getStock = jest.fn().mockResolvedValue(availableStock);
    const sale = stub('createSale');
    const tools = {
      checkStock: checkStockTool(getStock),
      createSale: sale.definition,
    };
    const { model } = await run(
      tools,
      [
        [
          toolCall('c1', 'checkStock', JSON.stringify({ productId })),
          toolCall('m1', 'createSale', '{}'),
        ],
        [toolCall('m2', 'createSale', '{}')],
        'final',
      ],
      session(),
    );
    expect(sale.execute).toHaveBeenCalledTimes(1);
    expect(
      (model.doGenerateCalls[1].tools ?? []).map(
        (definition) => definition.name,
      ),
    ).toContain('createSale');
  });

  it('does not execute a denied mutation and overrides the reply while unresolved', async () => {
    const getStock = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', 503));
    const sale = stub('createSale');
    const tools = {
      checkStock: checkStockTool(getStock),
      createSale: sale.definition,
    };
    const { result, model } = await run(
      tools,
      [
        [
          toolCall('c1', 'checkStock', JSON.stringify({ productId })),
          toolCall('m1', 'createSale', '{}'),
        ],
        'final',
      ],
      session(),
    );
    expect(sale.execute).not.toHaveBeenCalled();
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: INVENTORY_UNCONFIRMED_REPLY,
    });
    const restricted = (model.doGenerateCalls[1].tools ?? []).map(
      (definition) => definition.name,
    );
    expect(restricted).toContain('checkStock');
    expect(restricted).not.toContain('createSale');
  });

  it('preserves the reply and history when a prior mutation may have had effects', async () => {
    const getStock = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', 503));
    const sale = stub('createSale');
    sale.execute.mockRejectedValueOnce(new Error('ambiguous result'));
    const tools = {
      checkStock: checkStockTool(getStock),
      createSale: sale.definition,
    };
    const { result } = await run(
      tools,
      [
        [toolCall('m1', 'createSale', '{}')],
        [toolCall('c1', 'checkStock', JSON.stringify({ productId }))],
        'final reply',
      ],
      session(),
    );
    expect(sale.execute).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('final reply');
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'final reply',
    });
  });

  it('counts an unknown executed tool as a potential effect and preserves the reply', async () => {
    const getStock = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', 503));
    const mystery = stub('mysteryTool');
    const tools = {
      checkStock: checkStockTool(getStock),
      mysteryTool: mystery.definition,
    };
    const { result } = await run(
      tools,
      [
        [toolCall('u1', 'mysteryTool', '{}')],
        [toolCall('c1', 'checkStock', JSON.stringify({ productId }))],
        'final reply',
      ],
      session(),
    );
    expect(mystery.execute).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('final reply');
  });

  describe('createInventorySeparationGate', () => {
    it('denies mutating and unknown tools when batch metadata is missing or malformed', () => {
      const gate = createInventorySeparationGate();
      for (const event of [
        undefined,
        null,
        {},
        { content: 'not-an-array' },
        { content: [null] },
        { content: [{ type: 'tool-call' }] },
      ]) {
        gate.capture(event);
        expect(gate.approve({ toolCallId: 'x', toolName: 'createSale' })).toBe(
          'denied',
        );
        expect(gate.approve({ toolCallId: 'x', toolName: 'mysteryTool' })).toBe(
          'denied',
        );
        expect(
          gate.approve({ toolCallId: 'x', toolName: 'searchCatalog' }),
        ).toBe('not-applicable');
      }
    });

    it('never lets a stale batch id authorize a mutation', () => {
      const gate = createInventorySeparationGate();
      gate.capture({
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'checkStock' },
          { type: 'tool-call', toolCallId: 'b', toolName: 'createSale' },
        ],
      });
      expect(gate.approve({ toolCallId: 'b', toolName: 'createSale' })).toBe(
        'denied',
      );
      expect(gate.approve({ toolCallId: 'a', toolName: 'checkStock' })).toBe(
        'not-applicable',
      );
      gate.capture({
        content: [
          { type: 'tool-call', toolCallId: 'c', toolName: 'searchCatalog' },
        ],
      });
      expect(gate.approve({ toolCallId: 'b', toolName: 'createSale' })).toBe(
        'denied',
      );
      gate.capture({
        content: [
          { type: 'tool-call', toolCallId: 'd', toolName: 'createSale' },
        ],
      });
      expect(gate.approve({ toolCallId: 'd', toolName: 'createSale' })).toBe(
        'not-applicable',
      );
    });

    it('fails closed on a malformed tool call', () => {
      const gate = createInventorySeparationGate();
      expect(gate.approve(null)).toBe('denied');
      expect(gate.approve({})).toBe('denied');
      expect(gate.approve({ toolName: 42 })).toBe('denied');
    });

    it('denies mutating and unknown names while unresolved, even without a checkStock sibling', () => {
      const gate = createInventorySeparationGate(() => true);
      gate.capture({
        content: [
          { type: 'tool-call', toolCallId: 'm', toolName: 'createSale' },
        ],
      });
      expect(gate.approve({ toolCallId: 'm', toolName: 'createSale' })).toBe(
        'denied',
      );
      gate.capture({
        content: [
          { type: 'tool-call', toolCallId: 'u', toolName: 'mysteryTool' },
        ],
      });
      expect(gate.approve({ toolCallId: 'u', toolName: 'mysteryTool' })).toBe(
        'denied',
      );
      // Read-only tools stay available so a recovery check can still run.
      gate.capture({
        content: [
          { type: 'tool-call', toolCallId: 'c', toolName: 'checkStock' },
        ],
      });
      expect(gate.approve({ toolCallId: 'c', toolName: 'checkStock' })).toBe(
        'not-applicable',
      );
      expect(gate.approve({ toolCallId: 's', toolName: 'searchCatalog' })).toBe(
        'not-applicable',
      );
    });
  });
});

describe('catalog stock recovery through the real SDK', () => {
  const productId = '00000000-0000-4000-8000-000000000001';
  const adversarialId = '00000000-0000-4000-8000-0000000000aa';
  const usage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const call = (toolCallId: string, toolName: string, input: string) => ({
    type: 'tool-call' as const,
    toolCallId,
    toolName,
    input,
  });
  const stockResponse = {
    productId,
    name: 'Ibuprofeno de 400 mg',
    stock: { status: 'available', quantity: 7 },
    variants: [],
  };
  const catalogItem = {
    productId,
    name: 'Ibuprofeno de 400 mg',
    brand: null,
    imageUrl: null,
    description: null,
    price: {
      priceCents: 100,
      fromPriceCents: null,
      promoPriceCents: null,
      promotionEvaluationStatus: 'needs_human_review' as const,
    },
    stock: { status: 'available' as const, quantity: 7 },
    packageInfo: { weightGrams: null, dimensions: null },
    variants: [],
  };
  // Production incident: prior user asks about ibuprofeno, the assistant asks
  // whether it should check availability, and the customer answers "Si por
  // favor".
  const history = [
    { role: 'user' as const, content: 'Buenas tardes, tienen ibuprofeno?' },
    {
      role: 'assistant' as const,
      content:
        'Claro. ¿Quieres que revise la disponibilidad de Ibuprofeno de 400 mg?',
    },
  ];

  function scenario(options: {
    steps: Array<
      Array<{ toolCallId: string; toolName: string; input: string }> | string
    >;
    text: string;
    maxSteps: number;
    getStock: jest.Mock;
    catalog?: Array<typeof catalogItem>;
    extraTools?: Record<string, unknown>;
    seedCatalog?: boolean;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  }) {
    const searchCatalog = jest
      .fn()
      .mockResolvedValue(options.catalog ?? [catalogItem]);
    const sale = {
      execute: jest.fn(async () => ({ ok: true })),
      definition: tool({
        description: 'createSale stub',
        inputSchema: z.object({}),
        execute: jest.fn(async () => ({ ok: true })),
      }),
    };
    const tools = {
      checkStock: makeCheckStockTool({
        chatbotApi: { getStock: options.getStock },
      } as unknown as ToolDeps),
      searchCatalog: makeSearchCatalogTool({
        chatbotApi: { searchCatalog },
      } as unknown as ToolDeps),
      createSale: sale.definition,
      ...(options.extraTools ?? {}),
    };
    const doGenerate = options.steps.map((step) =>
      typeof step === 'string'
        ? {
            content: [{ type: 'text' as const, text: step }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: [],
          }
        : {
            content: step,
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
            warnings: [],
          },
    );
    const model = new MockLanguageModelV4({ doGenerate } as never);
    let captured:
      | { steps: Array<{ content: Array<Record<string, unknown>> }> }
      | undefined;
    const generate: GenerateTextFn = async (input) => {
      const result = await generateText({ ...input, model });
      captured = result as unknown as typeof captured;
      return result;
    };
    const agent = new VercelAiLlmAgent(generate, 'unused', options.maxSteps);
    const catalogSession = new CatalogSession('sender', 60000, 0);
    if (options.seedCatalog) {
      catalogSession.installSearch(catalogSession.beginSearch(), [catalogItem]);
    }
    const run = () =>
      agent.run({
        senderId: 'sender',
        text: options.text,
        history: options.history ?? history,
        systemPrompt: 'BOOT',
        tools,
        catalogSession,
      });
    return {
      run,
      model,
      getStock: options.getStock,
      searchCatalog,
      sale,
      captured: () => captured!,
    };
  }

  it('recovers the affirmative continuation with exactly one trusted GET', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        // Adversarial model argument: the server-selected input must win.
        [
          call(
            'recover',
            'checkStock',
            JSON.stringify({ productId: adversarialId }),
          ),
        ],
        'Sí, tenemos Ibuprofeno de 400 mg disponible. 😊',
      ],
    });
    const result = await s.run();
    expect(s.getStock).toHaveBeenCalledTimes(1);
    expect(s.getStock).toHaveBeenCalledWith(productId);
    expect(s.searchCatalog).toHaveBeenCalledTimes(1);
    expect(s.sale.definition.execute).not.toHaveBeenCalled();
    expect(result.reply).toBe(
      'Sí, tenemos Ibuprofeno de 400 mg disponible. 😊',
    );
    // Failed check, fresh search, forced stock and final render: no extra step.
    expect(s.model.doGenerateCalls).toHaveLength(4);
  });

  it('keeps a divergent failed identity unresolved instead of clearing it blindly', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [
          call(
            'fail',
            'checkStock',
            JSON.stringify({ productId: adversarialId }),
          ),
        ],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [call('recover', 'checkStock', JSON.stringify({ productId }))],
        'Sí, tenemos disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).toHaveBeenCalledTimes(1);
    expect(s.getStock).toHaveBeenCalledWith(productId);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('fails closed when the provider ignores the forced stock step', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        'Sí, claro que sí está disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).not.toHaveBeenCalled();
    // The forced step was consumed (fail, search, ignored force) and refused.
    expect(s.model.doGenerateCalls).toHaveLength(3);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('denies a mutation emitted during the forced recovery step', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [
          call('recover', 'checkStock', JSON.stringify({ productId })),
          call('sale', 'createSale', '{}'),
        ],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(s.sale.definition.execute).not.toHaveBeenCalled();
    expect(s.getStock).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('fails closed when the forced stock lookup itself fails', async () => {
    const getStock = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', 503));
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [call('recover', 'checkStock', JSON.stringify({ productId }))],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('preserves the reply when a prior mutation may have had effects', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 5,
      getStock,
      steps: [
        [call('sale', 'createSale', '{}')],
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [call('recover', 'checkStock', JSON.stringify({ productId }))],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(s.sale.definition.execute).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('Sí, disponible.');
  });

  it('keeps the ordinary budget and never forges recovery at a low step cap', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 2,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [call('recover', 'checkStock', JSON.stringify({ productId }))],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).not.toHaveBeenCalled();
    // The ordinary budget of two steps is kept; no forced recovery is added.
    expect(s.model.doGenerateCalls).toHaveLength(2);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
  });

  it('does not auto-GET from an assistant-only subject even with a prior valid snapshot', async () => {
    // Old behavior armed a proactive GET on the first prepareStep from the
    // assistant's own availability question. There is no this-run identity
    // failure and no fresh search, so nothing may be forced.
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 2,
      getStock,
      seedCatalog: true,
      steps: [
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        'Claro, ¿te gustaría que revise disponibilidad?',
      ],
    });
    const result = await s.run();
    expect(s.getStock).not.toHaveBeenCalled();
    expect(result.reply).toBe('Claro, ¿te gustaría que revise disponibilidad?');
    expect(s.model.doGenerateCalls).toHaveLength(2);
  });

  it('denies a mutation emitted in the forced final step before it can execute', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [call('recover', 'checkStock', JSON.stringify({ productId }))],
        // The final step is contracted as tool-free, but the model ignores it.
        [call('sale', 'createSale', '{}')],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).toHaveBeenCalledTimes(1);
    expect(s.getStock).toHaveBeenCalledWith(productId);
    expect(s.sale.definition.execute).not.toHaveBeenCalled();
    // Denied BEFORE execution by the hard recovery lock, not merely detected.
    const content = s.captured().steps[3].content;
    expect(
      content.find((part) => part.type === 'tool-approval-response'),
    ).toMatchObject({ approved: false, reason: RECOVERY_LOCK_REASON });
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
    // Bounded exit: the failed choreography stops the run immediately.
    expect(s.model.doGenerateCalls).toHaveLength(4);
  });

  it('denies an unknown tool emitted in the forced final step', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const mystery = {
      execute: jest.fn(async () => ({ ok: true })),
      definition: tool({
        description: 'listProducts stub',
        inputSchema: z.object({}),
        execute: jest.fn(async () => ({ ok: true })),
      }),
    };
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      extraTools: { listProducts: mystery.definition },
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [call('recover', 'checkStock', JSON.stringify({ productId }))],
        [call('u', 'listProducts', '{}')],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(mystery.definition.execute).not.toHaveBeenCalled();
    const content = s.captured().steps[3].content;
    expect(
      content.find((part) => part.type === 'tool-approval-response'),
    ).toMatchObject({ approved: false, reason: RECOVERY_LOCK_REASON });
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
    expect(s.model.doGenerateCalls).toHaveLength(4);
  });

  it('executes only one forced stock lookup when the model emits a duplicate', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        [
          call('r1', 'checkStock', JSON.stringify({ productId })),
          call('r2', 'checkStock', JSON.stringify({ productId })),
        ],
        'Sí, disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).toHaveBeenCalledTimes(1);
    expect(s.getStock).toHaveBeenCalledWith(productId);
    // The duplicate is denied pre-execution by the lock, not only deduped.
    const denied = s
      .captured()
      .steps[2].content.filter(
        (part) => part.type === 'tool-approval-response',
      );
    expect(denied).toEqual([
      expect.objectContaining({
        approved: false,
        reason: RECOVERY_LOCK_REASON,
      }),
    ]);
    expect(result.reply).toBe(INVENTORY_UNCONFIRMED_REPLY);
    expect(s.model.doGenerateCalls).toHaveLength(3);
  });

  it('asks a clarification when the assistant proposed an unsupported subject, without a GET', async () => {
    // The fresh search resolves only ibuprofeno, but the assistant offered to
    // check paracetamol: the customer never affirmed that subject, so nothing
    // may be forced and the reply must be a truthful clarification.
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      history: [
        { role: 'user', content: '¿Tienen ibuprofeno?' },
        {
          role: 'assistant',
          content: '¿Quieres que revise disponibilidad de paracetamol?',
        },
      ],
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        'Sí, tenemos disponible.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).not.toHaveBeenCalled();
    expect(s.searchCatalog).toHaveBeenCalledTimes(1);
    expect(s.sale.definition.execute).not.toHaveBeenCalled();
    expect(result.reply).toBe(INVENTORY_CLARIFICATION_REPLY);
    expect(s.model.doGenerateCalls).toHaveLength(3);
  });

  it('asks a truthful clarification instead of a stock claim when the fresh search is ambiguous', async () => {
    const getStock = jest.fn().mockResolvedValue(stockResponse);
    const s = scenario({
      text: 'Si por favor',
      maxSteps: 3,
      getStock,
      catalog: [
        catalogItem,
        {
          ...catalogItem,
          productId: '00000000-0000-4000-8000-000000000002',
          name: 'Ibuprofeno de 800 mg',
        },
      ],
      steps: [
        [call('fail', 'checkStock', JSON.stringify({ productId }))],
        [
          call(
            'search',
            'searchCatalog',
            JSON.stringify({ q: 'ibuprofeno', limit: 20 }),
          ),
        ],
        'Encontré varias presentaciones.',
      ],
    });
    const result = await s.run();
    expect(s.getStock).not.toHaveBeenCalled();
    expect(s.sale.definition.execute).not.toHaveBeenCalled();
    expect(result.reply).toBe(INVENTORY_CLARIFICATION_REPLY);
    expect(s.model.doGenerateCalls).toHaveLength(3);
  });
});
