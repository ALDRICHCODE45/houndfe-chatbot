import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import { EMPTY_CART } from '../domain/cart-state';
import {
  clearPlacedSaleId,
  persistConfirmedSale,
  readPlacedSaleId,
} from './placed-sale-persistence';

/**
 * Unit tests for the placed-sale-id lifecycle helpers (design.md §d).
 *
 * Spec contract (sale-flow-tools spec §"placedSaleId lifecycle"):
 *   - readPlacedSaleId(state) returns `null` for: a null state, a state
 *     whose `data` lacks the key, and a state whose `data.placedSaleId`
 *     is not a non-empty string.
 *   - readPlacedSaleId(state) returns the string when present + well-shaped.
 *   - persistConfirmedSale issues exactly ONE ConversationStore.update
 *     with `data: { ...prevData, cart: EMPTY_CART, placedSaleId: <saleId> }`
 *     and the existing lastMessageAt (no extra cart clear write).
 *   - clearPlacedSaleId issues exactly ONE ConversationStore.update
 *     with the placedSaleId key REMOVED (`delete data.placedSaleId`) and
 *     the prior `cart` preserved (no cart clobber).
 */
describe('placed-sale-persistence', () => {
  describe('readPlacedSaleId', () => {
    it('returns null when state is null', () => {
      expect(readPlacedSaleId(null)).toBeNull();
    });

    it('returns null when data has no placedSaleId key', () => {
      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-08-25T12:00:00.000Z',
        data: { messages: [] },
      };
      expect(readPlacedSaleId(state)).toBeNull();
    });

    it('returns null when placedSaleId is an empty string', () => {
      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-08-25T12:00:00.000Z',
        data: { placedSaleId: '' },
      };
      expect(readPlacedSaleId(state)).toBeNull();
    });

    it('returns null when placedSaleId is not a string (number)', () => {
      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-08-25T12:00:00.000Z',
        // Bypass the typed field via the index signature.
        data: { placedSaleId: 12345 as unknown as string },
      };
      expect(readPlacedSaleId(state)).toBeNull();
    });

    it('returns the string when placedSaleId is present and non-empty', () => {
      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-08-25T12:00:00.000Z',
        data: { placedSaleId: 'sale-1' },
      };
      expect(readPlacedSaleId(state)).toBe('sale-1');
    });
  });

  describe('persistConfirmedSale', () => {
    it('calls store.update exactly once with cart=EMPTY_CART and placedSaleId set, preserving other data keys', async () => {
      const update = jest
        .fn()
        .mockImplementation((senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        }));
      const store = { update } as unknown as ConversationStore;

      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          messages: [{ role: 'user', content: 'hola' }],
          cart: {
            items: [
              {
                productId: 'p-1',
                quantity: 1,
                unitPriceCents: 1000,
              },
            ],
            idempotencyKey: 'k',
          },
        },
      };

      const result = await persistConfirmedSale(store, 's', state, 'sale-1');

      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = update.mock.calls[0]! as [
        string,
        { lastMessageAt: string; data: Record<string, unknown> },
      ];
      expect(senderId).toBe('s');
      expect(patch.lastMessageAt).toBe('2026-06-23T12:00:00.000Z');
      // cart cleared (EMPTY_CART), placedSaleId set, other keys preserved.
      expect(patch.data.cart).toEqual(EMPTY_CART);
      expect(patch.data.placedSaleId).toBe('sale-1');
      expect(patch.data.messages).toEqual([{ role: 'user', content: 'hola' }]);
      // Sanity: returns the persisted state shape from the store mock.
      expect(result).toBeDefined();
    });

    it('overwrites a prior placedSaleId with the new saleId', async () => {
      const update = jest
        .fn()
        .mockImplementation((senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        }));
      const store = { update } as unknown as ConversationStore;

      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { placedSaleId: 'sale-1' },
      };

      await persistConfirmedSale(store, 's', state, 'sale-2');

      expect(update).toHaveBeenCalledTimes(1);
      const [, patch] = update.mock.calls[0]! as [
        string,
        { data: { placedSaleId: string } },
      ];
      expect(patch.data.placedSaleId).toBe('sale-2');
    });

    it('works when state is null (fresh sender) — spreads {} and sets cart + placedSaleId', async () => {
      const update = jest
        .fn()
        .mockImplementation((senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        }));
      const store = { update } as unknown as ConversationStore;

      await persistConfirmedSale(store, 's', null, 'sale-1');

      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = update.mock.calls[0]! as [
        string,
        { lastMessageAt: string; data: Record<string, unknown> },
      ];
      expect(senderId).toBe('s');
      expect(patch.data.cart).toEqual(EMPTY_CART);
      expect(patch.data.placedSaleId).toBe('sale-1');
      // lastMessageAt is a fresh ISO timestamp when state is null.
      expect(typeof patch.lastMessageAt).toBe('string');
      expect(Number.isFinite(new Date(patch.lastMessageAt).getTime())).toBe(
        true,
      );
    });
  });

  describe('clearPlacedSaleId', () => {
    it('calls store.update exactly once with placedSaleId removed and the prior cart preserved', async () => {
      const update = jest
        .fn()
        .mockImplementation((senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        }));
      const store = { update } as unknown as ConversationStore;

      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          placedSaleId: 'sale-1',
          cart: EMPTY_CART,
          messages: [{ role: 'assistant', content: 'listo' }],
        },
      };

      await clearPlacedSaleId(store, 's', state);

      expect(update).toHaveBeenCalledTimes(1);
      const [senderId, patch] = update.mock.calls[0]! as [
        string,
        { lastMessageAt: string; data: Record<string, unknown> },
      ];
      expect(senderId).toBe('s');
      expect(patch.lastMessageAt).toBe('2026-06-23T12:00:00.000Z');
      // The placedSaleId key MUST be removed (not set to undefined / null).
      expect('placedSaleId' in patch.data).toBe(false);
      // Other keys preserved.
      expect(patch.data.cart).toEqual(EMPTY_CART);
      expect(patch.data.messages).toEqual([
        { role: 'assistant', content: 'listo' },
      ]);
    });

    it('is a no-op for the data payload when there is no placedSaleId key (still writes once)', async () => {
      const update = jest
        .fn()
        .mockImplementation((senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        }));
      const store = { update } as unknown as ConversationStore;

      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      };

      await clearPlacedSaleId(store, 's', state);

      expect(update).toHaveBeenCalledTimes(1);
      const [, patch] = update.mock.calls[0]! as [
        string,
        { data: Record<string, unknown> },
      ];
      expect('placedSaleId' in patch.data).toBe(false);
      expect(patch.data.messages).toEqual([]);
    });

    it('works when state is null — still writes once with a fresh lastMessageAt', async () => {
      const update = jest
        .fn()
        .mockImplementation((senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        }));
      const store = { update } as unknown as ConversationStore;

      await clearPlacedSaleId(store, 's', null);

      expect(update).toHaveBeenCalledTimes(1);
      const [, patch] = update.mock.calls[0]! as [
        string,
        { lastMessageAt: string },
      ];
      expect(typeof patch.lastMessageAt).toBe('string');
      expect(Number.isFinite(new Date(patch.lastMessageAt).getTime())).toBe(
        true,
      );
    });
  });
});
