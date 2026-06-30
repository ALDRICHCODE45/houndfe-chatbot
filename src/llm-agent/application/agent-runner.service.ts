import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONVERSATION_STORE,
  readMessages,
  type AgentMessage,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  LLM_AGENT,
  type LlmAgentPort,
} from '../domain/llm-agent.port';
import {
  TOOL_REGISTRY,
  type ToolRegistry,
} from '../domain/tool-registry.port';
import { SYSTEM_PROMPT } from '../domain/system-prompt';
import { CostGuardService } from './cost-guard.service';

export interface AgentRunnerConfig {
  systemPrompt: string;
  historyTurns: number;
  idleTimeoutMs: number;
}

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
    configService: ConfigService,
  ) {
    const llmCfg = configService.get<{
      historyTurns: number;
      idleTimeoutMs: number;
    }>('llm')!;
    this.systemPrompt = SYSTEM_PROMPT;
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
    return new AgentRunner(store, llm, tools, costGuard, stub);
  }

  async handle(input: AgentRunnerHandleInput): Promise<{ reply: string }> {
    const now = new Date();
    const nowIso = now.toISOString();

    // 1) Load state.
    const state = await this.store.get(input.senderId);

    // 2) Idle-check + 3) truncate in memory.
    const idleExpired =
      state !== null &&
      now.getTime() - new Date(state.lastMessageAt).getTime() > this.idleTimeoutMs;

    const allTurns: AgentMessage[] = state === null || idleExpired ? [] : readMessages(state);
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

    // 6) Persist user + assistant turns via UPSERT.
    const nextTurns: AgentMessage[] = [
      ...allTurns,
      { role: 'user', content: input.text },
      { role: 'assistant', content: result.reply },
    ];

    await this.store.update(input.senderId, {
      lastMessageAt: nowIso,
      data: { messages: nextTurns },
    });

    return { reply: result.reply };
  }
}

// Keep config-shape exports silent under strict TS.
export const __agentRunnerConfigBrand: AgentRunnerConfig | undefined = undefined;
void __agentRunnerConfigBrand;