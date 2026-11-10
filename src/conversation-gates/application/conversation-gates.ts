import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CONVERSATION_GATE_STORE,
  ConversationGateRejected,
  type ConversationGate,
  type ConversationGateKind,
  type ConversationGateMatch,
  type ConversationGateStore,
} from '../domain/conversation-gate.store';

/** Application clock (epoch ms) shared by the gates and their domain classes. */
export const CONVERSATION_GATE_CLOCK = Symbol('CONVERSATION_GATE_CLOCK');

/** One gate's in-memory state as plain JSON data plus its absolute expiry. */
export interface ConversationGateState {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
}

/**
 * A typed adapter that exposes one gate kind of a domain class. `read` must
 * report an expired state as `null`; `write` replaces the sender's state and
 * returns `false` (leaving no state) when the payload is malformed.
 */
export interface ConversationGateParticipant {
  readonly kind: ConversationGateKind;
  read(senderId: string): ConversationGateState | null;
  write(senderId: string, state: ConversationGateState | null): boolean;
}

const UNREADABLE = Symbol('unreadable');

const keyOf = (senderId: string, kind: ConversationGateKind) =>
  `${senderId}\u0000${kind}`;

/** Key-sorted JSON, so a jsonb round trip compares equal to what was written. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

const fingerprint = (state: ConversationGateState): string =>
  canonicalJson({
    payload: state.payload,
    expiresAt: new Date(state.expiresAt).toISOString(),
  });

const reasonOf = (error: unknown): string =>
  error instanceof ConversationGateRejected
    ? error.message
    : error instanceof Error
      ? error.name
      : 'unknown';

/**
 * S4: keeps the synchronous in-memory gates of the minimal route in step with
 * the durable `ConversationGateStore`.
 *
 *   - `begin(sender)` runs once at the start of every customer turn: it
 *     writes any unsaved change first and then loads the sender's live rows
 *     into the participants. A row equal to what this process last wrote is
 *     skipped, so live objects (and their `onSent` arming callbacks) keep
 *     their identity; a restarted process restores every row.
 *   - `touch(sender)` captures the sender's states right away and schedules
 *     their write (put or delete), so writes land in mutation order even when
 *     the in-memory state moves on before the write runs.
 *   - `claim` atomically consumes the durable row (single use across
 *     processes and concurrent turns).
 *
 * Every operation of one sender runs in order on one promise chain. A failed
 * write keeps the sender dirty and `begin` retries it before loading, so a
 * declined or consumed gate is never resurrected from a stale row.
 */
@Injectable()
export class ConversationGates {
  private readonly logger = new Logger(ConversationGates.name);
  private readonly participants = new Map<
    ConversationGateKind,
    ConversationGateParticipant
  >();
  /** Fingerprint of what this process last wrote or loaded, per gate. */
  private readonly persisted = new Map<string, string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly dirty = new Set<string>();
  readonly now: () => number;

