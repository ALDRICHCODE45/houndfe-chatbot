/** DI injection token for the ConversationStore port. */
export const CONVERSATION_STORE = Symbol('CONVERSATION_STORE');

/**
 * Canonical declaration of the agent message union used by both
 * `ConversationStore.data.messages` and the LLM agent layer.
 *
 * This type MUST be declared exactly once. Other modules (notably the
 * llm-agent feature) re-export it via a pure `export type { ... } from`
 * statement to avoid drift between layers.
 */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'tool'; toolCallId: string; content: unknown };

/**
 * Typed `data` payload carried by ConversationState.
 *
 * `messages` is optional at the storage level so legacy records that
 * predate the LLM slice still round-trip cleanly; callers should always
 * go through `readMessages(state)` to receive `[]` when missing.
 */
export interface ConversationStateData {
  messages?: AgentMessage[];
  [key: string]: unknown;
}

/**
 * Persisted state for a single WhatsApp sender.
 */
export interface ConversationState {
  /** WhatsApp sender id (wa_id / phone number string from Meta). */
  senderId: string;
  /** ISO 8601 timestamp of the last inbound message processed. */
  lastMessageAt: string;
  /** Typed context bag — schema owned by the LLM slice. */
  data: ConversationStateData;
}

/**
 * Default accessor used by the agent runner to obtain the message
 * transcript without having to repeat the nullish-coalescing dance.
 * Missing field → empty array.
 */
export function readMessages(state: ConversationState): AgentMessage[] {
  return state.data.messages ?? [];
}

/**
 * Port interface for reading and writing per-sender conversation state.
 *
 * Adapters (in-memory, Postgres, Redis…) are injected at runtime via
 * the CONVERSATION_STORE Symbol token.
 */
export interface ConversationStore {
  /**
   * Returns the current state for a sender, or null if none exists.
   */
  get(senderId: string): Promise<ConversationState | null>;

  /**
   * Creates a new state record for a sender.
   * Callers supply everything except `senderId` (which is the key).
   */
  create(
    senderId: string,
    state: Omit<ConversationState, 'senderId'>,
  ): Promise<ConversationState>;

  /**
   * Applies a shallow patch to the sender's record. UPSERT semantics:
   * when no record exists, a new one is created from the supplied patch
   * and returned. When one exists, the patch is shallow-merged over it.
   * This is a strict superset of the prior throw-on-missing behaviour
   * and is what the dispatcher / agent runner rely on.
   */
  update(
    senderId: string,
    patch: Partial<Omit<ConversationState, 'senderId'>>,
  ): Promise<ConversationState>;
}