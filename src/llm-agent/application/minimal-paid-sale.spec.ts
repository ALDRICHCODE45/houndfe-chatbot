import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { parseMinimalCart } from './minimal-cart.service';
import { markPlacedSalePaid } from './minimal-paid-sale';

const SENDER = '5215550001111';
const SALE = '55555555-5555-4555-8555-555555555555';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const LAST_MESSAGE_AT = '2026-11-16T10:00:00.000Z';

const seed = (
  store: InMemoryConversationStore,
  placedSale: object | undefined,
  items: object[] = [],
) =>
  store.create(SENDER, {
    lastMessageAt: LAST_MESSAGE_AT,
    data: {
      minimalCart: {
        items,
        idempotencyKey: '',
        ...(placedSale === undefined ? {} : { placedSale }),
      },
    },
  });
const stored = async (store: InMemoryConversationStore) => ({
  state: await store.get(SENDER),
  cart: parseMinimalCart((await store.get(SENDER))?.data.minimalCart),
});
const placed = { saleId: SALE, folio: 'B-0042', totalCents: 3000 };

describe('markPlacedSalePaid (S6)', () => {
  it('marks the matching placed sale paid, clears paymentPending and keeps the rest', async () => {
    const store = new InMemoryConversationStore();
    const items = [{ productId: PRODUCT, quantity: 1, unitPriceCents: 1500 }];
    await seed(store, { ...placed, paymentPending: true }, items);
    await expect(markPlacedSalePaid(store, SENDER, SALE)).resolves.toBe(true);
    const { state, cart } = await stored(store);
    expect(cart?.placedSale).toEqual({ ...placed, paid: true });
    expect(cart?.items).toEqual(items);
    // Not a customer message: the idle clock is untouched.
    expect(state?.lastMessageAt).toBe(LAST_MESSAGE_AT);
  });

  it('is idempotent for an already paid sale', async () => {
    const store = new InMemoryConversationStore();
    await seed(store, { ...placed, paid: true });
    await expect(markPlacedSalePaid(store, SENDER, SALE)).resolves.toBe(true);
    expect((await stored(store)).cart?.placedSale).toEqual({
      ...placed,
      paid: true,
    });
  });

  it('does nothing for another sale, no placed sale or an unknown sender', async () => {
    const store = new InMemoryConversationStore();
    await seed(store, placed);
    await expect(
      markPlacedSalePaid(store, SENDER, '66666666-6666-4666-8666-666666666666'),
    ).resolves.toBe(false);
    expect((await stored(store)).cart?.placedSale).toEqual(placed);
    await expect(markPlacedSalePaid(store, 'nobody', SALE)).resolves.toBe(
      false,
    );
    const empty = new InMemoryConversationStore();
    await seed(empty, undefined);
    await expect(markPlacedSalePaid(empty, SENDER, SALE)).resolves.toBe(false);
  });

  it('retries once on a lost CAS race', async () => {
    const store = new InMemoryConversationStore();
    await seed(store, placed);
    const commit = jest
      .spyOn(store, 'commitMinimalCart')
      .mockResolvedValueOnce(false);
    await expect(markPlacedSalePaid(store, SENDER, SALE)).resolves.toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect((await stored(store)).cart?.placedSale?.paid).toBe(true);
  });

  it('gives up quietly after the second lost race and leaves the order unpaid', async () => {
    const store = new InMemoryConversationStore();
    await seed(store, placed);
    const commit = jest
      .spyOn(store, 'commitMinimalCart')
      .mockResolvedValue(false);
    await expect(markPlacedSalePaid(store, SENDER, SALE)).resolves.toBe(false);
    expect(commit).toHaveBeenCalledTimes(2);
    expect((await stored(store)).cart?.placedSale).toEqual(placed);
  });

  it('never throws when the store fails', async () => {
    const store = new InMemoryConversationStore();
    await seed(store, placed);
    jest.spyOn(store, 'get').mockRejectedValue(new Error('down'));
    await expect(markPlacedSalePaid(store, SENDER, SALE)).resolves.toBe(false);
  });
});
