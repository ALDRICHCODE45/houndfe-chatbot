import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  MinimalCartService,
  minimalCartAdjustmentInput,
  minimalCartFingerprint,
  minimalCartInput,
  minimalCartReply,
  parseMinimalCart,
} from './minimal-cart.service';
import {
  BO_CROQUETAS,
  BO_PRODUCT,
  BO_SENDER,
  reservedBackorder,
} from './minimal-backorder-checkout.fixtures';

/**
 * Multi-pet T5a (S9, S16, S17): a cart line may be for one backend pet. The
 * pet is stored on the line (`pet {id, name}`) and the cart remembers the
 * pet the customer chose (`currentPet`); the same product for two pets, or
 * a pet and no pet, is one line without pet; a pet-less cart is unchanged.
 */
const SENDER = BO_SENDER;
const MAX = { id: 'a0000000-0000-4000-8000-000000000050', name: 'Max' };
const BRUNO = { id: '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11', name: 'Bruno' };
const CATALOG: Record<string, { name: string; price: number }> = {
  [BO_PRODUCT]: { name: 'Ibuprofeno', price: 1500 },
  [BO_CROQUETAS]: { name: 'Croquetas Adulto 18 kg', price: 120000 },
};

function setup(options: { promoPercent?: number } = {}) {
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
    getStock: jest.fn((productId: string) =>
      Promise.resolve({
        productId,
        name: CATALOG[productId].name,
        stock: { status: 'available', quantity: 50 },
        variants: [],
      }),
    ),
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
  const client = api as unknown as ChatbotApiClient;
  const cart = new MinimalCartService(client, store);
  const seed = (items: object[], extra: object = {}) =>
    store.commitMinimalCart(
      SENDER,
      undefined,
      { items, idempotencyKey: '', ...extra },
      '2026-10-10T00:00:00.000Z',
    );
  const raw = async () => (await store.get(SENDER))?.data.minimalCart;
  const items = async () =>
    ((await raw()) as { items: Array<Record<string, unknown>> }).items;
  const allowed = new Set([BO_PRODUCT, BO_CROQUETAS]);
  return {
    store,
    api,
    cart,
    seed,
    raw,
    items,
    allowed,
    restart: () => new MinimalCartService(client, store),
  };
}

const line = (productId: string, quantity: number, extra: object = {}) => ({
  productId,
  quantity,
  unitPriceCents: CATALOG[productId].price,
  ...extra,
});

