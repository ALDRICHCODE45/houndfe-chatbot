import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  MinimalCartService,
  minimalCartReply,
  parseMinimalCart,
} from './minimal-cart.service';

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

const shipping = {
  quoteId: 'quote-1',
  rateId: 'rate-1',
  carrierName: 'Carrier',
  serviceName: 'Ground',
  estimatedDeliveryDays: null,
  bestRateCents: 10000,
  totalCreditCents: 0,
  customerPaysCents: 10000,
  cartLines: [
    {
      productId: PRODUCT,
      quantity: 2,
      unitPriceCents: 1000,
      finalPriceCents: 1900,
    },
  ],
  addressId: OTHER,
  addressVersion: '2026-06-22T12:00:00.000Z',
  createdAt: '2026-06-22T12:00:00.000Z',
  expiresAt: '2026-06-22T12:30:00.000Z',
  approval: { state: 'pending', requestId: 'request-1' },
};
describe('Minimal cart public operations', () => {
  it.each([
    ['Discount', 'promoción: Discount, ahorro'],
    [null, 'descuento: ahorro'],
    ['', 'descuento: ahorro'],
    ['   ', 'descuento: ahorro'],
  ])(
    '[S5] renders a discounted and a normal cart line (title %j)',
    async (title, label) => {
      const f = setup();
      await f.store.commitMinimalCart(
        SENDER,
        undefined,
        {
          items: [
            { productId: PRODUCT, quantity: 2, unitPriceCents: 1000 },
            { productId: OTHER, quantity: 1, unitPriceCents: 1000 },
          ],
          idempotencyKey: '',
        },
        shipping.createdAt,
      );
      f.api.getStock.mockImplementation(
        async (productId) =>
          ({
            ...f.stock,
            productId,
          }) as never,
      );
      f.api.searchCatalog.mockResolvedValue([
        f.item,
        { ...f.item, productId: OTHER, name: 'Normal' },
      ] as never);
      f.api.evaluateCart.mockImplementation(async (items) => ({
        items: items.map((item) => ({
          ...item,
          variantId: null,
          originalPriceCents: item.quantity * item.unitPriceCents,
          finalPriceCents:
            item.quantity * item.unitPriceCents -
            (item.productId === PRODUCT ? 100 : 0),
          appliedPromotionTitle:
            item.productId === PRODUCT ? title : 'No discount',
          discountAmountCents: item.productId === PRODUCT ? 100 : 0,
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }));
      const result = await f.service.view(SENDER);
      expect(minimalCartReply(result)).toBe(
        [
          'Su carrito:',
          `• Product: 2 × $10.00 MXN; importe $19.00 MXN (${label} $1.00 MXN)`,
          '• Normal: 1 × $10.00 MXN; importe $10.00 MXN',
          'Total de productos: $29.00 MXN.',
          'No incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
        ].join('\n'),
      );
      expect(result).toMatchObject({
        ok: true,
        items: [
          { appliedPromotionTitle: title, discountAmountCents: 100 },
          { appliedPromotionTitle: 'No discount', discountAmountCents: 0 },
        ],
      });
    },
  );

  it.each([42, false, {}, [], undefined])(
    '[S5] rejects malformed promotion title %j without a cart write',
    async (title) => {
      const f = setup();
      f.api.evaluateCart.mockResolvedValue({
        items: [
          {
            productId: PRODUCT,
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
            originalPriceCents: 2000,
            finalPriceCents: 1900,
            discountAmountCents: 100,
            appliedPromotionTitle: title,
          },
        ],
        promotionEvaluationStatus: 'fully_evaluated',
      } as never);
      const before = await f.store.get(SENDER);
      const commit = jest.spyOn(f.store, 'commitMinimalCart');
      expect(
        await f.service.setItem(
          SENDER,
          { productId: PRODUCT, quantity: 2 },
          f.allowed,
        ),
      ).toEqual({ ok: false, error: 'invalid_evaluation' });
      expect(commit).not.toHaveBeenCalled();
      expect(await f.store.get(SENDER)).toEqual(before);
    },
  );

  it.each([
    'remove',
    'unknown',
    'variant',
    'locked',
    'noop',
    'conflict',
    'pricing',
    'empty',
  ] as const)(
    '[S3] keep-only %s validates all identities before one CAS, never retries',
    async (mode) => {
      const f = setup();
      const items = [
        { productId: PRODUCT, quantity: 2, unitPriceCents: 1000 },
        {
          productId: OTHER,
          variantId: VARIANT,
          quantity: 4,
          unitPriceCents: 900,
        },
      ];
      await f.store.commitMinimalCart(
        SENDER,
        undefined,
        {
          items: mode === 'noop' ? [items[0]] : items,
          idempotencyKey: mode === 'locked' ? OTHER : '',
        },
        shipping.createdAt,
      );
      const before = await f.store.get(SENDER);
      const commit = jest.spyOn(f.store, 'commitMinimalCart');
      if (mode === 'conflict') commit.mockResolvedValue(false);
      if (mode === 'pricing')
        f.api.evaluateCart.mockResolvedValue({
          items: [],
          promotionEvaluationStatus: 'fully_evaluated',
        });
      const keep =
        mode === 'empty'
          ? []
          : mode === 'unknown'
            ? [{ productId: PRODUCT }, { productId: VARIANT }]
            : mode === 'variant'
              ? [{ productId: OTHER }]
              : [{ productId: PRODUCT }, { productId: PRODUCT }];
      const result = await f.service.keepOnly(SENDER, keep);
      if (mode === 'remove' || mode === 'noop')
        expect(result).toMatchObject({
          ok: true,
          items: [{ productId: PRODUCT, quantity: 2 }],
        });
      else
        expect(result).toEqual({
          ok: false,
          error:
            mode === 'locked'
              ? 'order_unresolved'
              : mode === 'conflict'
                ? 'cart_changed'
                : mode === 'pricing'
                  ? 'invalid_evaluation'
                  : 'unknown_cart_line',
        });
      expect(commit).toHaveBeenCalledTimes(
        mode === 'remove' || mode === 'conflict' ? 1 : 0,
      );
      if (mode === 'remove')
        expect((await f.store.get(SENDER))?.data.minimalCart).toEqual({
          items: [items[0]],
          idempotencyKey: '',
          expectedTotalCents: 1900,
        });
      else expect(await f.store.get(SENDER)).toEqual(before);
    },
  );
  it('[S1,S4] accepts strict optional shipping and rejects malformed sub-records', () => {
    const cart = { items: [], idempotencyKey: '', shipping };
    expect(parseMinimalCart(cart)).toEqual(cart);
    expect(
      parseMinimalCart({ ...cart, shipping: { ...shipping, extra: true } }),
    ).toBeNull();
    expect(
      parseMinimalCart({
        ...cart,
        shipping: { ...shipping, customerPaysCents: -1 },
      }),
    ).toBeNull();
    expect(parseMinimalCart({ items: [], idempotencyKey: '' })).not.toBeNull();
  });
  it.each(['set', 'adjust'] as const)(
    '[S4] %s item changes drop shipping without touching sibling slots',
    async (operation) => {
      const f = setup();
      await f.store.create(SENDER, {
        lastMessageAt: shipping.createdAt,
        data: { shippingApproval: { legacy: true } },
      });
      // Seed through the owned CAS, matching the clone realm of cart writes.
      await f.store.commitMinimalCart(
        SENDER,
        undefined,
        {
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1000 }],
          idempotencyKey: '',
          shipping,
        },
        shipping.createdAt,
      );
      const result =
        operation === 'set'
          ? await f.service.setItem(
              SENDER,
              { productId: PRODUCT, quantity: 3 },
              f.allowed,
            )
          : await f.service.adjustItem(
              SENDER,
              { productId: PRODUCT, delta: 1 },
              f.allowed,
            );
      expect(result).toMatchObject({ ok: true });
      const data = (await f.store.get(SENDER))!.data;
      expect(data.minimalCart).not.toHaveProperty('shipping');
      expect(data.shippingApproval).toEqual({ legacy: true });
    },
  );
  it.each(['set', 'adjust'] as const)(
    '[S4; inherited order S7] %s preserves shipping and outstanding key under the uncertain-order lock',
    async (operation) => {
      const f = setup();
      await f.store.commitMinimalCart(
        SENDER,
        undefined,
        {
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1000 }],
          idempotencyKey: OTHER,
          shipping,
        },
        shipping.createdAt,
      );
      const before = structuredClone(await f.store.get(SENDER));
      const commit = jest.spyOn(f.store, 'commitMinimalCart');
      const result =
        operation === 'set'
          ? await f.service.setItem(
              SENDER,
              { productId: PRODUCT, quantity: 3 },
              f.allowed,
            )
          : await f.service.adjustItem(
              SENDER,
              { productId: PRODUCT, delta: 1 },
              f.allowed,
            );
      expect(result).toEqual({ ok: false, error: 'order_unresolved' });
      expect(commit).not.toHaveBeenCalled();
      expect(f.api.getStock).not.toHaveBeenCalled();
      expect(await f.store.get(SENDER)).toEqual(before);
    },
  );
  it('keeps invalid_variant and unchanged cart when a diagnostic observer throws', async () => {
    const f = setup();
    const observer = jest.fn(() => {
      throw new Error('private diagnostic failure');
    });
    const invoke: (
      senderId: string,
      input: { productId: string; variantId: string; quantity: number },
      allowedIds: ReadonlySet<string>,
      diagnostic: () => void,
    ) => ReturnType<MinimalCartService['setItem']> = f.service.setItem.bind(
      f.service,
    );
    const commit = jest.spyOn(f.store, 'commitMinimalCart');
    const before = await f.service.view(SENDER);
    expect(
      await invoke(
        SENDER,
        { productId: PRODUCT, variantId: VARIANT, quantity: 1 },
        f.allowed,
        observer,
      ),
    ).toEqual({ ok: false, error: 'invalid_variant' });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(f.api.evaluateCart).not.toHaveBeenCalled();
    expect(await f.service.view(SENDER)).toEqual(before);
  });

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
