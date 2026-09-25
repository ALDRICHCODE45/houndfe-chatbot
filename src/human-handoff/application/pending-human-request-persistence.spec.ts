import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  setPendingHumanRequest,
  clearPendingHumanRequest,
  readPendingHumanRequest,
} from './pending-human-request-persistence';

/**
 * Contract tests for the pendingHumanRequest persistence helpers.
 *
 * Spec scenarios (human-handoff §"pendingHumanRequest marker semantics"):
 *   - setPendingHumanRequest delegates to the CAS primitive
 *     (ConversationStore.setPendingHumanRequest) and returns its boolean.
 *   - clearPendingHumanRequest delegates to the CAS primitive with the
 *     matching requestId and returns its boolean (no legacy update()).
 *   - readPendingHumanRequest is a pure helper; returns the typed object
 *     when structurally valid, null otherwise, and does NOT mutate input.
 */
describe('pending-human-request-persistence', () => {
  const now = new Date('2026-06-23T12:00:00.000Z').toISOString();

  function buildStore(): {
    store: jest.Mocked<ConversationStore>;
    existing: ConversationState;
  } {
    const existing: ConversationState = {
      senderId: 'S',
      lastMessageAt: now,
      data: {
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola' },
        ],
        cart: { items: [], idempotencyKey: 'k' },
        placedSaleId: 'sale-1',
      },
    };
    const update = jest.fn(async (_senderId, patch) => ({
      senderId: 'S',
      lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt ?? now,
      data: (patch as { data: ConversationState['data'] }).data,
    }));
    const store: jest.Mocked<ConversationStore> = {
      get: jest.fn(),
      create: jest.fn(),
      update,
      setPendingHumanRequest: jest.fn(),
      clearPendingHumanRequest: jest.fn(),
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
    };
    return { store, existing };
  }

  describe('setPendingHumanRequest', () => {
    it('issues exactly one CAS set carrying the marker + lastMessageAt', async () => {
      const { store } = buildStore();
      const marker = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: now,
        customerNotifiedAt: now,
      };

      store.setPendingHumanRequest.mockResolvedValue(true);
      await expect(
        setPendingHumanRequest(store, 'S', marker, now),
      ).resolves.toBe(true);

      expect(store.setPendingHumanRequest).toHaveBeenCalledWith(
        'S',
        marker,
        now,
      );
      expect(store.update).not.toHaveBeenCalled();
    });

    it('propagates a false CAS result without a legacy update()', async () => {
      const { store } = buildStore();
      const marker = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: now,
        customerNotifiedAt: now,
      };

      store.setPendingHumanRequest.mockResolvedValue(false);
      await expect(
        setPendingHumanRequest(store, 'S', marker, now),
      ).resolves.toBe(false);

      expect(store.update).not.toHaveBeenCalled();
    });
  });

  describe('clearPendingHumanRequest', () => {
    it('delegates the matching requestId to the CAS primitive', async () => {
      const { store, existing } = buildStore();
      const withMarker: ConversationState = {
        ...existing,
        data: { ...existing.data, pendingHumanRequest: null },
      };
      withMarker.data.pendingHumanRequest = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: now,
        customerNotifiedAt: now,
      };

      store.clearPendingHumanRequest.mockResolvedValue(true);
      await expect(
        clearPendingHumanRequest(store, 'S', 'abc123def456', now),
      ).resolves.toBe(true);

      expect(store.clearPendingHumanRequest).toHaveBeenCalledWith(
        'S',
        'abc123def456',
        now,
      );
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  describe('readPendingHumanRequest', () => {
    it('returns the typed marker when structurally valid', () => {
      const state: ConversationState = {
        senderId: 'S',
        lastMessageAt: now,
        data: {
          pendingHumanRequest: {
            requestId: 'abc123def456',
            ref: 'HF-abc123def456',
            createdAt: now,
            customerNotifiedAt: now,
          },
        },
      };
      const marker = readPendingHumanRequest(state);
      expect(marker).toEqual({
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: now,
        customerNotifiedAt: now,
      });
    });

    it('returns null when the state is null', () => {
      expect(readPendingHumanRequest(null)).toBeNull();
    });

    it('returns null when the marker is missing', () => {
      const state: ConversationState = {
        senderId: 'S',
        lastMessageAt: now,
        data: { messages: [] },
      };
      expect(readPendingHumanRequest(state)).toBeNull();
    });

    it('returns null when the marker is malformed (missing ref)', () => {
      // Intentionally malformed marker: missing `ref`/`customerNotifiedAt`.
      // The single explicit cast models a hostile legacy/partial payload that
      // the pure reader must reject at runtime; the misshapen shape is the
      // whole point of the case, so it cannot be widened to a valid marker.
      const state: ConversationState = {
        senderId: 'S',
        lastMessageAt: now,
        data: {
          pendingHumanRequest: {
            requestId: 'x',
            createdAt: now,
          } as ConversationState['data']['pendingHumanRequest'],
        },
      };
      expect(readPendingHumanRequest(state)).toBeNull();
    });

    it('does NOT mutate the input state', () => {
      const state: ConversationState = {
        senderId: 'S',
        lastMessageAt: now,
        data: {
          pendingHumanRequest: {
            requestId: 'abc123def456',
            ref: 'HF-abc123def456',
            createdAt: now,
            customerNotifiedAt: now,
          },
        },
      };
      const before = JSON.parse(JSON.stringify(state)) as ConversationState;
      readPendingHumanRequest(state);
      expect(state).toEqual(before);
    });
  });
});
