import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stepCountIs } from 'ai';
import type { ModelMessage, ToolExecutionEndEvent } from 'ai';
import { openai } from '@ai-sdk/openai';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';
import type { AgentMessage } from '../domain/agent-message';
import {
  InventoryEvidenceGuard,
  isNonMutatingToolName,
  type InventoryCallEvidence,
  type InventoryCallState,
} from '../domain/inventory-evidence.guard';
import type {
  LlmAgentPort,
  LlmRunInput,
  LlmRunResult,
} from '../domain/llm-agent.port';
import { GENERATE_TEXT, type GenerateTextFn } from './generate-text.provider';

/**
 * Truthful, inventory-unconfirmed reply used ONLY when a stock failure is
 * unresolved and no mutating tool could have had effects. It never claims
 * availability, exhaustion, or an early closure.
 */
export const INVENTORY_UNCONFIRMED_REPLY =
  'En este momento no pude confirmar las existencias reales de ese producto. ' +
  'Para no darle un dato equivocado, todavía no puedo asegurarle si está disponible ' +
  'ni si está agotado. ¿Desea que lo revise de nuevo o que alguien del equipo lo confirme con usted?';

/** Automatic denial reason for a mutating sibling of checkStock in one batch. */
export const STOCK_FIRST_DENIAL_REASON =
  'Complete the stock check first and call this tool again in a later step.';

export type SeparationDecision = 'denied' | 'not-applicable';

/**
 * Run-local gate that separates mutating tool calls from a `checkStock` batch.
 *
 * The installed SDK resolves each tool approval in isolation and does not
 * expose the sibling tool calls of the same model call, so the gate keeps a
 * run-local map captured from `onLanguageModelCallEnd` (before any client
 * execution). Approval is then decided against that map. Missing, malformed,
 * or stale metadata fails closed for mutating/unknown names, and the injected
 * `isUnresolved` predicate hard-denies them while a stock subject lacks an
 * authoritative answer (even in a batch that has no `checkStock` sibling).
 */
export interface InventorySeparationGate {
  /** Replace the run-local batch metadata with this model call's tool calls. */
  capture(event: unknown): void;
  /** Decide whether a single tool call may execute. */
  approve(toolCall: unknown): SeparationDecision;
  /** Forget all batch metadata (fail closed until the next capture). */
  reset(): void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read the tool-call names of one completed model call. Returns `null` when
 * the event shape is missing or malformed so the caller defaults to denial.
 */
function readBatchMetadata(
  event: unknown,
): { byToolCallId: Map<string, string>; hasCheckStock: boolean } | null {
  const content = asRecord(event)?.content;
  if (!Array.isArray(content)) return null;
  const byToolCallId = new Map<string, string>();
  let hasCheckStock = false;
  for (const part of content) {
    const record = asRecord(part);
    if (record === null || record.type !== 'tool-call') continue;
    const toolCallId = record.toolCallId;
    const toolName = record.toolName;
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') {
      return null;
    }
    byToolCallId.set(toolCallId, toolName);
    if (toolName === 'checkStock') hasCheckStock = true;
  }
  if (byToolCallId.size === 0) return null;
  return { byToolCallId, hasCheckStock };
}

export function createInventorySeparationGate(
  isUnresolved: () => boolean = () => false,
): InventorySeparationGate {
  let batchByToolCallId: Map<string, string> | null = null;
  let batchHasCheckStock = false;
  return {
    capture(event: unknown) {
      // Clear first: a throwing or hostile event must not leave stale authority.
      batchByToolCallId = null;
      batchHasCheckStock = false;
      try {
        const metadata = readBatchMetadata(event);
        if (metadata !== null) {
          batchByToolCallId = metadata.byToolCallId;
          batchHasCheckStock = metadata.hasCheckStock;
        }
      } catch {
        batchByToolCallId = null;
        batchHasCheckStock = false;
      }
    },
    approve(toolCall: unknown) {
      const record = asRecord(toolCall);
      const toolName = record?.toolName;
      if (typeof toolName !== 'string') return 'denied';
      if (isNonMutatingToolName(toolName)) return 'not-applicable';
      // Mutating or unknown name: hard-deny while any stock subject is
      // unresolved, regardless of this batch's siblings, so a later
      // mutation-only batch can never hide a failed check. The SDK parses
      // and executes against the full tool set even when `activeTools` hides
      // the tool from the provider presentation.
      if (isUnresolved()) return 'denied';
      const toolCallId = record?.toolCallId;
      const batch = batchByToolCallId;
      if (
        batch === null ||
        typeof toolCallId !== 'string' ||
        !batch.has(toolCallId)
      ) {
        // Missing, malformed, or stale batch metadata: fail closed.
        return 'denied';
      }
      return batchHasCheckStock ? 'denied' : 'not-applicable';
    },
    reset() {
      batchByToolCallId = null;
      batchHasCheckStock = false;
    },
  };
}

