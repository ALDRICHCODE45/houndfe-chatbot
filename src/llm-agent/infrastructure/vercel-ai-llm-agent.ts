import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stepCountIs } from 'ai';
import type { ModelMessage, ToolExecutionEndEvent } from 'ai';
import { openai } from '@ai-sdk/openai';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';
import type { AgentMessage } from '../domain/agent-message';
import type {
  LlmAgentPort,
  LlmRunInput,
  LlmRunResult,
} from '../domain/llm-agent.port';
import { GENERATE_TEXT, type GenerateTextFn } from './generate-text.provider';

/**
 * Vercel-AI-SDK-backed implementation of LlmAgentPort.
 *
 * This is the ONLY file in the application that calls the SDK
 * directly. Application code goes through the LLM_AGENT symbol.
 *
 * Usage mapping is enforced here:
 *   inputTokens  → promptTokens    (default undefined → 0)
 *   outputTokens → completionTokens (default undefined → 0)
 *
 * The defaults are MANDATORY because `CostGuard` sums these values
 * into a running aggregate; an undefined field would propagate to
 * NaN and silently defeat the 80% / 100% threshold scenarios.
 */
@Injectable()
export class VercelAiLlmAgent implements LlmAgentPort {
  private readonly logger = new Logger(VercelAiLlmAgent.name);

  constructor(
    @Inject(GENERATE_TEXT) private readonly generateTextFn: GenerateTextFn,
    private readonly modelId: string,
    private readonly maxSteps: number,
  ) {}

  async run(input: LlmRunInput): Promise<LlmRunResult> {
    const messages = assembleModelMessages(input.history, input.text);
    const catalogSession =
      CatalogSession.is(input.catalogSession) &&
      input.catalogSession.senderId === input.senderId
        ? input.catalogSession
        : undefined;
    const catalogContext = catalogSession ? { catalogSession } : {};
    // toolsContext — per-tool runtime values the LLM must NOT see in
    // the prompt. The cart-touching tools (evaluateCart, createSale)
    // declare `contextSchema: z.object({ senderId: z.string() })` and
    // receive `options.context.senderId` inside `execute`. Stateless
    // tools don't appear here — the SDK only requires an entry for
    // tools that declare a contextSchema.
    const inboundEvent = forwardableInboundEvent(input);
    const toolsContext: Record<
      string,
      {
        senderId?: string;
        inboundEvent?: LlmRunInput['inboundEvent'];
        catalogSession?: CatalogSession;
      }
    > = {
      evaluateCart: { senderId: input.senderId },
      createSale: { senderId: input.senderId },
      // cancelSale declares `contextSchema: z.object({ senderId })` and
      // reads `options.context.senderId` in `execute` (cancel-endpoint
      // slice). The context envelope key MUST match the tool name so
      // the SDK scopes the entry into its `options.context` arg.
      cancelSale: { senderId: input.senderId },
      // Human-handoff slice: the 12th tool `requestHumanAssistance`
      // declares `contextSchema: z.object({ senderId, inboundEvent? })`
      // and reads `options.context.senderId`. R3b3-c4c2 adds an inert
      // RESTOCK `inboundEvent` to THIS entry ONLY, and only for a strictly
      // valid, sender-matching event, as a frozen copy. The model can never
      // supply it; every other entry, the system prompt, and the messages
      // stay byte-identical. No mutable global is touched.
      requestHumanAssistance: {
        ...catalogContext,
        senderId: input.senderId,
        ...(inboundEvent === undefined ? {} : { inboundEvent }),
      },
    };

    for (const name of ['searchCatalog', 'checkStock']) {
      if (input.tools !== null && name in input.tools)
        toolsContext[name] = catalogContext;
    }

    // SQ-5B2B3: the price-stripped `getShippingQuote` tool also declares
    // `contextSchema: z.object({ senderId })`. The AI-SDK validates that
    // every tool with a contextSchema has a matching map entry, so add it
    // ONLY when the tool is actually present in this run's ToolSet.
    if (input.tools !== null && 'getShippingQuote' in input.tools) {
      toolsContext.getShippingQuote = { senderId: input.senderId };
    }
    const diagnostic = catalogDiagnostic(this.logger);
    let result: Awaited<ReturnType<GenerateTextFn>>;
    try {
      result = await this.generateTextFn({
        model: openai(this.modelId),
        // SDK 7 rejects system roles in messages; keep evidence out of history.
        ...(input.catalogEvidence
          ? {
              instructions: [
                { role: 'system', content: input.systemPrompt },
                { role: 'system', content: input.catalogEvidence },
              ],
            }
          : { system: input.systemPrompt }),
        messages,
        tools: input.tools as never,
        toolsContext,
        stopWhen: stepCountIs(this.maxSteps),
        onStepFinish: diagnostic.onStepFinish,
        onToolExecutionEnd: diagnostic.onToolExecutionEnd,
      } as never);
    } catch (error) {
      diagnostic.finish('run_failed');
      throw error;
    }
    diagnostic.finish('run_completed');

    const usage = {
      promptTokens: result.usage?.inputTokens ?? 0,
      completionTokens: result.usage?.outputTokens ?? 0,
    };

    return {
      reply: result.text,
      messages: assembleAgentMessages(input.history, input.text, result.text),
      usage,
    };
  }
}

