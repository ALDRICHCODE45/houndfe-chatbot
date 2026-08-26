import {
  type ConversationState,
  type PendingHumanRequest,
  readPendingHumanRequest,
} from './conversation-store';

/**
 * Pure-helper contract suite for `readPendingHumanRequest`.
 *
 * Spec scenarios (conversation-store §"readPendingHumanRequest is a pure helper"):
 *   - returns the typed marker when structurally valid
 *   - returns null when the field is missing (no marker set)
 *   - returns null when the field is explicitly null (cleared)
 *   - returns null when the value is structurally malformed (defensive default)
 *   - does NOT mutate the input state
 */
describe('readPendingHumanRequest', () => {
  const baseState: ConversationState = {
    senderId: '5215550001111',
    lastMessageAt: '2026-06-23T12:00:00.000Z',
    data: {},
  };

  const validMarker: PendingHumanRequest = {
    requestId: 'abc123def456',
    ref: 'HF-abc123def456',
    createdAt: '2026-06-23T12:00:00.000Z',
    customerNotifiedAt: '2026-06-23T12:00:00.000Z',
  };

  it('returns the typed marker when structurally valid', () => {
    const state: ConversationState = {
      ...baseState,
      data: { pendingHumanRequest: validMarker },
    };
    expect(readPendingHumanRequest(state)).toEqual(validMarker);
  });

  it('returns null when the field is missing', () => {
    expect(readPendingHumanRequest(baseState)).toBeNull();
  });

  it('returns null when the state is null', () => {
    expect(readPendingHumanRequest(null)).toBeNull();
  });

  it('returns null when the field is explicitly null (cleared marker)', () => {
    const state: ConversationState = {
      ...baseState,
      data: { pendingHumanRequest: null },
    };
    expect(readPendingHumanRequest(state)).toBeNull();
  });

  it('returns null when the marker is structurally incomplete (missing requestId)', () => {
    const state: ConversationState = {
      ...baseState,
      data: {
        pendingHumanRequest: {
          ref: 'HF-abc',
          createdAt: '2026-06-23T12:00:00.000Z',
          customerNotifiedAt: '2026-06-23T12:00:00.000Z',
        },
      },
    };
    expect(readPendingHumanRequest(state)).toBeNull();
  });

  it('returns null when ref is an empty string', () => {
    const state: ConversationState = {
      ...baseState,
      data: {
        pendingHumanRequest: {
          ...validMarker,
          ref: '',
        },
      },
    };
    expect(readPendingHumanRequest(state)).toBeNull();
  });

  it('returns null when createdAt is not a string', () => {
    const state: ConversationState = {
      ...baseState,
      data: {
        pendingHumanRequest: {
          ...validMarker,
          createdAt: 12345 as unknown as string,
        },
      },
    };
    expect(readPendingHumanRequest(state)).toBeNull();
  });

  it('returns null when customerNotifiedAt is not a string', () => {
    const state: ConversationState = {
      ...baseState,
      data: {
        pendingHumanRequest: {
          ...validMarker,
          customerNotifiedAt: { not: 'a string' } as unknown as string,
        },
      },
    };
    expect(readPendingHumanRequest(state)).toBeNull();
  });

  it('returns null when the value is a non-object primitive', () => {
    const state: ConversationState = {
      ...baseState,
      data: { pendingHumanRequest: 42 as unknown as PendingHumanRequest },
    };
    expect(readPendingHumanRequest(state)).toBeNull();
  });

  it('does NOT mutate the input state', () => {
    const state: ConversationState = {
      ...baseState,
      data: { pendingHumanRequest: validMarker, placedSaleId: 'S-1' },
    };
    const snapshotBefore = JSON.parse(JSON.stringify(state));
    readPendingHumanRequest(state);
    expect(state).toEqual(snapshotBefore);
  });

  it('does NOT mutate when the field is missing', () => {
    const state: ConversationState = {
      ...baseState,
      data: { placedSaleId: 'S-2' },
    };
    const snapshotBefore = JSON.parse(JSON.stringify(state));
    expect(readPendingHumanRequest(state)).toBeNull();
    expect(state).toEqual(snapshotBefore);
  });
});