describe('T5a R1: pet on a cart line (S16, item 1/3)', () => {
  it('a tagged write stores the pet on the line and the cart reply shows «(para Max)»', async () => {
    const h = setup();
    const result = await h.cart.setItem(
      SENDER,
      { productId: BO_PRODUCT, quantity: 2 },
      h.allowed,
      undefined,
      MAX,
    );
    expect(result).toMatchObject({ ok: true, totalCents: 3000 });
    expect(JSON.stringify(await h.raw())).toBe(
      `{"items":[{"productId":"${BO_PRODUCT}","quantity":2,"unitPriceCents":1500,"pet":{"id":"${MAX.id}","name":"Max"}}],"idempotencyKey":"","expectedTotalCents":3000}`,
    );
    expect(minimalCartReply(result)).toBe(
      '*Su carrito*\n• Ibuprofeno (para Max)\n   2 × $15.00 = *$30.00*\n\n*Total de productos: $30.00*\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
    );
  });

  it('«(para Max)» stays on the name line; the promotion is its italic detail line (message formatting F3a)', async () => {
    const h = setup({ promoPercent: 10 });
    const result = await h.cart.setItem(
      SENDER,
      { productId: BO_PRODUCT, quantity: 2 },
      h.allowed,
      undefined,
      MAX,
    );
    expect(minimalCartReply(result)).toContain(
      '• Ibuprofeno (para Max)\n   2 × $15.00 = *$27.00*\n   _Promo orden: ahorra $3.00_',
    );
  });

  it('a pet-less write keeps the stored bytes, the reply and the fingerprint of today', async () => {
    const h = setup();
    const result = await h.cart.setItem(
      SENDER,
      { productId: BO_PRODUCT, quantity: 2 },
      h.allowed,
    );
    expect(JSON.stringify(await h.raw())).toBe(
      `{"items":[{"productId":"${BO_PRODUCT}","quantity":2,"unitPriceCents":1500}],"idempotencyKey":"","expectedTotalCents":3000}`,
    );
    expect(minimalCartReply(result)).toBe(
      '*Su carrito*\n• Ibuprofeno\n   2 × $15.00 = *$30.00*\n\n*Total de productos: $30.00*\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
    );
    expect(await h.cart.fingerprint(SENDER)).toBe('9dfafc7fb792dced');
  });

  it('a stored cart without pet fields still loads, unchanged', async () => {
    const h = setup();
    await h.seed([line(BO_PRODUCT, 2)], { expectedTotalCents: 3000 });
    const before = structuredClone(await h.raw());
    const view = await h.cart.view(SENDER);
    expect(view).toMatchObject({ ok: true, totalCents: 3000 });
    if (!view.ok) throw new Error('unreachable');
    expect(view.items[0]).not.toHaveProperty('pet');
    expect(await h.cart.currentPet(SENDER)).toBeNull();
    expect(await h.raw()).toEqual(before);
  });

  it('the stored cart schema stays strict for the pet and the current pet', () => {
    const cart = (items: object[], extra: object = {}) => ({
      items,
      idempotencyKey: '',
      ...extra,
    });
    expect(
      parseMinimalCart(
        cart([line(BO_PRODUCT, 1, { pet: MAX })], { currentPet: BRUNO }),
      ),
    ).not.toBeNull();
    for (const bad of [
      cart([line(BO_PRODUCT, 1, { pet: { ...MAX, species: 'DOG' } })]),
      cart([line(BO_PRODUCT, 1, { pet: { id: 'local:1', name: 'Max' } })]),
      cart([line(BO_PRODUCT, 1, { pet: { id: MAX.id, name: '' } })]),
      cart([line(BO_PRODUCT, 1, { pet: { id: MAX.id } })]),
      cart([line(BO_PRODUCT, 1)], { currentPet: { ...MAX, extra: true } }),
      cart([line(BO_PRODUCT, 1)], { currentPet: { id: 'nope', name: 'Max' } }),
    ])
      expect(parseMinimalCart(bad)).toBeNull();
  });

  it('the model never supplies a pet: the cart tool inputs refuse it', () => {
    expect(
      minimalCartInput.safeParse({
        productId: BO_PRODUCT,
        quantity: 1,
        pet: MAX,
      }).success,
    ).toBe(false);
    expect(
      minimalCartAdjustmentInput.safeParse({
        productId: BO_PRODUCT,
        delta: 1,
        pet: MAX,
      }).success,
    ).toBe(false);
  });

  it('an invalid pet (not a backend id, blank or too long a name) is ignored: the line has no pet', async () => {
    const h = setup();
    for (const pet of [
      { id: 'local:abc', name: 'Max' },
      { id: MAX.id, name: '   ' },
      { id: MAX.id, name: 'M'.repeat(61) },
    ]) {
      await h.cart.setItem(
        SENDER,
        { productId: BO_PRODUCT, quantity: 1 },
        h.allowed,
        undefined,
        pet,
      );
      expect((await h.items())[0]).not.toHaveProperty('pet');
      expect(parseMinimalCart(await h.raw())).not.toBeNull();
    }
  });

  it('the cart fingerprint changes with the pet and stays the same without one', () => {
    const plain = { productId: BO_PRODUCT, quantity: 2 };
    expect(minimalCartFingerprint([plain])).toBe('9dfafc7fb792dced');
    expect(minimalCartFingerprint([{ ...plain, pet: MAX }])).not.toBe(
      minimalCartFingerprint([plain]),
    );
    expect(minimalCartFingerprint([{ ...plain, pet: MAX }])).not.toBe(
      minimalCartFingerprint([{ ...plain, pet: BRUNO }]),
    );
  });

  it('keepOnly and refreshPrices keep the pets and the current pet', async () => {
    const h = setup();
    await h.seed(
      [line(BO_PRODUCT, 2, { pet: MAX }), line(BO_CROQUETAS, 1)],
      // A stale total: the refresh rewrites the lines.
      { currentPet: MAX, expectedTotalCents: 1 },
    );
    expect(await h.cart.refreshPrices(SENDER)).toMatchObject({
      repriced: true,
    });
    expect(await h.items()).toEqual([
      line(BO_PRODUCT, 2, { pet: MAX }),
      line(BO_CROQUETAS, 1),
    ]);
    expect(
      await h.cart.keepOnly(SENDER, [{ productId: BO_PRODUCT }]),
    ).toMatchObject({ ok: true });
    expect(await h.raw()).toEqual({
      items: [line(BO_PRODUCT, 2, { pet: MAX })],
      idempotencyKey: '',
      expectedTotalCents: 3000,
      currentPet: MAX,
    });
  });
});

