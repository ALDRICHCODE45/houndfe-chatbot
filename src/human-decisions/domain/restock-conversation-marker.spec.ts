import type { ConversationState } from '../../conversation/domain/conversation-store';
import { classifyRestockConversationLegacyMarker as classifyForSender } from './restock-conversation-marker';

/**
 * HD-R3b3-c4c2a-adjacent offline spec for the PURE conversation legacy-marker
 * classifier: a strict, fail-closed companion to `readPendingHumanRequest`.
 */
const SENDER = 'whatsapp:+5215500000001';
const MARKER = {
  requestId: 'abc123def456',
  ref: 'HF-abc123def456',
  createdAt: '2026-06-23T12:00:00.000Z',
  customerNotifiedAt: '2026-06-23T12:00:01.000Z',
};
const state = (data: unknown): ConversationState =>
  ({
    senderId: SENDER,
    lastMessageAt: '2026-06-23T12:00:00.000Z',
    data,
  }) as ConversationState;
const classifyRestockConversationLegacyMarker = (
  value: ConversationState | null,
) => classifyForSender(value, SENDER);
const accessor = (key: string, value: unknown): Record<string, unknown> => {
  const target: Record<string, unknown> = {};
  Object.defineProperty(target, key, {
    get: () => value,
    enumerable: true,
    configurable: true,
  });
  return target;
};

describe('classifyRestockConversationLegacyMarker', () => {
  it('reads a null state as absent (false)', () => {
    expect(classifyRestockConversationLegacyMarker(null)).toBe(false);
  });

  it('reads a plain state with no own marker key as absent (false)', () => {
    expect(classifyRestockConversationLegacyMarker(state({ foo: 'bar' }))).toBe(
      false,
    );
    expect(
      classifyRestockConversationLegacyMarker(state({ messages: [] })),
    ).toBe(false);
  });

  it('never treats a state from another sender or without sender identity as absent', () => {
    expect(
      classifyForSender({ ...state({}), senderId: 'someone-else' }, SENDER),
    ).toBe('unknown');
    expect(classifyForSender({ data: {} } as never, SENDER)).toBe('unknown');
    expect(classifyForSender(null, '')).toBe('unknown');
  });

  it('reads an explicitly cleared own null marker as absent (false)', () => {
    expect(
      classifyRestockConversationLegacyMarker(
        state({ pendingHumanRequest: null }),
      ),
    ).toBe(false);
  });

  it('reads a structurally valid non-null marker as present (true)', () => {
    expect(
      classifyRestockConversationLegacyMarker(
        state({ pendingHumanRequest: { ...MARKER } }),
      ),
    ).toBe(true);
  });

  it('never returns false for a malformed, undefined, or hostile reading', () => {
    const data = { pendingHumanRequest: MARKER };
    const throwingMarker = new Proxy(
      { ...MARKER },
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    const cases: Array<[string, ConversationState | null | undefined]> = [
      ['undefined state', undefined],
      ['string state', 'state' as never],
      ['number state', 42 as never],
      ['array state', [] as never],
      [
        'accessor state data',
        accessor('data', { pendingHumanRequest: null }) as never,
      ],
      ['missing data key', state(undefined)],
      ['null data', state(null)],
      ['accessor data', state(accessor('pendingHumanRequest', null))],
      [
        'throwing getter marker',
        state(accessor('pendingHumanRequest', MARKER)),
      ],
      ['undefined marker', state({ pendingHumanRequest: undefined })],
      ['malformed marker', state({ pendingHumanRequest: { requestId: 'x' } })],
      [
        'empty requestId',
        state({ pendingHumanRequest: { ...MARKER, requestId: '' } }),
      ],
      ['non-object marker', state({ pendingHumanRequest: 'yes' })],
      ['throwing nested proxy', state({ pendingHumanRequest: throwingMarker })],
      [
        'get-vs-descriptor data',
        state(
          new Proxy(
            { pendingHumanRequest: null },
            { get: () => ({ pendingHumanRequest: MARKER }) },
          ),
        ),
      ],
      [
        'get-vs-descriptor marker',
        state({
          pendingHumanRequest: new Proxy({ ...MARKER }, { get: () => 'x' }),
        }),
      ],
    ];
    for (const [label, value] of cases) {
      const result = classifyRestockConversationLegacyMarker(value as never);
      expect([label, result]).toEqual([label, 'unknown']);
    }
    expect(Object.keys(data)).toEqual(['pendingHumanRequest']);
    expect(data.pendingHumanRequest).toBe(MARKER);
  });

  it('does not mutate a valid state', () => {
    const input = state({ pendingHumanRequest: { ...MARKER } });
    const before = JSON.stringify(input);
    expect(classifyRestockConversationLegacyMarker(input)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });
});
