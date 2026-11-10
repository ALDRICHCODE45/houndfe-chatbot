import {
  boundedGatePurgeBatch,
  serializeConversationGate,
  type ConversationGate,
  type ConversationGateKind,
  type ConversationGateMatch,
  type ConversationGateStore,
} from '../domain/conversation-gate.store';

interface StoredGate {
  readonly senderId: string;
  readonly kind: ConversationGateKind;
  /** Private copy; every read returns another detached copy. */
  readonly payload: Record<string, unknown>;
  readonly expiresAt: number;
}

const keyOf = (senderId: string, kind: ConversationGateKind) =>
  `${senderId}\u0000${kind}`;

function toGate(stored: StoredGate): ConversationGate {
  return {
    senderId: stored.senderId,
    kind: stored.kind,
    payload: structuredClone(stored.payload),
    expiresAt: new Date(stored.expiresAt),
  };
}

/**
 * Process-local `ConversationGateStore` for unit tests and for services built
 * outside Nest. Same contract as the Postgres adapter, but forgets everything
 * on restart.
 */
export class InMemoryConversationGateStore implements ConversationGateStore {
  private readonly gates = new Map<string, StoredGate>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  put(gate: ConversationGate): Promise<void> {
    try {
      // Same validation and size cap as the Postgres adapter.
      serializeConversationGate(gate);
      this.gates.set(keyOf(gate.senderId, gate.kind), {
        senderId: gate.senderId,
        kind: gate.kind,
        payload: structuredClone(gate.payload),
        expiresAt: gate.expiresAt.getTime(),
      });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  get(
    senderId: string,
    kind: ConversationGateKind,
  ): Promise<ConversationGate | null> {
    const stored = this.live(keyOf(senderId, kind));
    return Promise.resolve(stored === null ? null : toGate(stored));
  }

  list(senderId: string): Promise<ConversationGate[]> {
    const gates: ConversationGate[] = [];
    for (const key of this.gates.keys()) {
      const stored = this.live(key);
      if (stored !== null && stored.senderId === senderId)
        gates.push(toGate(stored));
    }
    return Promise.resolve(gates);
  }

  consume(
    senderId: string,
    kind: ConversationGateKind,
    match: ConversationGateMatch = {},
  ): Promise<ConversationGate | null> {
    const key = keyOf(senderId, kind);
    const stored = this.live(key);
    if (stored === null) return Promise.resolve(null);
    const gate = toGate(stored);
    const matches = Object.entries(match).every(
      ([field, value]) => gate.payload[field] === value,
    );
    if (!matches) return Promise.resolve(null);
    this.gates.delete(key);
    return Promise.resolve(gate);
  }

  delete(senderId: string, kind: ConversationGateKind): Promise<void> {
    this.gates.delete(keyOf(senderId, kind));
    return Promise.resolve();
  }

  purgeExpired(batchSize: number): Promise<number> {
    const limit = boundedGatePurgeBatch(batchSize);
    const now = this.now().getTime();
    const due = [...this.gates.entries()]
      .filter(([, stored]) => stored.expiresAt <= now)
      .sort(([, a], [, b]) => a.expiresAt - b.expiresAt)
      .slice(0, limit);
    for (const [key] of due) this.gates.delete(key);
    return Promise.resolve(due.length);
  }

  private live(key: string): StoredGate | null {
    const stored = this.gates.get(key);
    if (stored === undefined) return null;
    return stored.expiresAt > this.now().getTime() ? stored : null;
  }
}
