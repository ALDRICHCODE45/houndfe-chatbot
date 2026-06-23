/** DI injection token for the ConversationStore port. */
export const CONVERSATION_STORE = Symbol('CONVERSATION_STORE');

/**
 * Persisted state for a single WhatsApp sender.
 *
 * `data` is intentionally open for the echo slice; a typed schema
 * will be layered on top once the LLM agent slice lands.
 */
export interface ConversationState {
  /** WhatsApp sender id (wa_id / phone number string from Meta). */
  senderId: string;
  /** ISO 8601 timestamp of the last inbound message processed. */
  lastMessageAt: string;
  /** Open-ended context bag — schema owned by the LLM slice. */
  data: Record<string, unknown>;
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
   * Applies a shallow patch to an existing state record.
   * Throws NotFoundException if the sender has no existing record.
   */
  update(
    senderId: string,
    patch: Partial<Omit<ConversationState, 'senderId'>>,
  ): Promise<ConversationState>;
}
