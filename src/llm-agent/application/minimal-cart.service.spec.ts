import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { MinimalCartService } from './minimal-cart.service';

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SENDER = 'sender-a';
function setup() {
  const store = new InMemoryConversationStore();
  const item = {
    productId: PRODUCT,
    name: 'Product',
    price: { priceCents: 1000 },
    variants: [],
  };
  const stock = {
    productId: PRODUCT,
    name: 'Product',
    stock: { status: 'available', quantity: 10 },
    variants: [],
  };
  const api = {
    searchCatalog: jest.fn().mockResolvedValue([item]),
    getStock: jest.fn().mockResolvedValue(stock),
    evaluateCart: jest.fn().mockImplementation(
      (
        items: Array<{
          productId: string;
          variantId?: string;
          quantity: number;
          unitPriceCents: number;
        }>,
      ) => ({
        items: items.map((i) => ({
          ...i,
          variantId: i.variantId ?? null,
          originalPriceCents: i.quantity * i.unitPriceCents,
          finalPriceCents: i.quantity * i.unitPriceCents - 100,
          discountAmountCents: 100,
          appliedPromotionTitle: 'Discount',
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }),
    ),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  return {
    store,
    api,
    item,
    stock,
    service: new MinimalCartService(api, store),
    allowed: new Set([PRODUCT]),
  };
}

describe('Minimal cart public operations', () => {
  it('adds, views after a fresh service, replaces total quantity and removes without creating a sale', async () => {
    const f = setup();
    expect(
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 2 },
        f.allowed,
      ),
    ).toMatchObject({ ok: true, totalCents: 1900 });
    expect(f.api.evaluateCart).toHaveBeenCalledWith([
      { productId: PRODUCT, quantity: 2, unitPriceCents: 1000 },
    ]);
    const restarted = new MinimalCartService(f.api, f.store);
    expect(await restarted.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ productId: PRODUCT, quantity: 2 }],
      totalCents: 1900,
    });
    expect(
      await restarted.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 3 },
        new Set(),
      ),
    ).toMatchObject({ ok: true, totalCents: 2900 });
    expect(
      await restarted.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 3 },
        new Set(),
      ),
    ).toMatchObject({ ok: true, totalCents: 2900 });
    expect(
      await restarted.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 0 },
        new Set(),
      ),
    ).toMatchObject({ ok: true, items: [], totalCents: 0 });
    expect(await f.service.view('sender-b')).toMatchObject({
      ok: true,
      items: [],
      totalCents: 0,
    });
  });

  it('preserves live human, shipping, checkout and transcript fields across cart writes and stale generic updates', async () => {
    const f = setup();
    const siblings = {
      pendingHumanRequest: null,
      shippingApproval: { id: 'approval' },
      placedSaleId: 'old-sale',
      cart: { legacy: true },
      messages: [],
    };
    await f.store.create(SENDER, {
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      data: siblings,
    });
    await f.service.setItem(
      SENDER,
      { productId: PRODUCT, quantity: 2 },
      f.allowed,
    );
    expect((await f.store.get(SENDER))?.data).toMatchObject(siblings);
    const snapshot = (await f.store.get(SENDER))!;
    await f.service.setItem(
      SENDER,
      { productId: PRODUCT, quantity: 3 },
      f.allowed,
    );
    await f.store.update(SENDER, {
      lastMessageAt: snapshot.lastMessageAt,
      data: snapshot.data,
    });
    expect(await f.service.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ quantity: 3 }],
    });
  });

  it.each([
    'unknown',
    'quantity',
    'stock',
    'price',
    'evaluation',
    'failure',
    'corrupt',
  ] as const)('rejects %s without changing state', async (reason) => {
    const f = setup();
    await f.service.setItem(
      SENDER,
      { productId: PRODUCT, quantity: 2 },
      f.allowed,
    );
    if (reason === 'stock')
      f.api.getStock.mockResolvedValue({
        ...f.stock,
        stock: { status: 'not_managed', quantity: null },
      } as never);
    if (reason === 'price')
      f.api.searchCatalog.mockResolvedValue([
        { ...f.item, price: { priceCents: null } },
      ] as never);
    if (reason === 'evaluation')
      f.api.evaluateCart.mockResolvedValue({
        items: [],
        promotionEvaluationStatus: 'fully_evaluated',
      });
    if (reason === 'failure')
      f.api.getStock.mockRejectedValue(new Error('secret backend text'));
    if (reason === 'corrupt')
      await f.store.create(SENDER, {
        lastMessageAt: '2026-01-01T00:00:00.000Z',
        data: { minimalCart: { broken: true } },
      });
    const before = structuredClone(await f.store.get(SENDER));
    const result = await f.service.setItem(
      SENDER,
      {
        productId: reason === 'unknown' ? OTHER : PRODUCT,
        quantity: reason === 'quantity' ? -1 : 3,
      },
      f.allowed,
    );
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await f.store.get(SENDER)).toEqual(before);
  });

  it('requires an owned variant and its own price/stock, never the parent stock', async () => {
    const f = setup();
    f.api.searchCatalog.mockResolvedValue([
      {
        ...f.item,
        variants: [{ variantId: VARIANT, name: 'Small', priceCents: 700 }],
      },
    ] as never);
    f.api.getStock.mockResolvedValue({
      ...f.stock,
      stock: { status: 'out_of_stock', quantity: 0 },
      variants: [
        {
          variantId: VARIANT,
          name: 'Small',
          stock: { status: 'available', quantity: 2 },
        },
      ],
    } as never);
    expect(
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 1 },
        f.allowed,
      ),
    ).toMatchObject({ ok: false, error: 'variant_required' });
    expect(
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, variantId: OTHER, quantity: 1 },
        f.allowed,
      ),
    ).toMatchObject({ ok: false, error: 'invalid_variant' });
    expect(
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, variantId: VARIANT, quantity: 2 },
        f.allowed,
      ),
    ).toMatchObject({ ok: true, totalCents: 1300 });
    const before = structuredClone(await f.store.get(SENDER));
    expect(
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, variantId: VARIANT, quantity: 3 },
        f.allowed,
      ),
    ).toMatchObject({ ok: false, error: 'insufficient_stock' });
    expect(await f.store.get(SENDER)).toEqual(before);
  });

  it('adds requested units to the stored quantity rather than replacing it', async () => {
    const f = setup();
    await f.service.setItem(
      SENDER,
      { productId: PRODUCT, quantity: 2 },
      f.allowed,
    );
    expect(
      await f.service.adjustItem(
        SENDER,
        { productId: PRODUCT, delta: 2 },
        new Set(),
      ),
    ).toMatchObject({
      ok: true,
      items: [{ productId: PRODUCT, quantity: 4 }],
      totalCents: 3900,
    });
    expect(await f.service.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ quantity: 4 }],
    });
  });

  it.each([2, 1])(
    'subtracts one unit from %i, removing the line at zero',
    async (quantity) => {
      const f = setup();
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, quantity },
        f.allowed,
      );
      const result = await f.service.adjustItem(
        SENDER,
        { productId: PRODUCT, delta: -1 },
        new Set(),
      );
      const expected =
        quantity === 1 ? [] : [{ productId: PRODUCT, quantity: 1 }];
      expect(result).toMatchObject({
        ok: true,
        items: expected,
        totalCents: quantity === 1 ? 0 : 900,
      });
      expect(await f.service.view(SENDER)).toMatchObject({
        ok: true,
        items: expected,
      });
    },
  );

  it('adds to an empty cart and rejects stock overflow without a write or retry', async () => {
    const f = setup();
    const commit = jest.spyOn(f.store, 'commitMinimalCart');
    expect(
      await f.service.adjustItem(
        SENDER,
        { productId: PRODUCT, delta: 2 },
        f.allowed,
      ),
    ).toMatchObject({
      ok: true,
      items: [{ quantity: 2 }],
      totalCents: 1900,
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(
      await f.service.adjustItem(
        SENDER,
        { productId: PRODUCT, delta: 10 },
        new Set(),
      ),
    ).toEqual({ ok: false, error: 'insufficient_stock' });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await f.service.view(SENDER)).toMatchObject({
      ok: true,
      items: [{ quantity: 2 }],
      totalCents: 1900,
    });
  });

  it('holds a lost CAS without retry or claiming success', async () => {
    const f = setup();
    jest.spyOn(f.store, 'commitMinimalCart').mockResolvedValue(false);
    expect(
      await f.service.setItem(
        SENDER,
        { productId: PRODUCT, quantity: 1 },
        f.allowed,
      ),
    ).toMatchObject({ ok: false, error: 'cart_changed' });
    expect(f.store.commitMinimalCart).toHaveBeenCalledTimes(1);
    expect(await f.store.get(SENDER)).toBeNull();
  });
});
