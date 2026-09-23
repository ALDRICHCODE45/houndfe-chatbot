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
 *   - setPendingHumanRequest issues exactly one store.update with
 *     shallow-spread data carrying the marker + lastMessageAt.
 *   - clearPendingHumanRequest issues exactly one store.update with
 *     pendingHumanRequest=null; sibling keys are preserved.
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
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
      clearPendingHumanRequest: jest.fn(),
    };
    return { store, existing };
  }

  describe('setPendingHumanRequest', () => {
    it('issues exactly one store.update carrying the marker + lastMessageAt', async () => {
      const { store, existing } = buildStore();
      const marker = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: now,
        customerNotifiedAt: now,
      };

      await setPendingHumanRequest(store, 'S', existing, marker, now);

      expect(store.update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = store.update.mock.calls[0];
      expect(senderId).toBe('S');
      expect(patch).toMatchObject({
        lastMessageAt: now,
        data: {
          messages: existing.data.messages,
          cart: existing.data.cart,
          placedSaleId: existing.data.placedSaleId,
          pendingHumanRequest: marker,
        },
      });
    });

    it('handles a missing prior state by spreading an empty data bag', async () => {
      const { store } = buildStore();
      const marker = {
        requestId: 'abc123def456',
        ref: 'HF-abc123def456',
        createdAt: now,
        customerNotifiedAt: now,
      };

      await setPendingHumanRequest(store, 'S', null, marker, now);

      expect(store.update).toHaveBeenCalledTimes(1);
      const [, patch] = store.update.mock.calls[0];
      expect(patch).toMatchObject({
        lastMessageAt: now,
        data: { pendingHumanRequest: marker },
      });
    });
  });

  describe('clearPendingHumanRequest', () => {
    it('issues exactly one store.update with pendingHumanRequest=null and preserves siblings', async () => {
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

      await clearPendingHumanRequest(store, 'S', withMarker);

      expect(store.update).toHaveBeenCalledTimes(1);
      const [, patch] = store.update.mock.calls[0];
      expect(patch).toMatchObject({
        lastMessageAt: existing.lastMessageAt,
        data: {
          messages: existing.data.messages,
          cart: existing.data.cart,
          placedSaleId: existing.data.placedSaleId,
          pendingHumanRequest: null,
        },
      });
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
      // Persisted conversation rows arrive as untyped JSONB, so a stored
      // marker can be missing `ref` even though the compile-time contract
      // requires it. Populate the raw value through Object.assign instead of
      // asserting completeness with a cast, keeping the malformed shape honest.
      const data: ConversationState['data'] = { messages: [] };
      Object.assign(data, {
        pendingHumanRequest: {
          requestId: 'x',
          createdAt: now,
          customerNotifiedAt: now,
        },
      });
      const state: ConversationState = {
        senderId: 'S',
        lastMessageAt: now,
        data,
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
