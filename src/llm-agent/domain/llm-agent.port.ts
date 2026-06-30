import type { AgentMessage } from './agent-message';

/**
 * DI injection token for the LLM agent port.
 *
 * Domain and application layers MUST inject this token — never the
 * `ai` package directly. Only files under `infrastructure/` may import
 * the SDK so the provider stays swappable.
 */
export const LLM_AGENT = Symbol('LLM_AGENT');

/** Result returned by a single agent run. */
export interface LlmRunResult {
  /** The final assistant text reply to send back to the user. */
  reply: string;
  /**
   * The assembled message list (user / assistant / tool turns) for the
   * current turn. Callers are responsible for persisting it on the
   * conversation state via `ConversationStore.update`.
   */
  messages: AgentMessage[];
  /**
   * Token usage for this run. The adapter MUST translate the SDK's
   * `inputTokens`/`outputTokens` fields here and MUST default any
   * `undefined` field to `0` (cost guard aggregates these).
   */
  usage: { promptTokens: number; completionTokens: number };
}

/** Input to a single agent run. */
export interface LlmRunInput {
  senderId: string;
  text: string;
  /** Pre-truncated history (truncation is the runner's job, not the port's). */
  history: AgentMessage[];
  systemPrompt: string;
  /**
   * AI-SDK ToolSet — opaque to the domain so that swapping providers
   * never leaks SDK types past the infrastructure boundary.
   */
  tools: Record<string, unknown>;
}

/** Port the runner uses to invoke the agent. */
export interface LlmAgentPort {
  run(input: LlmRunInput): Promise<LlmRunResult>;
}