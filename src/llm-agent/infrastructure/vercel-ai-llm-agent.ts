import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ModelMessage, ToolExecutionEndEvent } from 'ai';
import { stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';
import type { AgentMessage } from '../domain/agent-message';
import {
  InventoryEvidenceGuard,
  isNonMutatingToolName,
  type InventoryCallEvidence,
} from '../domain/inventory-evidence.guard';
import {
  UNBOUND_STOCK_REPLY,
  StockReadEvidence,
  type AdmittedToolCall,
  type StockReadExecutionObserver,
  type StockReadSubject,
} from '../domain/stock-read-evidence';
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

/**
 * Pre-execution denial reason for the final configured step. That step is
 * reserved for rendering a reply only; even when the provider ignores the
 * tool-free presentation, an emitted tool call must never execute.
 */
export const FINAL_RENDER_DENIAL_REASON =
  'The final step is reserved for the reply; no tool may execute.';

/**
 * Pre-execution denial reason used when a step's frozen approval frame is
 * missing or malformed. Without the authentic step the adapter cannot prove
 * the call is not a final render slot, so it fails closed.
 */
export const STOCK_CONTEXT_DENIAL_REASON =
  'The stock step context is unavailable; no tool may execute.';

export type SeparationDecision = 'denied' | 'not-applicable';

/** Local shape of `prepareStep` options the adapter reads (SDK-versioned). */
interface PrepareStepOptions {
  stepNumber: number;
  toolsContext?: Record<string, Record<string, unknown>>;
}

/** Local shape of `toolApproval` options the adapter reads (SDK-versioned). */
interface ToolApprovalOptions {
  toolCall?: unknown;
  toolsContext?: Record<string, Record<string, unknown>>;
  runtimeContext?: unknown;
}

/**
 * Run-local gate that separates mutating tool calls from a `checkStock` batch.
 *
 * The installed SDK resolves each tool approval in isolation and does not
 * expose the sibling tool calls of the same model call, so the gate keeps a
 * run-local map captured from `onLanguageModelCallEnd` (before any client
 * execution). Approval is then decided against that map. A call is authorized
 * only when its captured identity is UNIQUE and its name and input
 * structurally equal the approval call; missing, duplicated, malformed, or
 * stale metadata fails closed for mutating/unknown names, and the injected
 * `isUnresolved` predicate hard-denies them while a stock subject lacks an
 * authoritative answer (even in a batch that has no `checkStock` sibling).
 */
export interface InventorySeparationGate {
  /** Replace the run-local batch metadata with this model call's tool calls. */
  capture(event: unknown): void;
  /** Decide whether a single tool call may execute. */
  approve(toolCall: unknown): SeparationDecision;
  /**
   * True when the captured batch already contains a `checkStock` call for
   * this tool call. Used to keep the hard same-batch denial even when the
   * narrow RESTOCK exception would otherwise apply.
   */
  hasStockSibling(toolCall: unknown): boolean;
  /**
   * True only when the captured batch holds exactly one call for this id whose
   * tool name matches and whose input structurally equals the approval input.
   * The narrow RESTOCK exception is validated against this before it can
   * override the fail-closed unresolved-read denial.
   */
  captured(toolCall: unknown): boolean;
  /** Forget all batch metadata (fail closed until the next capture). */
  reset(): void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parsed captured input, or a failure marker when a string is not JSON. */
interface ParsedCallInput {
  ok: boolean;
  value: unknown;
}

function parseCallInput(value: unknown): ParsedCallInput {
  if (typeof value !== 'string') return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * Structural comparison that tolerates a serialized captured input and a
 * parsed approval input without string-to-object comparison or property-order
 * sensitivity. An unparseable string never matches.
 */
function callInputsMatch(captured: unknown, approval: unknown): boolean {
  const left = parseCallInput(captured);
  const right = parseCallInput(approval);
  if (!left.ok || !right.ok) return false;
  return isDeepStrictEqual(left.value, right.value);
}

interface CapturedBatchCall {
  toolName: string;
  input: unknown;
}

interface CapturedBatch {
  callsById: Map<string, CapturedBatchCall[]>;
  hasCheckStock: boolean;
}

/**
 * Read every captured tool-call identity of one model call. A call id that is
 * missing or paired with a non-string name marks the whole batch malformed so
 * the caller defaults to denial. Duplicate ids are retained, never collapsed,
 * so a duplicate can never act as a unique authority.
 */
function readBatchMetadata(event: unknown): CapturedBatch | null {
  const content = asRecord(event)?.content;
  if (!Array.isArray(content)) return null;
  const callsById = new Map<string, CapturedBatchCall[]>();
  let hasCheckStock = false;
  for (const part of content) {
    const record = asRecord(part);
    if (record === null || record.type !== 'tool-call') continue;
    const toolCallId = record.toolCallId;
    const toolName = record.toolName;
    if (
      typeof toolCallId !== 'string' ||
      toolCallId.length === 0 ||
      typeof toolName !== 'string' ||
      toolName.length === 0
    ) {
      return null;
    }
    const call = { toolName, input: record.input };
    const list = callsById.get(toolCallId);
    if (list === undefined) callsById.set(toolCallId, [call]);
    else list.push(call);
    if (toolName === 'checkStock') hasCheckStock = true;
  }
  if (callsById.size === 0) return null;
  return { callsById, hasCheckStock };
}

/** The single captured call for an id, or `null` when ambiguous/absent. */
function uniqueCapturedCall(
  batch: CapturedBatch | null,
  toolCallId: unknown,
): CapturedBatchCall | null {
  if (batch === null || typeof toolCallId !== 'string') return null;
  const list = batch.callsById.get(toolCallId);
  if (list === undefined || list.length !== 1) return null;
  return list[0];
}

export function createInventorySeparationGate(
  isUnresolved: () => boolean = () => false,
): InventorySeparationGate {
  let batch: CapturedBatch | null = null;
  return {
    capture(event: unknown) {
      // Clear first: a throwing or hostile event must not leave stale authority.
      batch = null;
      try {
        const metadata = readBatchMetadata(event);
        if (metadata !== null) batch = metadata;
      } catch {
        batch = null;
      }
    },
    approve(toolCall: unknown) {
      const record = asRecord(toolCall);
      const toolName = record?.toolName;
      if (typeof toolName !== 'string' || toolName.length === 0) {
        return 'denied';
      }
      if (isNonMutatingToolName(toolName)) return 'not-applicable';
      // Mutating or unknown name: hard-deny while any stock subject is
      // unresolved, regardless of this batch's siblings, so a later
      // mutation-only batch can never hide a failed check. The SDK parses
      // and executes against the full tool set even when `activeTools` hides
      // the tool from the provider presentation.
      if (isUnresolved()) return 'denied';
      const captured = uniqueCapturedCall(batch, record?.toolCallId);
      if (
        captured === null ||
        captured.toolName !== toolName ||
        !callInputsMatch(captured.input, record?.input)
      ) {
        // Missing, malformed, duplicated, or stale metadata: fail closed.
        return 'denied';
      }
      return batch !== null && batch.hasCheckStock
        ? 'denied'
        : 'not-applicable';
    },
    hasStockSibling(toolCall: unknown) {
      const captured = uniqueCapturedCall(
        batch,
        asRecord(toolCall)?.toolCallId,
      );
      if (captured === null) return true;
      return batch !== null && batch.hasCheckStock;
    },
    captured(toolCall: unknown) {
      const record = asRecord(toolCall);
      const toolName = record?.toolName;
      const captured = uniqueCapturedCall(batch, record?.toolCallId);
      if (captured === null || typeof toolName !== 'string') return false;
      if (captured.toolName !== toolName) return false;
      return callInputsMatch(captured.input, record?.input);
    },
    reset() {
      batch = null;
    },
  };
}

/**
 * Choose the outgoing reply.
 *
 * A possible effect (any executed non-read-only tool) ALWAYS preserves the
 * model reply verbatim, so an effect is never hidden. This includes an empty
 * `result.text`; masking an executed or ambiguous write with stock copy is a
 * worse outcome than an empty reply, so the empty-string limitation is
 * deliberate and documented rather than silently "fixed".
 *
 * With nothing executed, a stock read that produced ONLY unbound failures asks
 * for an explicit canonical product/presentation choice (the generic fallback
 * when no valid catalog snapshot can render one). Otherwise the current-turn
 * trusted stock projection wins; the conservative generic fallback still
 * covers a residual unresolved failure, and a clean read-free run keeps
 * ordinary model behavior.
 */
function selectReply(
  fallback: string,
  guard: InventoryEvidenceGuard,
  evidence: StockReadEvidence,
  catalogSession: CatalogSession | undefined,
): string {
  if (guard.hasExecutedMutation()) return fallback;
  if (evidence.hasOnlyUnboundFailures()) {
    return catalogSession?.selectionPrompt() ?? UNBOUND_STOCK_REPLY;
  }
  const projected = evidence.projectStockFacts();
  if (projected !== null) return projected;
  if (guard.hasUnresolvedStockFailure()) return INVENTORY_UNCONFIRMED_REPLY;
  return fallback;
}

/** Map adapter call evidence into the ledger's completion shape. */
function admittedCalls(
  calls: readonly InventoryCallEvidence[],
): AdmittedToolCall[] {
  return calls.map((call) => ({
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    outcome:
      call.state === 'result'
        ? 'result'
        : call.state === 'error'
          ? 'error'
          : call.state === 'denied'
            ? 'denied'
            : 'unaccounted',
    // The normalized SDK completion terminal travels with the call so the
    // ledger can cross-check it against the private receipt. The property is
    // always present on adapter-mapped calls, so a result carrying an
    // `undefined` terminal is a present-but-unusable value, never a bypass.
    output: call.output,
  }));
}

/**
 * Downgrade every SDK `result` terminal that private authority cannot
 * corroborate. A `checkStock` result may clear the conservative guard ONLY
 * when the ledger already admitted a CURRENT-step verified fact for the exact
 * requested subject; every other result becomes `unaccounted` (never a
 * fabricated backend error) while keeping its id/input, so it still revokes
 * the old subject. Non-stock calls pass through untouched, so a possible
 * effect is never hidden or downgraded.
 */
function guardCallsForStep(
  calls: readonly InventoryCallEvidence[],
  evidence: StockReadEvidence,
  step: number | null,
): InventoryCallEvidence[] {
  return calls.map((call) => {
    if (call.toolName !== 'checkStock' || call.state !== 'result') return call;
    if (step !== null && evidence.hasCurrentVerifiedSubject(call.input, step)) {
      return call;
    }
    return { ...call, state: 'unaccounted' as const, output: undefined };
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The one narrow RESTOCK exception: allow `requestHumanAssistance` with
 * `kind: 'out_of_stock'` through the unresolved-read denial ONLY when its
 * parsed digest exactly matches a prior-completed ledger shortage for the
 * same productId/variantId and the backend product name. It grants no write;
 * the tool's own fresh preflight, reservation and idempotency stay final.
 */
function matchesPriorShortage(
  toolCall: unknown,
  evidence: StockReadEvidence,
  step: number,
): boolean {
  const record = asRecord(toolCall);
  if (record?.toolName !== 'requestHumanAssistance') return false;
  const input = asRecord(record.input);
  if (input?.kind !== 'out_of_stock') return false;
  const digest = asRecord(input.digest);
  if (digest === null) return false;
  if (!isNonEmptyString(digest.productId)) return false;
  let variantId: string | null = null;
  const rawVariant = digest.variantId;
  if (rawVariant !== undefined && rawVariant !== null) {
    if (!isNonEmptyString(rawVariant)) return false;
    variantId = rawVariant;
  }
  if (!isNonEmptyString(digest.name)) return false;
  const subject: StockReadSubject = { productId: digest.productId, variantId };
  const shortage = evidence.getLatestVerifiedShortage(subject, step);
  return shortage !== null && shortage.productName === digest.name;
}

/**
 * Frozen per-step frame carried in the SDK `runtimeContext`. It is independent
 * of any tool registration, so the render-slot protection holds even when
 * `checkStock` is absent from the run's tool set. The installed SDK replaces
 * `runtimeContext` with the value `prepareStep` returns before it resolves
 * this step's approvals (ai 7 `generate-text.ts`).
 */
interface StockStepFrame {
  readonly kind: 'stock-read-step';
  readonly serverTurnId: string;
  readonly step: number;
}

function createStockStepFrame(
  serverTurnId: string,
  step: number,
): StockStepFrame {
  return Object.freeze({ kind: 'stock-read-step', serverTurnId, step });
}

/** Read the authentic step from the frozen frame, or `null` when malformed. */
function stockStepFrom(runtimeContext: unknown): number | null {
  const frame = asRecord(runtimeContext);
  if (frame === null || frame.kind !== 'stock-read-step') return null;
  const step = frame.step;
  return typeof step === 'number' && Number.isSafeInteger(step) && step >= 0
    ? step
    : null;
}

/**
 * Clone the per-step toolsContext, preserving every existing entry, and bind
 * an immutable observer for `checkStock`. The observer's `recordExecution` is
 * an arrow so the S3b binder cannot steal `this` from the evidence instance.
 */
function withStockObserver(
  toolsContext: unknown,
  observer: StockReadExecutionObserver,
  hasCheckStock: boolean,
): Record<string, unknown> {
  const base = asRecord(toolsContext);
  const clone: Record<string, unknown> = base === null ? {} : { ...base };
  if (hasCheckStock) {
    const existing = asRecord(clone['checkStock']) ?? {};
    clone['checkStock'] = { ...existing, stockReadObserver: observer };
  }
  return clone;
}

/** One parsed tool call of a completed step, from the authoritative surface. */
interface StepCallInstance {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid: boolean;
  dynamic: boolean;
  providerExecuted: boolean;
}

/** One terminal record: an executed result/error or a refusal. */
interface StepCallTerminal {
  state: 'result' | 'error' | 'denied';
  output?: unknown;
  toolName: unknown;
  input: unknown;
}

/** Observation bound mirrored from the diagnostic observer (16 entries). */
const MAX_STEP_CALLS = 16;

function readContentCalls(content: unknown[]): {
  byId: Map<string, Array<{ toolName: string; input: unknown }>>;
  order: string[];
} {
  const byId = new Map<string, Array<{ toolName: string; input: unknown }>>();
  const order: string[] = [];
  for (const part of content) {
    const entry = asRecord(part);
    if (entry === null || entry.type !== 'tool-call') continue;
    const toolCallId = entry.toolCallId;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) continue;
    const value = {
      toolName: typeof entry.toolName === 'string' ? entry.toolName : '',
      input: entry.input,
    };
    const list = byId.get(toolCallId);
    if (list === undefined) {
      byId.set(toolCallId, [value]);
      order.push(toolCallId);
    } else {
      list.push(value);
    }
  }
  return { byId, order };
}

function readContentTerminals(
  content: unknown[],
): Map<string, StepCallTerminal[]> {
  const terminals = new Map<string, StepCallTerminal[]>();
  const push = (id: string, terminal: StepCallTerminal) => {
    const list = terminals.get(id);
    if (list === undefined) terminals.set(id, [terminal]);
    else list.push(terminal);
  };
  for (const part of content) {
    const entry = asRecord(part);
    if (entry === null) continue;
    if (entry.type === 'tool-result' || entry.type === 'tool-error') {
      const id = entry.toolCallId;
      if (typeof id !== 'string' || id.length === 0) continue;
      push(id, {
        state: entry.type === 'tool-result' ? 'result' : 'error',
        output: entry.type === 'tool-result' ? entry.output : undefined,
        toolName: entry.toolName,
        input: entry.input,
      });
      continue;
    }
    if (entry.type === 'tool-approval-response' && entry.approved === false) {
      const id = asRecord(entry.toolCall)?.toolCallId;
      if (typeof id !== 'string' || id.length === 0) continue;
      push(id, { state: 'denied', toolName: undefined, input: undefined });
    }
  }
  return terminals;
}

/**
 * Correlate one parsed call with exactly one matching content call and exactly
 * one matching terminal. Any ambiguity rejects the call as `unaccounted` (never
 * a fabricated error), so a malformed completion can only revoke, never verify.
 */
function correlateInstance(
  instance: StepCallInstance,
  contentCalls: Map<string, Array<{ toolName: string; input: unknown }>>,
  terminals: Map<string, StepCallTerminal[]>,
): InventoryCallEvidence {
  const base = {
    toolCallId: instance.toolCallId,
    toolName: instance.toolName,
    input: instance.input,
  };
  if (instance.invalid || instance.dynamic || instance.providerExecuted) {
    return { ...base, state: 'unaccounted' };
  }
  const contentList = contentCalls.get(instance.toolCallId);
  if (contentList === undefined || contentList.length !== 1) {
    // A call absent from the captured content, or duplicated there, cannot be
    // reconciled to a single call surface. Count it, but never verify it.
    return { ...base, state: 'unaccounted' };
  }
  const contentCall = contentList[0];
  if (contentCall.toolName !== instance.toolName) {
    return { ...base, state: 'unaccounted' };
  }
  if (!callInputsMatch(contentCall.input, instance.input)) {
    return { ...base, state: 'unaccounted' };
  }
  const terminalList = terminals.get(instance.toolCallId);
  if (terminalList === undefined || terminalList.length !== 1) {
    return { ...base, state: 'unaccounted' };
  }
  const terminal = terminalList[0];
  if (
    typeof terminal.toolName === 'string' &&
    terminal.toolName !== instance.toolName
  ) {
    return { ...base, state: 'unaccounted' };
  }
  if (
    terminal.input !== undefined &&
    !callInputsMatch(terminal.input, instance.input)
  ) {
    return { ...base, state: 'unaccounted' };
  }
  if (terminal.state === 'denied') return { ...base, state: 'denied' };
  if (terminal.state === 'error') return { ...base, state: 'error' };
  return { ...base, state: 'result', output: terminal.output };
}

/**
 * Strictly correlate one completed SDK step into the guard/ledger call shape.
 *
 * The parsed `step.toolCalls` surface is authoritative; content tool-call
 * parts, and every content-only or terminal-only id, are cross-checked against
 * it so no call id from ANY surface is silently dropped. The SDK derives
 * `step.toolCalls` from the same content it hands to this adapter, so a genuine
 * step reconciles exactly and a crafted one fails closed.
 */
function correlateStepCalls(step: unknown): InventoryCallEvidence[] {
  try {
    const record = asRecord(step);
    if (record === null) return [];
    const instances: StepCallInstance[] = [];
    const rawToolCalls = record.toolCalls;
    if (Array.isArray(rawToolCalls)) {
      // Bound the read exactly like the diagnostic observer: never touch a
      // metadata index beyond the accepted window. A step that exceeds the
      // bound is treated conservatively as a possible effect.
      const limit = Math.min(rawToolCalls.length, MAX_STEP_CALLS);
      for (let index = 0; index < limit; index += 1) {
        const call = asRecord(rawToolCalls[index]);
        if (call === null) continue;
        const toolCallId = call.toolCallId;
        const toolName = call.toolName;
        if (typeof toolCallId !== 'string' || toolCallId.length === 0) continue;
        if (typeof toolName !== 'string' || toolName.length === 0) continue;
        instances.push({
          toolCallId,
          toolName,
          input: call.input,
          invalid: call.invalid === true,
          dynamic: call.dynamic === true,
          providerExecuted: call.providerExecuted === true,
        });
      }
      if (rawToolCalls.length > MAX_STEP_CALLS) {
        instances.push({
          toolCallId: 'unobserved-overflow',
          toolName: 'unobserved',
          input: undefined,
          invalid: true,
          dynamic: false,
          providerExecuted: false,
        });
      }
    }

    const rawContent = record.content;
    const contentArgs = Array.isArray(rawContent) ? rawContent : [];
    const contentCalls = readContentCalls(contentArgs);
    const terminals = readContentTerminals(contentArgs);

    const calls: InventoryCallEvidence[] = [];
    const accounted = new Set<string>();
    for (const instance of instances) {
      accounted.add(instance.toolCallId);
      calls.push(correlateInstance(instance, contentCalls.byId, terminals));
    }
    const foreign = new Set<string>();
    for (const id of contentCalls.order) {
      if (accounted.has(id) || foreign.has(id)) continue;
      foreign.add(id);
      const first = contentCalls.byId.get(id)?.[0];
      calls.push({
        toolCallId: id,
        toolName: first?.toolName ?? '',
        input: first?.input,
        state: 'unaccounted',
      });
    }
    for (const [id, list] of terminals) {
      if (accounted.has(id) || foreign.has(id)) continue;
      foreign.add(id);
      const first = list[0];
      calls.push({
        toolCallId: id,
        toolName: typeof first?.toolName === 'string' ? first.toolName : '',
        input: first?.input,
        state: 'unaccounted',
      });
    }
    return calls;
  } catch {
    // A hostile or malformed step never throws into the SDK's step callback.
    return [];
  }
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
    const sourceTools = input.tools ?? {};
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
      if (name in sourceTools) toolsContext[name] = catalogContext;
    }

    // SQ-5B2B3: the price-stripped `getShippingQuote` tool also declares
    // `contextSchema: z.object({ senderId })`. The AI-SDK validates that
    // every tool with a contextSchema has a matching map entry, so add it
    // ONLY when the tool is actually present in this run's ToolSet.
    if ('getShippingQuote' in sourceTools) {
      toolsContext.getShippingQuote = { senderId: input.senderId };
    }
    const diagnostic = catalogDiagnostic(this.logger);
    const guard = new InventoryEvidenceGuard();
    const serverTurnId = randomUUID();
    const evidence = new StockReadEvidence(serverTurnId);
    const separation = createInventorySeparationGate(() =>
      guard.hasUnresolvedStockFailure(),
    );
    const nonMutatingActiveTools = Object.keys(sourceTools).filter(
      isNonMutatingToolName,
    );
    const hasCheckStock = 'checkStock' in sourceTools;
    // The last configured slot is reserved for a render-only reply. No
    // dynamic budget extension exists, so this is the only place the caller's
    // configured cap is interpreted.
    const finalSlot = Math.max(0, this.maxSteps - 1);

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
        // The caller's tool set is forwarded byte-identically. No wrapper
        // rewrites arguments, so a failed read can never become another
        // product's read.
        tools: sourceTools as never,
        toolsContext,
        // The caller's configured cap is honored exactly.
        stopWhen: stepCountIs(this.maxSteps),
        // Batch metadata is captured BEFORE any approval/execution and the
        // generic approval runs against it (the SDK never shows siblings).
        onLanguageModelCallEnd: (event: unknown) => separation.capture(event),
        toolApproval: (options: ToolApprovalOptions) => {
          const toolCall = options.toolCall;
          // The authentic step is read from the frozen per-step frame the SDK
          // carries in `runtimeContext`. There is no mutable counter and no
          // fallback: a missing or malformed frame fails closed.
          const step = stockStepFrom(options.runtimeContext);
          if (step === null) {
            return {
              type: 'denied' as const,
              reason: STOCK_CONTEXT_DENIAL_REASON,
            };
          }
          // The final configured slot is render-only: even a provider that
          // ignores `activeTools`/`toolChoice` cannot execute an emitted call.
          if (step >= finalSlot) {
            return {
              type: 'denied' as const,
              reason: FINAL_RENDER_DENIAL_REASON,
            };
          }
          if (separation.approve(toolCall) !== 'denied') {
            return { type: 'not-applicable' as const };
          }
          // The same-batch checkStock sibling rule stays absolute. Only the
          // residual unresolved-read denial is narrowed, and only for an
          // exactly matching prior shortage.
          if (
            separation.captured(toolCall) &&
            !separation.hasStockSibling(toolCall) &&
            matchesPriorShortage(toolCall, evidence, step)
          ) {
            return { type: 'not-applicable' as const };
          }
          return { type: 'denied' as const, reason: STOCK_FIRST_DENIAL_REASON };
        },
        prepareStep: (options: PrepareStepOptions) => {
          const frame = createStockStepFrame(serverTurnId, options.stepNumber);
          // A fresh immutable observer per step; the arrow keeps the private
          // evidence `this` even when the S3b tool binder rebinds the function.
          const observer: StockReadExecutionObserver = {
            serverTurnId,
            step: options.stepNumber,
            recordExecution: (receipt) => evidence.recordExecution(receipt),
          };
          Object.freeze(observer);
          const stepToolsContext = withStockObserver(
            options.toolsContext,
            observer,
            hasCheckStock,
          );
          if (options.stepNumber >= finalSlot) {
            return {
              runtimeContext: frame,
              toolsContext: stepToolsContext,
              activeTools: [] as string[],
              toolChoice: 'none' as const,
            };
          }
          // While a stock failure is unresolved, keep mutating tools hidden
          // from the presentation. The single RESTOCK tool becomes visible
          // only when a prior verified shortage exists, and the approval gate
          // still denies any non-matching call.
          if (guard.hasUnresolvedStockFailure()) {
            const visible = new Set(nonMutatingActiveTools);
            if (
              'requestHumanAssistance' in sourceTools &&
              evidence.hasVerifiedShortage()
            ) {
              visible.add('requestHumanAssistance');
            }
            return {
              runtimeContext: frame,
              toolsContext: stepToolsContext,
              activeTools: [...visible],
            };
          }
          return { runtimeContext: frame, toolsContext: stepToolsContext };
        },
        onStepFinish: (step: unknown) => {
          // One strict correlation feeds BOTH the conservative guard and the
          // private ledger, so a malformed completion cannot clear one while
          // being rejected by the other.
          const calls = correlateStepCalls(step);
          const rawStep = asRecord(step)?.stepNumber;
          const stepNumber =
            typeof rawStep === 'number' &&
            Number.isSafeInteger(rawStep) &&
            rawStep >= 0
              ? rawStep
              : null;
          // Admit the private receipts BEFORE the guard reads them: a stock
          // result can then clear the unresolved failure only when private
          // authority corroborates it at THIS step.
          if (stepNumber !== null) {
            evidence.admitCompletedStep(stepNumber, admittedCalls(calls));
          }
          guard.recordStep(guardCallsForStep(calls, evidence, stepNumber));
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

    // Conservative reply override: any executed write preserves the model
    // reply verbatim (even an empty string); otherwise the current-turn
    // trusted stock projection wins, with the generic fallback only as a
    // residual guard.
    const reply = selectReply(result.text, guard, evidence, catalogSession);

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
  // Closed allowlist for checkStock returned-error envelopes. Only these
  // literal kinds reach diagnostics; every other string maps to the fixed
  // `unknown` label, so arbitrary text, IDs or payloads are never echoed.
  const checkStockErrorKinds = new Set<string>([
    'catalog_identity_unverified',
    'auth',
    'forbidden',
    'notFound',
    'rateLimit',
    'validation',
    'upstream',
  ]);
  const checkStockErrorKind = (result: unknown): string => {
    const kind = envelope(envelope(result).error).kind;
    return typeof kind === 'string' && checkStockErrorKinds.has(kind)
      ? kind
      : 'unknown';
  };
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
          let errorKind: string | undefined;
          observe(() => {
            if (toolName === 'other') return;
            const output = event.toolOutput;
            if (output.type === 'tool-error') category = 'execution_error';
            if (output.type === 'tool-result') {
              category = outcomeOf(toolName, output.output);
              if (toolName === 'checkStock' && category === 'returned_error') {
                errorKind = checkStockErrorKind(output.output);
              }
            }
          });
          if (category === 'unknown_output') observationComplete = false;
          emit({
            event: 'tool_execution_end',
            toolName,
            category,
            ...(errorKind === undefined ? {} : { errorKind }),
          });
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
