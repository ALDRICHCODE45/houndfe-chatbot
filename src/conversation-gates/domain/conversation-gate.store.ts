/**
 * S4 durable conversation gates: one short-lived consent/selection state per
 * (sender, gate kind) that must survive a process restart.
 *
 * Expiry is enforced on read: an expired gate is absent for `get`, `list`
 * and `consume`, and `purgeExpired` deletes it later in bounded batches.
 * `consume` is atomic (one winner under concurrency), so a confirmation can
 * never be spent twice.
 */
export const CONVERSATION_GATE_STORE = Symbol('CONVERSATION_GATE_STORE');

/** Closed gate kinds; migration 4200 mirrors this list in a CHECK. */
export const CONVERSATION_GATE_KINDS = [
  'order_confirmation',
  'checkout_confirmation',
  'checkout_confirmed',
  'checkout_address',
  'restock_pending',
] as const;
export type ConversationGateKind = (typeof CONVERSATION_GATE_KINDS)[number];

/** Serialized payload cap; migration 4200 mirrors it in a CHECK. */
export const CONVERSATION_GATE_PAYLOAD_MAX_BYTES = 65_536;
export const CONVERSATION_GATE_SENDER_MAX_LENGTH = 128;
export const CONVERSATION_GATE_PURGE_BATCH_MAX = 5_000;

export interface ConversationGate {
  readonly senderId: string;
  readonly kind: ConversationGateKind;
  /** JSON object; dates travel as ISO-8601 strings. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expiresAt: Date;
}

/** Top-level payload fields a consume must still match (string equality). */
export type ConversationGateMatch = Readonly<Record<string, string>>;

export interface ConversationGateStore {
  /** Insert or replace the sender's gate of this kind. */
  put(gate: ConversationGate): Promise<void>;
  /** The live gate, or `null` when absent or expired. */
  get(
    senderId: string,
    kind: ConversationGateKind,
  ): Promise<ConversationGate | null>;
  /** Every live gate of one sender (one read per turn). */
  list(senderId: string): Promise<ConversationGate[]>;
  /**
   * Atomically delete and return the live gate when its payload still matches
   * `match`; `null` when absent, expired, different, or already consumed.
   */
  consume(
    senderId: string,
    kind: ConversationGateKind,
    match?: ConversationGateMatch,
  ): Promise<ConversationGate | null>;
  delete(senderId: string, kind: ConversationGateKind): Promise<void>;
  /** Delete up to `batchSize` expired gates; returns how many. */
  purgeExpired(batchSize: number): Promise<number>;
}

export class ConversationGateRejected extends Error {
  constructor(reason: string) {
    super(`conversation gate rejected: ${reason}`);
    this.name = 'ConversationGateRejected';
  }
}

export function isConversationGateKind(
  value: unknown,
): value is ConversationGateKind {
  return (
    typeof value === 'string' &&
    (CONVERSATION_GATE_KINDS as readonly string[]).includes(value)
  );
}

export function isConversationGateSenderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CONVERSATION_GATE_SENDER_MAX_LENGTH
  );
}

export function isConversationGatePayload(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a gate before any write and returns its serialized payload.
 * Throws `ConversationGateRejected` with a fixed reason (never the payload).
 */
export function serializeConversationGate(gate: ConversationGate): string {
  if (!isConversationGateSenderId(gate.senderId))
    throw new ConversationGateRejected('sender');
  if (!isConversationGateKind(gate.kind))
    throw new ConversationGateRejected('kind');
  if (!(gate.expiresAt instanceof Date) || isNaN(gate.expiresAt.getTime()))
    throw new ConversationGateRejected('expires_at');
  if (!isConversationGatePayload(gate.payload))
    throw new ConversationGateRejected('payload');
  const json = JSON.stringify(gate.payload);
  if (Buffer.byteLength(json, 'utf8') > CONVERSATION_GATE_PAYLOAD_MAX_BYTES)
    throw new ConversationGateRejected('payload_size');
  return json;
}

export function boundedGatePurgeBatch(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize < 1) return 1;
  return Math.min(batchSize, CONVERSATION_GATE_PURGE_BATCH_MAX);
}
