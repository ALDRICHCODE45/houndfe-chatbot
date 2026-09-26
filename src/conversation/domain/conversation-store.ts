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
 * Pending-human-request marker persisted under `ConversationStateData.pendingHumanRequest`.
 *
 * Holds the bookkeeping the runner / dispatcher need to:
 *   - Skip the LLM turn when the customer sends another inbound while we
 *     are still waiting for the human agent's reply (ADR-29).
 *   - Re-fetch the durable row by `requestId` once the agent replies.
 *   - Carry the "we already notified the customer" timestamp so a stale
 *     marker never re-issues the under-review notice.
 *
 * The marker is set by `HumanHandoffService.create` and cleared by
 * `HumanHandoffService.resolveReply`. Idle-reset UPSERTs MUST preserve
 * the marker (the agent could be mid-reply); see AgentRunner §"fresh-state
 * spread write (ADR-28)".
 */
export interface PendingHumanRequest {
  /** 12 lowercase hex chars; the row id in `human_handoff_requests`. */
  requestId: string;
  /** Public ref = `HF-${requestId}`. */
  ref: string;
  /** ISO 8601 — when the row was created. */
  createdAt: string;
  /** ISO 8601 — when the customer was first told "we notified an agent". */
  customerNotifiedAt: string;
}

/**
 * Typed `data` payload carried by ConversationState.
 *
 * `messages` is optional at the storage level so legacy records that
 * predate the LLM slice still round-trip cleanly; callers should always
 * go through `readMessages(state)` to receive `[]` when missing.
 *
 * `pendingHumanRequest?` is the human-handoff slice's bookmark. Sibling
 * of `placedSaleId`; the agent runner reads it before each LLM turn to
 * short-circuit the canned "we are still waiting" reply when present
 * (ADR-29). Idempotency on `HumanHandoffService.create` relies on this
 * field too — a second call for a sender with a marker set returns the
 * existing ref without writing a new row.
 */
export type ReceiptAmountPointer = Readonly<{
  receiptMediaId: string;
  saleId: string;
  receiptVersion: string;
}>;

export function isReceiptAmountPointer(
  value: unknown,
): value is ReceiptAmountPointer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const pointer = value as Record<string, unknown>;
  return (
    Object.keys(pointer).length === 3 &&
    Object.hasOwn(pointer, 'receiptMediaId') &&
    Object.hasOwn(pointer, 'saleId') &&
    Object.hasOwn(pointer, 'receiptVersion') &&
    typeof pointer.receiptMediaId === 'string' &&
    pointer.receiptMediaId.length > 0 &&
    typeof pointer.saleId === 'string' &&
    pointer.saleId.length > 0 &&
    typeof pointer.receiptVersion === 'string' &&
    /^[1-9]\d*$/.test(pointer.receiptVersion)
  );
}

export interface ConversationStateData {
  receiptAmountPointer?: ReceiptAmountPointer;
  messages?: AgentMessage[];
  /** Sale id persisted by createSale success; read/cleared by cancelSale. */
  placedSaleId?: string;
  /** Human-handoff marker; null when no escalation is pending. */
  pendingHumanRequest?: PendingHumanRequest | null;
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
 * Pure structural read of the human-handoff marker on a conversation state.
 *
 * The runner calls this BEFORE any LLM turn. A non-null return short-circuits
 * the runner (no `llm.run`, no `costGuard.record`, no `store.update`); the
 * canned "seguimos esperando respuesta del agente, te avisamos en cuanto
 * tengamos" reply is sent by the dispatcher pre-routing hook instead.
 *
 * Defensive defaults: returns `null` for missing fields, for structurally
 * malformed shapes, or when the value is explicitly `null` (the cleared
 * marker). Returns the typed object when ALL four required fields are
 * structurally valid (non-empty strings). Does NOT mutate the input.
 */
export function readPendingHumanRequest(
  state: ConversationState | null,
): PendingHumanRequest | null {
  const raw = state?.data?.pendingHumanRequest;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  // SAFETY: object narrowing above excludes null; fields are validated below.
  const candidate = raw as unknown as Record<string, unknown>;
  if (
    typeof candidate.requestId !== 'string' ||
    candidate.requestId.length === 0
  ) {
    return null;
  }
  if (typeof candidate.ref !== 'string' || candidate.ref.length === 0) {
    return null;
  }
  if (typeof candidate.createdAt !== 'string') {
    return null;
  }
  if (typeof candidate.customerNotifiedAt !== 'string') {
    return null;
  }
  // SAFETY: every required field was structurally validated above.
  return candidate as unknown as PendingHumanRequest;
}

/** Fail-closed guard for the non-empty key arguments used by the CAS writers. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Strict structural guard for a persisted human-handoff marker.
 *
 * Stricter than `readPendingHumanRequest`, which stays lenient for legacy
 * reads: the CAS writers must fail closed on any partial, empty,
 * extra-keyed, or prototype-inherited blob, so all four fields must be
 * non-empty OWN string properties and no other own enumerable key may be
 * present.
 */
export function isStructuralPendingHumanRequest(
  value: unknown,
): value is PendingHumanRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).length !== 4) return false;
  return (
    ['requestId', 'ref', 'createdAt', 'customerNotifiedAt'] as const
  ).every((key) => Object.hasOwn(marker, key) && isNonEmptyString(marker[key]));
}

