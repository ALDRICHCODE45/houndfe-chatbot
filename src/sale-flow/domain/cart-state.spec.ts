import type { ConversationState } from '../../conversation/domain/conversation-store';
import { EMPTY_CART, readCart, writeCart } from './cart-state';

/**
 * Unit tests for the per-sender cart state helpers.
 *
 * Spec scenarios:
 *   - Missing cart defaults to empty
 *   - writeCart shallow-merges over existing cart without touching other data keys
 *   - cart round-trips through a stubbed ConversationStore
 */
describe('cart-state', () => {
  describe('readCart', () => {
    it('returns EMPTY_CART when state is null', () => {
      expect(readCart(null)).toEqual(EMPTY_CART);
    });

    it('returns EMPTY_CART when state has no data.cart key', () => {
      const state: ConversationState = {
        senderId: '5215550001111',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      };
      expect(readCart(state)).toEqual(EMPTY_CART);
    });

    it('returns EMPTY_CART when data.cart has the wrong shape (not items+idempotencyKey)', () => {
      const state = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: { something: 'else' } },
      };
      expect(readCart(state)).toEqual(EMPTY_CART);
    });

    it('returns the typed cart when data.cart is a valid CartState', () => {
      const state = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          cart: {
            items: [{ productId: 'p1', quantity: 2, unitPriceCents: 1000 }],
            idempotencyKey: 'key-1',
          },
        },
      };
      expect(readCart(state)).toEqual({
        items: [{ productId: 'p1', quantity: 2, unitPriceCents: 1000 }],
        idempotencyKey: 'key-1',
      });
    });
  });

  describe('writeCart', () => {
    it('returns a fresh empty cart when state is null and patch is empty', () => {
      expect(writeCart(null, {})).toEqual(EMPTY_CART);
    });

    it('shallow-merges a patch over the existing cart without touching other data keys', () => {
      const state: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          messages: [{ role: 'user', content: 'hola' }],
        },
      };
      const next = writeCart(state, {
        items: [{ productId: 'p1', quantity: 1, unitPriceCents: 500 }],
        idempotencyKey: 'fresh-key',
      });
      expect(next).toEqual({
        items: [{ productId: 'p1', quantity: 1, unitPriceCents: 500 }],
        idempotencyKey: 'fresh-key',
      });
      // writeCart is pure: state.data.messages is preserved untouched.
      expect(state.data.messages).toEqual([{ role: 'user', content: 'hola' }]);
    });

    it('preserves existing cart fields when patch only overrides some keys', () => {
      const state = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          cart: {
            items: [{ productId: 'p1', quantity: 2, unitPriceCents: 1000 }],
            idempotencyKey: 'existing-key',
          },
        },
      };
      const next = writeCart(state, {
        items: [
          { productId: 'p1', quantity: 2, unitPriceCents: 1000 },
          { productId: 'p2', quantity: 1, unitPriceCents: 250 },
        ],
      });
      expect(next).toEqual({
        items: [
          { productId: 'p1', quantity: 2, unitPriceCents: 1000 },
          { productId: 'p2', quantity: 1, unitPriceCents: 250 },
        ],
        // idempotencyKey preserved from the existing cart.
        idempotencyKey: 'existing-key',
      });
    });
  });
});