// Temporary, local-only observation. Never serialize SDK objects or array items.
function catalogDiagnostic(logger: Logger) {
  let runId: string;
  let observedSteps = 0;
  let toolCalls = 0;
  let observationComplete = true;
  const observe = (action: () => void) => {
    try {
      action();
    } catch {
      observationComplete = false;
    }
  };
  observe(() => {
    runId = randomUUID();
  });
  const emit = (fields: Record<string, string | number | boolean | null>) => {
    if (runId) logger.log({ prefix: 'catalog_diagnostic', runId, ...fields });
  };
  const arrayLength = (value: unknown): number => {
    if (!Array.isArray(value)) throw new Error('invalid observation');
    const count = value.length;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('invalid observation');
    }
    return count;
  };
  // Fixed registry allowlist; never copy a dynamic tool name.
  const toolNameOf = (name: unknown) => {
    if (name === 'searchCatalog') return 'searchCatalog';
    if (name === 'checkStock') return 'checkStock';
    if (name === 'requestHumanAssistance') return 'requestHumanAssistance';
    if (name === 'evaluateCart') return 'evaluateCart';
    if (name === 'getCustomerByPhone') return 'getCustomerByPhone';
    if (name === 'upsertCustomer') return 'upsertCustomer';
    if (name === 'createSale') return 'createSale';
    if (name === 'attachReceipt') return 'attachReceipt';
    if (name === 'updateDelivery') return 'updateDelivery';
    if (name === 'getOrderHistory') return 'getOrderHistory';
    if (name === 'getPaymentDetails') return 'getPaymentDetails';
    if (name === 'cancelSale') return 'cancelSale';
    if (name === 'getShippingQuote') return 'getShippingQuote';
    observationComplete = false;
    return 'other';
  };
  const envelope = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const outcomeOf = (name: string, result: unknown): string => {
    // Only envelope discriminators: not domain validation or proof of delivery.
    const ok = envelope(result).ok;
    if (name !== 'checkStock' && name !== 'requestHumanAssistance') {
      if (ok === true) return 'returned_ok';
      return ok === false ? 'returned_error' : 'unknown_output';
    }
    if (ok === false) {
      const kind = envelope(envelope(result).error).kind;
      if (typeof kind !== 'string') return 'unknown_output';
      if (name === 'requestHumanAssistance') {
        if (kind === 'disabled') return 'disabled';
        if (kind === 'restock_unavailable') return 'restock_unavailable';
      }
      return 'returned_error';
    }
    if (ok !== true) return 'unknown_output';
    if (name === 'checkStock') {
      const assistance = envelope(result).humanAssistance;
      if (assistance !== undefined) {
        return envelope(assistance).kind === 'out_of_stock'
          ? 'out_of_stock_signal'
          : 'unknown_output';
      }
      const status = envelope(envelope(result).stock).status;
      return status === 'available' ||
        status === 'low_stock' ||
        status === 'out_of_stock' ||
        status === 'not_managed'
        ? 'success'
        : 'unknown_output';
    }
    if (name === 'requestHumanAssistance') {
      const outcome = envelope(result).outcome;
      const notified = envelope(result).customerNotified;
      if (outcome === 'historical_intake_recorded' && notified === false) {
        return 'historical_intake_recorded';
      }
      if (outcome === undefined && notified === true)
        return 'legacy_customer_notified';
    }
    return 'unknown_output';
  };
  return {
    onStepFinish: (event: { toolCalls: unknown }) =>
      observe(() => {
        const calls = event.toolCalls;
        const count = arrayLength(calls);
        observedSteps += 1;
        toolCalls += count;
        const truncated = count > 16;
        if (truncated) observationComplete = false;
        for (let index = 0; index < Math.min(count, 16); index += 1) {
          let toolName = 'other';
          observe(() => {
            toolName = toolNameOf(
              envelope((calls as unknown[])[index]).toolName,
            );
          });
          observe(() => emit({ event: 'tool_requested', toolName, truncated }));
        }
      }),
    onToolExecutionEnd: (event: ToolExecutionEndEvent) =>
      observe(() => {
        let toolName = 'other';
        observe(() => {
          toolName = toolNameOf(event.toolCall.toolName);
        });
        if (toolName !== 'searchCatalog') {
          let category = 'unknown_output';
          observe(() => {
            if (toolName === 'other') return;
            const output = event.toolOutput;
            if (output.type === 'tool-error') category = 'execution_error';
            if (output.type === 'tool-result')
              category = outcomeOf(toolName, output.output);
          });
          if (category === 'unknown_output') observationComplete = false;
          emit({ event: 'tool_execution_end', toolName, category });
          return;
        }
        const toolOutput = event.toolOutput;
        let category = 'unknown_output';
        let resultCount: number | undefined;
        if (toolOutput.type === 'tool-error') category = 'execution_error';
        if (toolOutput.type === 'tool-result') {
          const output = toolOutput.output as {
            ok?: unknown;
            results?: unknown;
          } | null;
          if (output?.ok === false) category = 'mapped_error';
          else if (output?.ok === true && Array.isArray(output.results)) {
            resultCount = arrayLength(output.results);
            category = 'success';
          }
        }
        if (category === 'unknown_output') observationComplete = false;
        emit({
          event: 'search_catalog_end',
          category,
          ...(resultCount === undefined ? {} : { resultCount }),
        });
      }),
    finish: (event: 'run_completed' | 'run_failed') =>
      observe(() => {
        observationComplete &&= observedSteps > 0 && event === 'run_completed';
        emit({
          event,
          observedSteps,
          toolCalls: observationComplete ? toolCalls : null,
          observationComplete,
        });
      }),
  };
}