/** Map one completed SDK step into the guard's SDK-agnostic evidence shape. */
function extractInventoryCalls(step: unknown): InventoryCallEvidence[] {
  const content = asRecord(step)?.content;
  if (!Array.isArray(content)) return [];
  const outcomes = new Map<
    string,
    { state: InventoryCallState; output?: unknown }
  >();
  const calls: InventoryCallEvidence[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record === null) continue;
    if (record.type === 'tool-call') {
      const toolCallId = record.toolCallId;
      const toolName = record.toolName;
      if (typeof toolCallId === 'string' && typeof toolName === 'string') {
        calls.push({
          toolCallId,
          toolName,
          input: record.input,
          state: 'unaccounted',
        });
      }
    } else if (record.type === 'tool-result') {
      const toolCallId = record.toolCallId;
      if (typeof toolCallId === 'string') {
        outcomes.set(toolCallId, { state: 'result', output: record.output });
      }
    } else if (record.type === 'tool-error') {
      const toolCallId = record.toolCallId;
      if (typeof toolCallId === 'string') {
        outcomes.set(toolCallId, { state: 'error' });
      }
    } else if (
      record.type === 'tool-approval-response' &&
      record.approved === false
    ) {
      const toolCallId = asRecord(record.toolCall)?.toolCallId;
      if (typeof toolCallId === 'string') {
        outcomes.set(toolCallId, { state: 'denied' });
      }
    }
  }
  return calls.map((call) => {
    const outcome = outcomes.get(call.toolCallId);
    return outcome === undefined ? call : { ...call, ...outcome };
  });
}

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
    const guard = new InventoryEvidenceGuard();
    const separation = createInventorySeparationGate(() =>
      guard.hasUnresolvedStockFailure(),
    );
    const nonMutatingActiveTools = Object.keys(input.tools ?? {}).filter(
      isNonMutatingToolName,
    );
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
        // Batch metadata is captured BEFORE any approval/execution and the
        // generic approval runs against it (the SDK never shows siblings).
        onLanguageModelCallEnd: (event: unknown) => separation.capture(event),
        toolApproval: (options: unknown) =>
          separation.approve(asRecord(options)?.toolCall) === 'denied'
            ? { type: 'denied' as const, reason: STOCK_FIRST_DENIAL_REASON }
            : { type: 'not-applicable' as const },
        // While a stock failure is unresolved, hide mutating tools from the
        // model; a verified same-subject recovery restores the full set.
        prepareStep: () =>
          guard.hasUnresolvedStockFailure()
            ? { activeTools: nonMutatingActiveTools }
            : undefined,
        onStepFinish: (step: unknown) => {
          guard.recordStep(extractInventoryCalls(step));
          diagnostic.onStepFinish(step as { toolCalls: unknown });
        },
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

    // Conservative reply override: ONLY an unresolved stock failure with no
    // earlier executed mutation is replaced. Any mutating execution (even an
    // ambiguous error return) preserves the model reply to avoid hiding effects.
    const reply =
      guard.hasUnresolvedStockFailure() && !guard.hasExecutedMutation()
        ? INVENTORY_UNCONFIRMED_REPLY
        : result.text;

    return {
      reply,
      messages: assembleAgentMessages(input.history, input.text, reply),
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
      if (outcome === 'existing_restock_recorded' && notified === false) {
        const status = envelope(result).status;
        if (
          status === 'pending' ||
          status === 'response_recorded' ||
          status === 'stale' ||
          status === 'current_status_unknown'
        ) {
          return 'existing_receipt';
        }
        return 'unknown_output';
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
