import type { ConversationGateStore } from '../domain/conversation-gate.store';
import { InMemoryConversationGateStore } from '../infrastructure/in-memory-conversation-gate.store';
import {
  ConversationGates,
  type ConversationGateParticipant,
  type ConversationGateState,
} from './conversation-gates';

const SENDER = '5215550001111';
const T0 = Date.parse('2026-11-09T16:00:00.000Z');
const TTL = 5 * 60 * 1000;

/** A participant over a plain map; `valid` rejects malformed payloads. */
class MapParticipant implements ConversationGateParticipant {
  readonly kind = 'restock_pending' as const;
  readonly states = new Map<string, ConversationGateState>();
  constructor(private readonly now: () => number) {}
  read(senderId: string): ConversationGateState | null {
    const state = this.states.get(senderId);
    return state === undefined || this.now() >= state.expiresAt ? null : state;
  }
  write(senderId: string, state: ConversationGateState | null): boolean {
    if (state === null || typeof state.payload.value !== 'string') {
      this.states.delete(senderId);
      return state === null;
    }
    this.states.set(senderId, state);
    return true;
  }
}

function harness(store?: ConversationGateStore) {
  let now = T0;
  const clock = () => now;
  const shared =
    store ?? new InMemoryConversationGateStore(() => new Date(clock()));
  const boot = () => {
    const gates = new ConversationGates(shared, clock);
    const participant = new MapParticipant(clock);
    gates.register(participant);
    return { gates, participant };
  };
  return {
    store: shared,
    boot,
    advance: (ms: number) => {
      now += ms;
    },
    clock,
  };
}

describe('ConversationGates (S4 durable sync)', () => {
  it('a touched state survives a restart within TTL and is absent after it', async () => {
    const h = harness();
    const first = h.boot();
    first.participant.states.set(SENDER, {
      payload: { value: 'a' },
      expiresAt: T0 + TTL,
    });
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);

    const restarted = h.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.participant.read(SENDER)).toEqual({
      payload: { value: 'a' },
      expiresAt: T0 + TTL,
    });

    const late = h.boot();
    h.advance(TTL);
    await late.gates.begin(SENDER);
    expect(late.participant.read(SENDER)).toBeNull();
  });

  it('a cleared state deletes the durable row', async () => {
    const h = harness();
    const { gates, participant } = h.boot();
    participant.states.set(SENDER, {
      payload: { value: 'a' },
      expiresAt: T0 + TTL,
    });
    gates.touch(SENDER);
    participant.states.delete(SENDER);
    gates.touch(SENDER);
    await gates.settle(SENDER);
    await expect(h.store.list(SENDER)).resolves.toEqual([]);
  });

  it('claim is single-use and drops the persisted state', async () => {
    const h = harness();
    const { gates, participant } = h.boot();
    participant.states.set(SENDER, {
      payload: { value: 'a', reference: 'r1' },
      expiresAt: T0 + TTL,
    });
    gates.touch(SENDER);
    await expect(
      gates.claim(SENDER, 'restock_pending', { reference: 'r0' }),
    ).resolves.toBe(false);
    await expect(
      gates.claim(SENDER, 'restock_pending', { reference: 'r1' }),
    ).resolves.toBe(true);
    await expect(
      gates.claim(SENDER, 'restock_pending', { reference: 'r1' }),
    ).resolves.toBe(false);
  });

  it('a malformed durable row is treated as absent and removed', async () => {
    const h = harness();
    await h.store.put({
      senderId: SENDER,
      kind: 'restock_pending',
      payload: { value: 42 },
      expiresAt: new Date(T0 + TTL),
    });
    const { gates, participant } = h.boot();
    const warn = jest
      .spyOn(gates['logger'], 'warn')
      .mockImplementation(() => undefined);
    await gates.begin(SENDER);
    expect(participant.read(SENDER)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('kind=restock_pending'),
    );
    await expect(h.store.list(SENDER)).resolves.toEqual([]);
  });

  it('begin keeps local state when an unsaved change cannot be written', async () => {
    const h = harness();
    const { gates, participant } = h.boot();
    jest.spyOn(gates['logger'], 'warn').mockImplementation(() => undefined);
    participant.states.set(SENDER, {
      payload: { value: 'a' },
      expiresAt: T0 + TTL,
    });
    gates.touch(SENDER);
    await gates.settle(SENDER);
    // A decline that fails to persist must never resurrect the old row.
    participant.states.delete(SENDER);
    const del = jest
      .spyOn(h.store, 'delete')
      .mockRejectedValueOnce(new Error('db down'));
    gates.touch(SENDER);
    await expect(gates.settle(SENDER)).resolves.toBe(false);
    await gates.begin(SENDER);
    expect(participant.read(SENDER)).toBeNull();
    expect(del).toHaveBeenCalledTimes(2);
    await expect(h.store.list(SENDER)).resolves.toEqual([]);
  });

  it('begin does not replace an unchanged local state (identity kept)', async () => {
    const h = harness();
    const { gates, participant } = h.boot();
    const state = { payload: { value: 'a' }, expiresAt: T0 + TTL };
    participant.states.set(SENDER, state);
    gates.touch(SENDER);
    await gates.begin(SENDER);
    expect(participant.states.get(SENDER)).toBe(state);
  });

  it('touch writes the state as it was when touched (mutation order)', async () => {
    const h = harness();
    const { gates, participant } = h.boot();
    participant.states.set(SENDER, {
      payload: { value: 'armed', reference: 'r1' },
      expiresAt: T0 + TTL,
    });
    gates.touch(SENDER);
    // Spent in memory before the scheduled write runs: the claim still wins.
    participant.states.delete(SENDER);
    await expect(
      gates.claim(SENDER, 'restock_pending', { reference: 'r1' }),
    ).resolves.toBe(true);
  });

  it('a throwing read never escapes touch and writes nothing', async () => {
    const h = harness();
    const { gates, participant } = h.boot();
    jest.spyOn(gates['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(participant, 'read').mockImplementation(() => {
      throw new Error('clock down');
    });
    expect(() => gates.touch(SENDER)).not.toThrow();
    await expect(gates.settle(SENDER)).resolves.toBe(true);
    await expect(h.store.list(SENDER)).resolves.toEqual([]);
  });

  it('rejects a second participant for the same kind', () => {
    const h = harness();
    const { gates } = h.boot();
    expect(() => gates.register(new MapParticipant(h.clock))).toThrow(
      /restock_pending/,
    );
  });
});
