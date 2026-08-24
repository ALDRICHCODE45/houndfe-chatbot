/* eslint-disable @typescript-eslint/no-unsafe-assignment, */

import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import { persistCart } from './cart-persistence';
import type { CartState } from '../domain/cart-state';

/**
 * Unit tests for the cart-persistence helper.
 *
 * Spec contract (conversation-store spec + design "Cart State Design"):
 *   - persistCart performs a whole-object `data` replace (no JSONB deep
 *     merge at the storage layer).
 *   - The existing `data.messages` is preserved when `nextCart` only sets
 *     `cart` (because the caller's `nextCart` is the merged cart value,
 *     and `data` is replaced as a whole — see persistCart implementation).
 *   - `lastMessageAt` from the supplied state is preserved when present;
 *     otherwise the helper falls back to `new Date().toISOString()`.
 */
describe('persistCart', () => {
  it('calls store.update with a whole data object replacing the existing data', async () => {
    const update = jest.fn().mockResolvedValue({});
    const store = { update } as unknown as ConversationStore;

    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: {
        messages: [{ role: 'user', content: 'hola' }],
      },
    };
    const nextCart: CartState = {
      items: [{ productId: 'p1', quantity: 1, unitPriceCents: 500 }],
      idempotencyKey: 'k',
    };

    await persistCart(store, 's', state, nextCart);

    expect(update).toHaveBeenCalledTimes(1);
    const [senderId, patch] = update.mock.calls[0]!;
    expect(senderId).toBe('s');
    expect(patch).toEqual({
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: {
        messages: [{ role: 'user', content: 'hola' }],
        cart: nextCart,
      },
    });
  });

  it('preserves the existing lastMessageAt when state is non-null', async () => {
    const update = jest.fn().mockResolvedValue({});
    const store = { update } as unknown as ConversationStore;
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-22T10:00:00.000Z',
      data: {},
    };
    await persistCart(store, 's', state, { items: [], idempotencyKey: '' });
    const [, patch] = update.mock.calls[0]!;
    expect(patch).toMatchObject({ lastMessageAt: '2026-06-22T10:00:00.000Z' });
  });

  it('falls back to a fresh ISO timestamp when state is null', async () => {
    const update = jest.fn().mockResolvedValue({});
    const store = { update } as unknown as ConversationStore;
    await persistCart(store, 's', null, { items: [], idempotencyKey: '' });
    const [, patch] = update.mock.calls[0]! as [
      string,
      { lastMessageAt: string },
    ];
    expect(typeof patch.lastMessageAt).toBe('string');
    expect(Number.isFinite(new Date(patch.lastMessageAt).getTime())).toBe(true);
  });

  it('replaces data wholesale (the cart key wins, but data.messages is preserved by caller)', async () => {
    const update = jest.fn().mockResolvedValue({});
    const store = { update } as unknown as ConversationStore;
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: {
        messages: [{ role: 'assistant', content: 'hola' }],
      },
    };
    const nextCart: CartState = {
      items: [{ productId: 'p2', quantity: 3, unitPriceCents: 1500 }],
      idempotencyKey: 'k2',
    };
    await persistCart(store, 's', state, nextCart);
    const [, patch] = update.mock.calls[0]! as [
      string,
      { data: { messages: unknown; cart: CartState } },
    ];
    // data is replaced as a whole; the caller-provided messages + cart is the
    // final shape the store receives.
    expect(patch.data.messages).toEqual([
      { role: 'assistant', content: 'hola' },
    ]);
    expect(patch.data.cart).toEqual(nextCart);
  });
});