describe('T5a R3: one line per product (S9)', () => {
  it('the same product for two different pets is one line without pet', async () => {
    const h = setup();
    await h.cart.setItem(
      SENDER,
      { productId: BO_PRODUCT, quantity: 1 },
      h.allowed,
      undefined,
      MAX,
    );
    const result = await h.cart.adjustItem(
      SENDER,
      { productId: BO_PRODUCT, delta: 1 },
      h.allowed,
      undefined,
      BRUNO,
    );
    expect(await h.items()).toEqual([line(BO_PRODUCT, 2)]);
    expect(minimalCartReply(result)).not.toContain('(para');
  });

  it('a pet and no pet on the same product is one line without pet (both ways)', async () => {
    const h = setup();
    await h.seed([line(BO_PRODUCT, 1, { pet: MAX })]);
    await h.cart.adjustItem(
      SENDER,
      { productId: BO_PRODUCT, delta: 1 },
      h.allowed,
    );
    expect(await h.items()).toEqual([line(BO_PRODUCT, 2)]);

    const g = setup();
    await g.seed([line(BO_PRODUCT, 1)]);
    await g.cart.adjustItem(
      SENDER,
      { productId: BO_PRODUCT, delta: 1 },
      g.allowed,
      undefined,
      MAX,
    );
    expect(await g.items()).toEqual([line(BO_PRODUCT, 2)]);
  });

  it('a quantity change keeps the pet (fewer units never add another pet; more for the same pet)', async () => {
    const h = setup();
    await h.seed([line(BO_PRODUCT, 3, { pet: MAX })]);
    await h.cart.setItem(
      SENDER,
      { productId: BO_PRODUCT, quantity: 2 },
      h.allowed,
      undefined,
      BRUNO,
    );
    expect(await h.items()).toEqual([line(BO_PRODUCT, 2, { pet: MAX })]);
    await h.cart.adjustItem(
      SENDER,
      { productId: BO_PRODUCT, delta: -1 },
      h.allowed,
    );
    expect(await h.items()).toEqual([line(BO_PRODUCT, 1, { pet: MAX })]);
    await h.cart.adjustItem(
      SENDER,
      { productId: BO_PRODUCT, delta: 2 },
      h.allowed,
      undefined,
      MAX,
    );
    expect(await h.items()).toEqual([line(BO_PRODUCT, 3, { pet: MAX })]);
  });

  it('addItems (reorder) tags new lines and merges an existing one by the same rule', async () => {
    const h = setup();
    await h.seed([line(BO_PRODUCT, 1, { pet: MAX })]);
    await h.cart.addItems(
      SENDER,
      [
        { productId: BO_PRODUCT, quantity: 1 },
        { productId: BO_CROQUETAS, quantity: 1 },
      ],
      BRUNO,
    );
    expect(await h.items()).toEqual([
      line(BO_PRODUCT, 2),
      line(BO_CROQUETAS, 1, { pet: BRUNO }),
    ]);
  });

  it('addItems without a pet keeps today’s lines (existing behaviour)', async () => {
    const h = setup();
    await h.seed([line(BO_PRODUCT, 1)]);
    await h.cart.addItems(SENDER, [
      { productId: BO_PRODUCT, quantity: 1 },
      { productId: BO_CROQUETAS, quantity: 1 },
    ]);
    expect(await h.items()).toEqual([
      line(BO_PRODUCT, 2),
      line(BO_CROQUETAS, 1),
    ]);
  });

  it('a backorder line is exempt: never tagged, never merged with the tagged ordinary line', async () => {
    const h = setup();
    await h.cart.setItem(
      SENDER,
      { productId: BO_CROQUETAS, quantity: 1 },
      h.allowed,
      undefined,
      MAX,
    );
    const added = await h.cart.addBackorderLine(SENDER, reservedBackorder());
    expect(added).toMatchObject({ ok: true });
    await h.cart.adjustItem(
      SENDER,
      { productId: BO_CROQUETAS, delta: 1 },
      h.allowed,
      undefined,
      MAX,
    );
    const items = await h.items();
    expect(items).toHaveLength(2);
    const backorder = items.find((item) => item.backorder !== undefined)!;
    const ordinary = items.find((item) => item.backorder === undefined)!;
    expect(backorder).not.toHaveProperty('pet');
    expect(ordinary).toEqual(line(BO_CROQUETAS, 2, { pet: MAX }));
    const view = await h.cart.view(SENDER);
    expect(minimalCartReply(view)).toContain('(pedido apartado BO-000012)');
    expect(minimalCartReply(view)).toContain(
      '• Croquetas Adulto 18 kg (para Max)\n   2 × $1,200.00 = *$2,400.00*',
    );
  });
});

