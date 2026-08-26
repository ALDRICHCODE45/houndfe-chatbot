import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONVERSATION_STORE,
  readMessages,
  readPendingHumanRequest,
  type AgentMessage,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import { PENDING_HUMAN_REQUEST_REPLY } from '../../human-handoff/application/human-handoff.service';
import { LLM_AGENT, type LlmAgentPort } from '../domain/llm-agent.port';
import { TOOL_REGISTRY, type ToolRegistry } from '../domain/tool-registry.port';
import { LLM_AGENT_SYSTEM_PROMPT } from '../domain/system-prompt';
import { CostGuardService } from './cost-guard.service';

export interface AgentRunnerConfig {
  systemPrompt: string;
  historyTurns: number;
  idleTimeoutMs: number;
}

/**
 * Byte-identical canned reply used by the runner's pending-marker
 * short-circuit and by the dispatcher's pre-routing hook when the
 * customer's `pendingHumanRequest` marker is set. Re-exported here so the
 * runner + the dispatcher share one constant.
 */
export { PENDING_HUMAN_REQUEST_REPLY };

export interface AgentRunnerHandleInput {
  senderId: string;
  text: string;
}

/**
 * AgentRunner — application-layer orchestrator that drives one inbound
 * WhatsApp text through the LLM agent.
 *
 * Responsibilities:
 *   1. Load the sender's conversation state via ConversationStore.get.
 *   2. Apply idle-timeout: if (now - lastMessageAt) > idleTimeoutMs,
 *      treat as a fresh session — history is wiped in memory and the
 *      stored lastMessageAt is overwritten.
 *   3. Truncate the loaded history IN MEMORY to historyTurns. The store
 *      keeps the full transcript (it is a dumb upsert bag).
 *   4. Invoke LLM_AGENT.run() with the assembled prompt + tools.
 *   5. Record usage on CostGuard.
 *   6. UPSERT-persist user + assistant turns back into the store.
 *
 * No proactive sends anywhere — outbound traffic only flows via the
 * dispatcher after this method returns.
 */
@Injectable()
export class AgentRunner {
  private readonly systemPrompt: string;
  private readonly historyTurns: number;
  private readonly idleTimeoutMs: number;

  constructor(
    @Inject(CONVERSATION_STORE)
    private readonly store: ConversationStore,
    @Inject(LLM_AGENT) private readonly llm: LlmAgentPort,
    @Inject(TOOL_REGISTRY) private readonly tools: ToolRegistry,
    private readonly costGuard: CostGuardService,
    @Inject(LLM_AGENT_SYSTEM_PROMPT) systemPrompt: string,
    configService: ConfigService,
  ) {
    // Composition happens once at module boot (LlmAgentModule factory).
    // The runner never overrides the prompt at runtime — that contract
    // is preserved (spec llm-agent: "MUST NOT override the prompt at
    // runtime").
    this.systemPrompt = systemPrompt;
    const llmCfg = configService.get<{
      historyTurns: number;
      idleTimeoutMs: number;
    }>('llm')!;
    this.historyTurns = llmCfg.historyTurns;
    this.idleTimeoutMs = llmCfg.idleTimeoutMs;
  }

  /**
   * Convenience constructor for tests that already have a config object
   * (avoids needing a ConfigService stand-in).
   */
  static forTest(
    store: ConversationStore,
    llm: LlmAgentPort,
    tools: ToolRegistry,
    costGuard: CostGuardService,
    config: AgentRunnerConfig,
  ): AgentRunner {
    const stub = {
      get: <T>(path: string): T | undefined => {
        if (path === 'llm')
          return {
            historyTurns: config.historyTurns,
            idleTimeoutMs: config.idleTimeoutMs,
          } as unknown as T;
        return undefined;
      },
    } as unknown as ConfigService;
    return new AgentRunner(
      store,
      llm,
      tools,
      costGuard,
      config.systemPrompt,
      stub,
    );
  }

  async handle(input: AgentRunnerHandleInput): Promise<{ reply: string }> {
    const now = new Date();
    const nowIso = now.toISOString();

    // 1) Load state.
    const state = await this.store.get(input.senderId);

    // 1a) Short-circuit on the human-handoff marker (ADR-29).
    // If a `pendingHumanRequest` marker is set on the loaded state we
    // are still waiting for the human agent's reply; we MUST skip the
    // LLM turn entirely (no `llm.run`, no `costGuard.record`, no
    // `store.update`). The dispatcher pre-routing hook returns the canned
    // reply before reaching here for dispatcher-owned inbounds, but the
    // runner keeps the gate as defense-in-depth so any downstream caller
    // of `AgentRunner.handle` honours the contract.
    if (readPendingHumanRequest(state) !== null) {
      return { reply: PENDING_HUMAN_REQUEST_REPLY };
    }

    // 2) Idle-check + 3) truncate in memory.
    const idleExpired =
      state !== null &&
      now.getTime() - new Date(state.lastMessageAt).getTime() >
        this.idleTimeoutMs;

    const allTurns: AgentMessage[] =
      state === null || idleExpired ? [] : readMessages(state);
    const truncated = allTurns.slice(-this.historyTurns);

    // 4) Run the agent.
    const result = await this.llm.run({
      senderId: input.senderId,
      text: input.text,
      history: truncated,
      systemPrompt: this.systemPrompt,
      tools: this.tools.getTools(),
    });

    // 5) Cost guard.
    this.costGuard.record(result.usage);

    // 6) Persist user + assistant turns via UPSERT (ADR-28 + ADR-29).
    // Re-fetch the freshly-written state after `llm.run` so we can
    // spread its `data` bag over the messages update. Tools that ran
    // during the LLM turn may have written sibling keys (cart,
    // placedSaleId, pendingHumanRequest); writing `data: { messages }`
    // alone would clobber those siblings via the store's data-replace
    // UPSERT semantics.
    const freshState = await this.store.get(input.senderId);

    if (freshState === null && state !== null) {
      // Race: the state record existed at step 1 but was deleted during
      // the LLM turn. Skip the persist (a null-spread `update` would
      // fabricate an empty bag); the LLM reply is still returned for the
      // dispatcher.
      Logger.error(
        `[state-deleted-during-run] senderId=${input.senderId}`,
        'AgentRunner',
      );
      return { reply: result.reply };
    }

    const nextTurns: AgentMessage[] = [
      ...allTurns,
      { role: 'user', content: input.text },
      { role: 'assistant', content: result.reply },
    ];

    // ADR-28 fresh-state spread: preserve sibling `data` keys (cart,
    // placedSaleId, pendingHumanRequest) written by tools during the
    // turn. First contact (both reads null) falls back to a plain
    // `{ messages }` write — the UPSERT creates the record.
    const data =
      freshState === null
        ? { messages: nextTurns }
        : { ...freshState.data, messages: nextTurns };

    await this.store.update(input.senderId, {
      lastMessageAt: nowIso,
      data,
    });

    return { reply: result.reply };
  }
}

// Keep config-shape exports silent under strict TS.
export const __agentRunnerConfigBrand: AgentRunnerConfig | undefined =
  undefined;
void __agentRunnerConfigBrand;