  constructor(
    @Inject(CONVERSATION_GATE_STORE)
    private readonly store: ConversationGateStore,
    @Optional() @Inject(CONVERSATION_GATE_CLOCK) now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  register(participant: ConversationGateParticipant): void {
    if (this.participants.has(participant.kind))
      throw new Error(
        `conversation gate kind already registered: ${participant.kind}`,
      );
    this.participants.set(participant.kind, participant);
  }

  /** Start of a turn: persist unsaved changes, then load the durable rows. */
  begin(senderId: string): Promise<void> {
    return this.enqueue(senderId, async () => {
      if (!(await this.flush(senderId))) return;
      let gates: ConversationGate[];
      try {
        gates = await this.store.list(senderId);
      } catch (error) {
        this.logger.warn(
          `conversation gate load failed reason=${reasonOf(error)}`,
        );
        return;
      }
      for (const participant of this.participants.values())
        await this.load(senderId, participant, gates);
    });
  }

  /** Capture the sender's gates now and schedule the write of what changed. */
  touch(senderId: string): void {
    const captured = new Map<
      ConversationGateKind,
      ConversationGateState | null
    >();
    for (const participant of this.participants.values()) {
      const state = this.readSafely(senderId, participant);
      if (state !== UNREADABLE) captured.set(participant.kind, state);
    }
    void this.enqueue(senderId, () => this.flush(senderId, captured));
  }

  /** Wait for every scheduled write; `false` while a write is still failing. */
  async settle(senderId: string): Promise<boolean> {
    await (this.chains.get(senderId) ?? Promise.resolve());
    return !this.dirty.has(senderId);
  }

  /**
   * Atomically spend the durable gate when its payload still matches. Fails
   * closed: absent, expired, replaced, already spent or unreadable is `false`.
   */
  claim(
    senderId: string,
    kind: ConversationGateKind,
    match: ConversationGateMatch,
  ): Promise<boolean> {
    return this.enqueue(senderId, async () => {
      try {
        const gate = await this.store.consume(senderId, kind, match);
        this.persisted.delete(keyOf(senderId, kind));
        return gate !== null;
      } catch (error) {
        this.logger.warn(
          `conversation gate claim failed kind=${kind} reason=${reasonOf(error)}`,
        );
        return false;
      }
    });
  }

  private async flush(
    senderId: string,
    captured?: ReadonlyMap<ConversationGateKind, ConversationGateState | null>,
  ): Promise<boolean> {
    let ok = true;
    for (const participant of this.participants.values()) {
      const { kind } = participant;
      const key = keyOf(senderId, kind);
      // An unreadable state is left as it is: never written, never deleted.
      const state =
        captured === undefined
          ? this.readSafely(senderId, participant)
          : captured.has(kind)
            ? (captured.get(kind) ?? null)
            : UNREADABLE;
      if (state === UNREADABLE) continue;
      const next = state === null ? null : fingerprint(state);
      if (next === (this.persisted.get(key) ?? null)) continue;
      try {
        if (state === null) await this.store.delete(senderId, kind);
        else
          await this.store.put({
            senderId,
            kind,
            payload: state.payload,
            expiresAt: new Date(state.expiresAt),
          });
        if (next === null) this.persisted.delete(key);
        else this.persisted.set(key, next);
      } catch (error) {
        ok = false;
        this.logger.warn(
          `conversation gate write failed kind=${kind} reason=${reasonOf(error)}`,
        );
      }
    }
    if (ok) this.dirty.delete(senderId);
    else this.dirty.add(senderId);
    return ok;
  }

  private async load(
    senderId: string,
    participant: ConversationGateParticipant,
    gates: readonly ConversationGate[],
  ): Promise<void> {
    const { kind } = participant;
    const key = keyOf(senderId, kind);
    const gate = gates.find((candidate) => candidate.kind === kind);
    const state =
      gate === undefined
        ? null
        : { payload: gate.payload, expiresAt: gate.expiresAt.getTime() };
    const next = state === null ? null : fingerprint(state);
    if (next === (this.persisted.get(key) ?? null)) return;
    let accepted = false;
    try {
      accepted = participant.write(senderId, state);
    } catch {
      accepted = false;
    }
    if (accepted) {
      if (next === null) this.persisted.delete(key);
      else this.persisted.set(key, next);
      return;
    }
    // Malformed row: absent for this turn and removed so it never returns.
    this.logger.warn(
      `conversation gate malformed kind=${kind}; treated as absent`,
    );
    try {
      participant.write(senderId, null);
    } catch {
      // Clearing is best effort; the row is gone either way below.
    }
    this.persisted.delete(key);
    try {
      await this.store.delete(senderId, kind);
    } catch (error) {
      this.logger.warn(
        `conversation gate write failed kind=${kind} reason=${reasonOf(error)}`,
      );
    }
  }

  private readSafely(
    senderId: string,
    participant: ConversationGateParticipant,
  ): ConversationGateState | null | typeof UNREADABLE {
    try {
      return participant.read(senderId);
    } catch {
      this.logger.warn(
        `conversation gate read failed kind=${participant.kind}; not written`,
      );
      return UNREADABLE;
    }
  }

  /** Per-sender FIFO; operations never reject. */
  private enqueue<T>(senderId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(senderId) ?? Promise.resolve();
    const next = previous.then(op);
    const tail = next.catch(() => undefined);
    this.chains.set(senderId, tail);
    void tail.then(() => {
      if (this.chains.get(senderId) === tail) this.chains.delete(senderId);
    });
    return next;
  }
}