describe('T5a R2: the current pet of the cart (S17)', () => {
  it('is stored on the cart, survives a restart, is replaced and cleared, and kept by cart writes', async () => {
    const h = setup();
    expect(await h.cart.currentPet(SENDER)).toBeNull();
    expect(await h.cart.setCurrentPet(SENDER, MAX)).toBe(true);
    expect(await h.raw()).toEqual({
      items: [],
      idempotencyKey: '',
      currentPet: MAX,
    });
    expect(await h.restart().currentPet(SENDER)).toEqual(MAX);
    await h.cart.setItem(
      SENDER,
      { productId: BO_PRODUCT, quantity: 1 },
      h.allowed,
      undefined,
      MAX,
    );
    expect(await h.cart.currentPet(SENDER)).toEqual(MAX);
    expect(await h.cart.setCurrentPet(SENDER, BRUNO)).toBe(true);
    expect(await h.cart.currentPet(SENDER)).toEqual(BRUNO);
    expect(await h.cart.setCurrentPet(SENDER, null)).toBe(true);
    expect(await h.cart.currentPet(SENDER)).toBeNull();
    expect(await h.raw()).toEqual({
      items: [line(BO_PRODUCT, 1, { pet: MAX })],
      idempotencyKey: '',
      expectedTotalCents: 1500,
    });
  });

  it('refuses an invalid pet and a cart with an order in flight', async () => {
    const h = setup();
    expect(
      await h.cart.setCurrentPet(SENDER, { id: 'local:1', name: 'Max' }),
    ).toBe(false);
    expect(await h.raw()).toBeUndefined();
    await h.seed([line(BO_PRODUCT, 1)], {
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    });
    const before = structuredClone(await h.raw());
    expect(await h.cart.setCurrentPet(SENDER, MAX)).toBe(false);
    expect(await h.raw()).toEqual(before);
  });
});
