import { createHash } from 'node:crypto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  MinimalCartService,
  minimalCartFingerprint,
  minimalCartReply,
  parseMinimalCart,
} from './minimal-cart.service';
import {
  BO_CROQUETAS,
  BO_FINAL_CENTS,
  BO_ID,
  BO_ID_2,
  BO_PRODUCT,
  BO_SENDER,
  BO_UNTIL,
  backorderCartLine,
  reservedBackorder,
} from './minimal-backorder-checkout.fixtures';

/**
 * Restock backorder T5b (S2, S6, S11): the reserved backorder is its own cart
 * line, priced at its final price outside the promotion base, never merged
 * with, nor edited like, an ordinary line.
 */
const CATALOG: Record<string, { name: string; price: number }> = {
  [BO_PRODUCT]: { name: 'Ibuprofeno', price: 1500 },
  [BO_CROQUETAS]: { name: 'Croquetas Adulto 18 kg', price: 120000 },
};

function setup(
  options: { promoPercent?: number; croquetasStock?: number } = {},
) {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn((name: string) => {
      const entry = Object.entries(CATALOG).find(([, v]) => v.name === name)!;
      return Promise.resolve([
        {
          productId: entry[0],
          name: entry[1].name,
          price: { priceCents: entry[1].price },
          variants: [],
        },
      ]);
    }),
    getStock: jest.fn((productId: string) => {
      const quantity =
        productId === BO_CROQUETAS ? (options.croquetasStock ?? 0) : 10;
      return Promise.resolve({
        productId,
        name: CATALOG[productId].name,
        stock: {
          status: quantity === 0 ? 'out_of_stock' : 'available',
          quantity,
        },
        variants: [],
      });
    }),
    evaluateCart: jest.fn(
      (
        items: Array<{
          productId: string;
          quantity: number;
          unitPriceCents: number;
        }>,
      ) =>
        Promise.resolve({
          items: items.map((item) => {
            const original = item.unitPriceCents * item.quantity;
            const discount = Math.round(
              (original * (options.promoPercent ?? 0)) / 100,
            );
            return {
              productId: item.productId,
              variantId: null,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              originalPriceCents: original,
              finalPriceCents: original - discount,
              discountAmountCents: discount,
              appliedPromotionTitle: discount > 0 ? 'Promo orden' : null,
            };
          }),
          promotionEvaluationStatus: 'fully_evaluated',
        }),
    ),
  };
  const cart = new MinimalCartService(
    api as unknown as ChatbotApiClient,
    store,
  );
  // Seeded through the CAS (like production) so the slot has the same shape
  // as one the service itself wrote.
  const seed = (items: object[], extra: object = {}) =>
    store.commitMinimalCart(
      BO_SENDER,
      undefined,
      { items, idempotencyKey: '', ...extra },
      '2026-10-10T00:00:00.000Z',
    );
  const raw = async () => (await store.get(BO_SENDER))?.data.minimalCart;
  const allowed = new Set([BO_PRODUCT, BO_CROQUETAS]);
  return { store, api, cart, seed, raw, allowed };
}

const BACKORDER = reservedBackorder();