/**
 * Exact id shape a `PendingHumanRequest.requestId` must have: 12
 * lowercase hex characters (the `human_handoff_requests` row id).
 */
export function isPendingHumanRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{12}$/.test(value);
}

/**
 * Structural guard for a CANONICAL `pendingHumanRequest` marker: exactly
 * the four keys `requestId`/`ref`/`createdAt`/`customerNotifiedAt`, all
 * non-empty strings, `requestId` a valid id, and `ref === 'HF-' + requestId`.
 *
 * Distinction from `readPendingHumanRequest`: the reader checks that each
 * of the four fields is present with the required type (and that
 * `requestId`/`ref` are non-empty) but tolerates extra keys and
 * noncanonical ids/refs; this strict guard additionally requires exactly
 * four keys, a valid 12-lowercase-hex `requestId`, and
 * `ref === 'HF-' + requestId`, so the conditional clear refuses any
 * drifted or extended marker.
 */
export function isPendingHumanRequest(
  value: unknown,
): value is PendingHumanRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).length !== 4) return false;
  if (
    !Object.hasOwn(marker, 'requestId') ||
    !Object.hasOwn(marker, 'ref') ||
    !Object.hasOwn(marker, 'createdAt') ||
    !Object.hasOwn(marker, 'customerNotifiedAt')
  ) {
    return false;
  }
  if (!isPendingHumanRequestId(marker.requestId)) return false;
  if (marker.ref !== `HF-${marker.requestId}`) return false;
  if (typeof marker.createdAt !== 'string' || marker.createdAt.length === 0) {
    return false;
  }
  if (
    typeof marker.customerNotifiedAt !== 'string' ||
    marker.customerNotifiedAt.length === 0
  ) {
    return false;
  }
  return true;
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
   * First-contact-safe CAS set of `data.pendingHumanRequest`.
   *
   * Returns true only when the sender has no row, has no marker, has
   * explicit JSON null, or already holds exactly this marker (idempotent
   * replay). A different or corrupt active marker is never overwritten.
   * Existing `data` keys are preserved; `update()` is deliberately NOT
   * reused here so the legacy marker writer stays byte-compatible until
   * the T3b cutover.
   *
   * `lastMessageAt` is validated as a non-empty string; the marker must
   * pass `isStructuralPendingHumanRequest` (four non-empty OWN strings).
   */
  setPendingHumanRequest(
    senderId: string,
    marker: PendingHumanRequest,
    lastMessageAt: string,
  ): Promise<boolean>;

  /**
   * Conditional CAS clear: sets `data.pendingHumanRequest` to explicit JSON
   * null (the key is never removed) when the stored marker is structurally
   * complete and its `requestId` matches. No UPSERT; a missing row, wrong
   * id, or malformed marker returns false. An explicitly invalid third
   * argument fails closed; only omission selects the canonical overload below.
   */
  clearPendingHumanRequest(
    senderId: string,
    requestId: string,
    lastMessageAt: string,
  ): Promise<boolean>;

  setReceiptAmountPointer(
    senderId: string,
    pointer: ReceiptAmountPointer,
  ): Promise<boolean>;

  clearReceiptAmountPointer(
    senderId: string,
    pointer: ReceiptAmountPointer,
  ): Promise<boolean>;

  /**
   * Atomically clears `data.pendingHumanRequest` (SET to JSON `null`,
   * retaining the key) iff the stored marker is canonical AND its
   * `requestId` equals the supplied id. Returns true iff exactly one row
   * transitioned; false with no writes otherwise. Sibling `data` keys
   * (incl. `receiptAmountPointer`, `shippingApproval`) and `lastMessageAt`
   * are preserved.
   */
  clearPendingHumanRequest(
    senderId: string,
    requestId: string,
  ): Promise<boolean>;

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