/**
 * Return a frozen copy of the caller-supplied RESTOCK inbound identity, or
 * `undefined` when it is absent or fails the strict, sender-matching gate.
 * Mirrors the runner's gate so the adapter can never widen what reaches the SDK.
 */
function forwardableInboundEvent(
  input: LlmRunInput,
): LlmRunInput['inboundEvent'] {
  try {
    // Accessing `input.inboundEvent` may itself throw (a hostile getter on the
    // caller's object). The shared binder checks a second raw read against
    // the original derived id, then forwards only a frozen copy.
    const bound = bindRestockInboundEvent(input.inboundEvent, input.senderId);
    return bound === null ? undefined : bound.event;
  } catch {
    return undefined;
  }
}

/**
 * Convert the agent-domain AgentMessage[] into AI-SDK ModelMessage[].
 * The runner passes the new user text as a separate argument so the
 * adapter appends it without needing to mutate the caller's array.
 */
function assembleModelMessages(
  history: AgentMessage[],
  userText: string,
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const msg of history) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      out.push({ role: 'assistant', content: msg.content });
    } else if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId,
            toolName: 'unknown',
            output: msg.content as never,
          },
        ],
      });
    }
  }

  out.push({ role: 'user', content: userText });
  return out;
}

/**
 * Build the AgentMessage[] returned to the runner. We trust the SDK
 * result's text as the assistant reply; we do NOT replay tool steps
 * into the agent-domain union (that round-trip happens at the runner
 * level once catalog / cart / order tools land).
 */
function assembleAgentMessages(
  history: AgentMessage[],
  userText: string,
  assistantText: string,
): AgentMessage[] {
  return [
    ...history,
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ];
}