describe('addBackorderLine: the reserved backorder becomes a cart line', () => {
  it('writes a special line at finalPriceCents × quantity, with no catalog or promotion call (S2, S6)', async () => {
    const h = setup();
    const result = await h.cart.addBackorderLine(BO_SENDER, BACKORDER);

    expect(result).toMatchObject({
      ok: true,
      totalCents: 2 * BO_FINAL_CENTS,
      promotionEvaluationStatus: 'fully_evaluated',
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.items).toEqual([
      expect.objectContaining({
        productId: BO_CROQUETAS,
        name: 'Croquetas Adulto 18 kg',
        quantity: 2,
        unitPriceCents: BO_FINAL_CENTS,
        finalPriceCents: 2 * BO_FINAL_CENTS,
        appliedPromotionTitle: null,
        discountAmountCents: 0,
        backorder: backorderCartLine().backorder,
      }),
    ]);
    // Reserved units are not sellable stock and the price is frozen: no
    // catalog read and no promotion call for a backorder-only cart.
    expect(h.api.getStock).not.toHaveBeenCalled();
    expect(h.api.searchCatalog).not.toHaveBeenCalled();
    expect(h.api.evaluateCart).not.toHaveBeenCalled();
    expect(await h.raw()).toEqual({
      items: [backorderCartLine()],
      idempotencyKey: '',
      expectedTotalCents: 2 * BO_FINAL_CENTS,
    });
  });

  it('keeps the variant of the backorder and its name', async () => {
    const h = setup();
    const variantId = '66666666-6666-4666-8666-666666666666';
    const result = await h.cart.addBackorderLine(
      BO_SENDER,
      reservedBackorder({ variantId, variantName: 'Bolsa 18 kg' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.items[0]).toMatchObject({
      variantId,
      variantName: 'Bolsa 18 kg',
    });
  });

  it('evaluates ONLY the ordinary lines; the backorder line is outside the promotion base (S11)', async () => {
    const h = setup({ promoPercent: 10 });
    await h.seed([
      { productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1500 },
    ]);

    const result = await h.cart.addBackorderLine(BO_SENDER, BACKORDER);

    expect(h.api.evaluateCart).toHaveBeenCalledTimes(1);
    expect(h.api.evaluateCart.mock.calls[0][0]).toEqual([
      { productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1500 },
    ]);
    if (!result.ok) throw new Error('unreachable');
    // ordinary 2 × 1500 − 10% = 2700; backorder 2 × 109900 untouched.
    expect(result.totalCents).toBe(2700 + 2 * BO_FINAL_CENTS);
    expect(result.items.map((i) => i.finalPriceCents)).toEqual([
      2700,
      2 * BO_FINAL_CENTS,
    ]);
    expect(result.items[1].discountAmountCents).toBe(0);
  });

  it('never merges into an ordinary line of the same product', async () => {
    const h = setup();
    await h.seed([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
    ]);
    const reserved = reservedBackorder({
      productId: BO_PRODUCT,
      productName: 'Ibuprofeno',
      finalPriceCents: 1200,
    });

    const added = await h.cart.addBackorderLine(BO_SENDER, reserved);
    expect(added.ok && added.items.map((i) => i.quantity)).toEqual([1, 2]);

    // An ordinary «agrega 1 más» / «déjame 5» only touches the ordinary line
    // (an edited line moves to the end, as for every cart write).
    const lines = (result: Awaited<ReturnType<typeof h.cart.view>>) => {
      if (!result.ok) throw new Error('unreachable');
      return result.items.map((i) => [
        i.backorder === undefined ? 'ordinary' : 'backorder',
        i.quantity,
        i.unitPriceCents,
      ]);
    };
    const more = await h.cart.adjustItem(
      BO_SENDER,
      { productId: BO_PRODUCT, delta: 1 },
      h.allowed,
    );
    expect(lines(more)).toEqual([
      ['backorder', 2, 1200],
      ['ordinary', 2, 1500],
    ]);
    const set = await h.cart.setItem(
      BO_SENDER,
      { productId: BO_PRODUCT, quantity: 5 },
      h.allowed,
    );
    expect(lines(set)).toEqual([
      ['backorder', 2, 1200],
      ['ordinary', 5, 1500],
    ]);
  });

  it('adding the same backorder twice keeps one line and does not write again', async () => {
    const h = setup();
    await h.cart.addBackorderLine(BO_SENDER, BACKORDER);
    const before = await h.raw();
    const again = await h.cart.addBackorderLine(BO_SENDER, BACKORDER);
    expect(again.ok && again.items).toHaveLength(1);
    expect(await h.raw()).toEqual(before);
  });

  it('refuses while an order key is outstanding, and without a final price', async () => {
    const h = setup();
    await h.seed(
      [{ productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 }],
      {
        idempotencyKey: '12345678-1234-4234-8234-123456789012',
      },
    );
    const before = await h.raw();
    expect(await h.cart.addBackorderLine(BO_SENDER, BACKORDER)).toEqual({
      ok: false,
      error: 'order_unresolved',
    });
    expect(await h.raw()).toEqual(before);

    const other = setup();
    expect(
      await other.cart.addBackorderLine(
        BO_SENDER,
        reservedBackorder({ finalPriceCents: null }),
      ),
    ).toEqual({ ok: false, error: 'invalid_quantity_or_identity' });
  });
});

describe('the backorder line is immutable except for removal (S6)', () => {
  const withBackorderOnly = async (h: ReturnType<typeof setup>) =>
    h.seed([backorderCartLine()]);

  it('refuses a set or a decrease of its quantity, and leaves the cart as is', async () => {
    const h = setup();
    await withBackorderOnly(h);
    const before = await h.raw();

    for (const request of [
      { productId: BO_CROQUETAS, quantity: 3 },
      { productId: BO_CROQUETAS, quantity: 1 },
    ])
      expect(await h.cart.setItem(BO_SENDER, request, h.allowed)).toEqual({
        ok: false,
        error: 'backorder_line_locked',
      });
    expect(
      await h.cart.adjustItem(
        BO_SENDER,
        { productId: BO_CROQUETAS, delta: -1 },
        h.allowed,
      ),
    ).toEqual({ ok: false, error: 'backorder_line_locked' });
    expect(await h.raw()).toEqual(before);
  });

  it('says so honestly in the customer reply', () => {
    const reply = minimalCartReply({
      ok: false,
      error: 'backorder_line_locked',
    });
    expect(reply).toContain('viene de su pedido apartado');
    expect(reply).toContain('si quiere más, agrego otra línea');
    expect(reply).toContain('Su carrito no fue modificado');
  });

  it('«agrega 1 más» is another, ordinary line (stock permitting)', async () => {
    const h = setup({ croquetasStock: 3 });
    await withBackorderOnly(h);
    const result = await h.cart.adjustItem(
      BO_SENDER,
      { productId: BO_CROQUETAS, delta: 1 },
      h.allowed,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].backorder?.id).toBe(BO_ID);
    expect(result.items[0].unitPriceCents).toBe(BO_FINAL_CENTS);
    expect(result.items[1]).toMatchObject({
      quantity: 1,
      unitPriceCents: 120000,
    });
    expect(result.items[1].backorder).toBeUndefined();
  });

  it('removing it empties the cart and says it stays apartado until the deadline (it is not cancelled)', async () => {
    const h = setup();
    await withBackorderOnly(h);

    const result = await h.cart.setItem(
      BO_SENDER,
      { productId: BO_CROQUETAS, quantity: 0 },
      h.allowed,
    );

    expect(result).toMatchObject({
      ok: true,
      items: [],
      removedBackorders: [{ folio: 'BO-000012', reservedUntil: BO_UNTIL }],
    });
    expect(await h.raw()).toMatchObject({ items: [], idempotencyKey: '' });
    const reply = minimalCartReply({
      ...(result as object),
      // The spec clock is far from the deadline: pin it.
    } as never);
    expect(reply).toContain('Su carrito está vacío.');
    expect(reply).toContain('Su pedido apartado BO-000012');
    expect(reply).toContain('no se canceló al quitarlo del carrito');
  });

  it('the reply names the deadline in Mexico City time while it is in the future', () => {
    jest.useFakeTimers().setSystemTime(Date.parse('2026-11-20T15:00:00.000Z'));
    try {
      const reply = minimalCartReply({
        ok: true,
        items: [],
        totalCents: 0,
        promotionEvaluationStatus: 'fully_evaluated',
        removedBackorders: [{ folio: 'BO-000012', reservedUntil: BO_UNTIL }],
      });
      expect(reply).toBe(
        'Su carrito está vacío.\nSu pedido apartado BO-000012 sigue apartado el 21 de noviembre a las 9:00 a. m.; no se canceló al quitarlo del carrito.',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('with an ordinary line of the same product, «quita» removes the ordinary one first', async () => {
    const h = setup();
    await h.seed([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
      backorderCartLine({ productId: BO_PRODUCT, unitPriceCents: 1200 }),
    ]);

    const first = await h.cart.setItem(
      BO_SENDER,
      { productId: BO_PRODUCT, quantity: 0 },
      h.allowed,
    );
    expect(first.ok && first.items.map((i) => i.backorder?.id)).toEqual([
      BO_ID,
    ]);
    expect(first).not.toHaveProperty('removedBackorders');

    const second = await h.cart.setItem(
      BO_SENDER,
      { productId: BO_PRODUCT, quantity: 0 },
      h.allowed,
    );
    expect(second).toMatchObject({ ok: true, items: [] });
    expect(second).toHaveProperty('removedBackorders');
  });

  it('a model-supplied backorder or price is rejected by the input schema', async () => {
    const h = setup();
    await withBackorderOnly(h);
    const forged = {
      productId: BO_CROQUETAS,
      quantity: 2,
      backorder: backorderCartLine().backorder,
    };
    expect(await h.cart.setItem(BO_SENDER, forged as never, h.allowed)).toEqual(
      { ok: false, error: 'invalid_quantity_or_identity' },
    );
  });
});

describe('keepOnly, refreshPrices and persistence keep the backorder line', () => {
  it('keepOnly keeps the backorder line of a kept product and reports a dropped one', async () => {
    const h = setup();
    await h.seed([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
      backorderCartLine(),
    ]);
    const keptBackorder = await h.cart.keepOnly(BO_SENDER, [
      { productId: BO_CROQUETAS },
    ]);
    expect(
      keptBackorder.ok && keptBackorder.items.map((i) => i.backorder?.id),
    ).toEqual([BO_ID]);
    expect(keptBackorder).not.toHaveProperty('removedBackorders');
  });

  it('keepOnly that drops the backorder line names it', async () => {
    const h = setup();
    await h.seed([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
      backorderCartLine(),
    ]);
    const result = await h.cart.keepOnly(BO_SENDER, [
      { productId: BO_PRODUCT },
    ]);
    expect(result).toMatchObject({
      ok: true,
      removedBackorders: [{ folio: 'BO-000012', reservedUntil: BO_UNTIL }],
    });
  });

  it('refreshPrices never reprices the backorder line from the catalog', async () => {
    const h = setup();
    await h.seed([backorderCartLine()], {
      expectedTotalCents: 2 * BO_FINAL_CENTS,
    });
    const { quote, repriced } = await h.cart.refreshPrices(BO_SENDER);
    expect(repriced).toBe(false);
    expect(quote.ok && quote.items[0].unitPriceCents).toBe(BO_FINAL_CENTS);
    expect(h.api.getStock).not.toHaveBeenCalled();
  });

  it('refreshPrices rewrites the ordinary price and keeps the backorder reservation', async () => {
    const h = setup();
    await h.seed(
      [
        { productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1400 },
        backorderCartLine(),
      ],
      { expectedTotalCents: 2800 + 2 * BO_FINAL_CENTS },
    );
    const { repriced } = await h.cart.refreshPrices(BO_SENDER);
    expect(repriced).toBe(true);
    expect(await h.raw()).toEqual({
      items: [
        { productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1500 },
        backorderCartLine(),
      ],
      idempotencyKey: '',
      expectedTotalCents: 3000 + 2 * BO_FINAL_CENTS,
    });
  });

  it('the fingerprint separates the backorder line from an ordinary one', () => {
    const ordinary = { productId: BO_CROQUETAS, quantity: 2 };
    expect(minimalCartFingerprint([ordinary])).not.toBe(
      minimalCartFingerprint([{ ...ordinary, ...backorderCartLine() }]),
    );
  });

  it('parseMinimalCart accepts both lines of one product and rejects a repeated or malformed backorder', () => {
    const ordinary = {
      productId: BO_CROQUETAS,
      quantity: 1,
      unitPriceCents: 1,
    };
    expect(
      parseMinimalCart({
        items: [ordinary, backorderCartLine()],
        idempotencyKey: '',
      }),
    ).not.toBeNull();
    expect(
      parseMinimalCart({
        items: [backorderCartLine(), backorderCartLine()],
        idempotencyKey: '',
      }),
    ).toBeNull();
    expect(
      parseMinimalCart({
        items: [backorderCartLine(), backorderCartLine({ id: BO_ID_2 })],
        idempotencyKey: '',
      }),
    ).not.toBeNull();
    expect(
      parseMinimalCart({
        items: [
          {
            ...ordinary,
            backorder: { ...backorderCartLine().backorder, extra: true },
          },
        ],
        idempotencyKey: '',
      }),
    ).toBeNull();
  });
});

describe('a cart without backorder lines is untouched (previous behaviour)', () => {
  it('sends the same evaluate-cart request, stores the same slot and words the same reply', async () => {
    const h = setup();
    const result = await h.cart.setItem(
      BO_SENDER,
      { productId: BO_PRODUCT, quantity: 2 },
      h.allowed,
    );

    expect(h.api.evaluateCart).toHaveBeenCalledTimes(1);
    expect(h.api.evaluateCart.mock.calls[0]).toEqual([
      [{ productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1500 }],
      { phoneCountryCode: '52', phone: '5550001111' },
    ]);
    expect(JSON.stringify(await h.raw())).toBe(
      '{"items":[{"productId":"11111111-1111-4111-8111-111111111111","quantity":2,"unitPriceCents":1500}],"idempotencyKey":"","expectedTotalCents":3000}',
    );
    expect(minimalCartReply(result)).toBe(
      '*Su carrito*\n• Ibuprofeno\n   2 × $15.00 = *$30.00*\n\n*Total de productos: $30.00*\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
    );
    expect(result).not.toHaveProperty('removedBackorders');
  });

  it('keeps the fingerprint of ordinary lines unchanged', () => {
    const line = { productId: BO_PRODUCT, variantId: undefined, quantity: 2 };
    const expected = createHash('sha256')
      .update(JSON.stringify([`${BO_PRODUCT}||2`]))
      .digest('hex')
      .slice(0, 16);
    expect(minimalCartFingerprint([line])).toBe(expected);
  });
});
