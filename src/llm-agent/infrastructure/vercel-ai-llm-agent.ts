import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stepCountIs } from 'ai';
import type { ModelMessage, ToolExecutionEndEvent } from 'ai';
import { openai } from '@ai-sdk/openai';
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
    // toolsContext — per-tool runtime values the LLM must NOT see in
    // the prompt. The cart-touching tools (evaluateCart, createSale)
    // declare `contextSchema: z.object({ senderId: z.string() })` and
    // receive `options.context.senderId` inside `execute`. Stateless
    // tools don't appear here — the SDK only requires an entry for
    // tools that declare a contextSchema.
    const inboundEvent = forwardableInboundEvent(input);
    const toolsContext: Record<
      string,
      { senderId: string; inboundEvent?: LlmRunInput['inboundEvent'] }
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
        senderId: input.senderId,
        ...(inboundEvent === undefined ? {} : { inboundEvent }),
      },
    };

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
        system: input.systemPrompt,
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
  return {
    onStepFinish: (event: { toolCalls: unknown }) =>
      observe(() => {
        const count = arrayLength(event.toolCalls);
        observedSteps += 1;
        toolCalls += count;
      }),
    onToolExecutionEnd: (event: ToolExecutionEndEvent) =>
      observe(() => {
        if (event.toolCall.toolName !== 'searchCatalog') return;
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
