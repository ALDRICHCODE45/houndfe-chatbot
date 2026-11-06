import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { clearPendingZoneQuote } from './clear-pending-zone-quote';

const SENDER = '5215512345678';
const AT = '2026-11-05T10:00:00.000Z';

async function seed(shipping: unknown) {
  const store = new InMemoryConversationStore();
  const cart = { items: [], idempotencyKey: '', shipping };
  await store.commitMinimalCart(SENDER, undefined, cart, AT);
  return store;
}

describe('clearPendingZoneQuote', () => {
  it('removes a stored PENDING-zone quote and keeps the rest of the cart', async () => {
    const store = await seed({ zoneStatus: 'PENDING', quoteId: null });
    await clearPendingZoneQuote(store, SENDER);
    const state = await store.get(SENDER);
    expect(state?.data.minimalCart).toEqual({ items: [], idempotencyKey: '' });
    expect(state?.lastMessageAt).toBe(AT);
  });

  it.each([
    ['a live quote', { zoneStatus: 'FREE', quoteId: 'q' }],
    ['pickup', { mode: 'pickup', cartPin: [] }],
  ])('leaves %s untouched', async (_label, shipping) => {
    const store = await seed(shipping);
    await clearPendingZoneQuote(store, SENDER);
    expect(
      (await store.get(SENDER))?.data.minimalCart as { shipping: unknown },
    ).toMatchObject({ shipping });
  });

  it('is a no-op without a conversation', async () => {
    const store = new InMemoryConversationStore();
    await expect(clearPendingZoneQuote(store, SENDER)).resolves.toBeUndefined();
  });
});
