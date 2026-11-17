import type {
  CatalogItemResponse,
  StockStatus,
} from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  aggregateVariantStatus,
  deriveAvailability,
  isOutOfStock,
  preferInStock,
} from './minimal-catalog-availability';

type Stock = { status: StockStatus; quantity: number | null };
const out: Stock = { status: 'out_of_stock', quantity: 0 };
const inStock: Stock = { status: 'available', quantity: 5 };

const variant = (id: string, name: string, stock: Stock) => ({
  variantId: id,
  name,
  option: null,
  value: null,
  priceCents: 100,
  stock,
});
const item = (
  id: string,
  stock: Stock,
  variants: ReturnType<typeof variant>[] = [],
) =>
  ({
    productId: id,
    name: `Producto ${id}`,
    stock,
    variants,
  }) as unknown as CatalogItemResponse;

describe('deriveAvailability (S12: from the search payload)', () => {
  it('marks a simple product agotado from its own search status (prod case: lata with 0)', () => {
    expect(deriveAvailability(item('a', out))).toEqual({
      status: 'out_of_stock',
      variants: [],
      agotadoPresentations: [],
    });
  });

  it.each([
    ['available', { status: 'available', quantity: 3 }, 'available'],
    ['low_stock', { status: 'low_stock', quantity: 1 }, 'low_stock'],
    ['not_managed', { status: 'not_managed', quantity: null }, 'not_managed'],
  ] as const)('keeps %s for a simple product', (_n, stock, expected) => {
    expect(deriveAvailability(item('a', stock)).status).toBe(expected);
  });

  it.each([
    [
      'out_of_stock with a positive quantity',
      { status: 'out_of_stock', quantity: 3 },
    ],
    [
      'out_of_stock with unknown quantity',
      { status: 'out_of_stock', quantity: null },
    ],
    ['available with zero quantity', { status: 'available', quantity: 0 }],
    ['missing stock data', undefined],
    ['an unknown status', { status: 'bogus', quantity: 1 }],
  ] as const)('is unverified on %s', (_n, stock) => {
    expect(
      deriveAvailability(item('a', stock as unknown as Stock)).status,
    ).toBe('unverified');
  });

  it('reports each presentation from its own status and names the agotado ones', () => {
    const it1 = item('a', out, [
      variant('v1', 'Lata', out),
      variant('v2', 'Bolsa', inStock),
    ]);
    expect(deriveAvailability(it1)).toEqual({
      status: 'available',
      variants: [
        { variantId: 'v1', status: 'out_of_stock' },
        { variantId: 'v2', status: 'available' },
      ],
      agotadoPresentations: ['Lata'],
    });
  });

  it('never uses the product-level stock when there are presentations (product.quantity 0, one available variant)', () => {
    const it1 = item('a', { status: 'out_of_stock', quantity: 0 }, [
      variant('v1', 'Lata', inStock),
    ]);
    expect(deriveAvailability(it1).status).toBe('available');
    expect(deriveAvailability(it1).agotadoPresentations).toEqual([]);
  });

  it('is agotado when every presentation is agotado, whatever the product says', () => {
    const it1 = item('a', inStock, [
      variant('v1', 'Lata', out),
      variant('v2', 'Bolsa', out),
    ]);
    expect(deriveAvailability(it1)).toEqual({
      status: 'out_of_stock',
      variants: [
        { variantId: 'v1', status: 'out_of_stock' },
        { variantId: 'v2', status: 'out_of_stock' },
      ],
      agotadoPresentations: ['Lata', 'Bolsa'],
    });
  });

  it('marks a presentation without usable stock unverified and never agotado', () => {
    const it1 = item('a', inStock, [
      variant('v1', 'Lata', out),
      variant('v2', 'Bolsa', undefined as unknown as Stock),
    ]);
    const result = deriveAvailability(it1);
    expect(result.variants).toEqual([
      { variantId: 'v1', status: 'out_of_stock' },
      { variantId: 'v2', status: 'unverified' },
    ]);
    expect(result.status).toBe('unverified');
    expect(result.agotadoPresentations).toEqual(['Lata']);
  });
});

describe('aggregateVariantStatus', () => {
  it.each([
    [['out_of_stock', 'available'], 'available'],
    [['out_of_stock', 'low_stock'], 'low_stock'],
    [['out_of_stock', 'out_of_stock'], 'out_of_stock'],
    [['out_of_stock', 'unverified'], 'unverified'],
    [['not_managed', 'out_of_stock'], 'not_managed'],
  ] as const)('%j -> %s', (statuses, expected) => {
    expect(aggregateVariantStatus([...statuses])).toBe(expected);
  });
});

describe('isOutOfStock / preferInStock (agotado after the rest)', () => {
  it('is agotado for a simple out_of_stock product only', () => {
    expect(isOutOfStock(item('a', out))).toBe(true);
    expect(isOutOfStock(item('a', inStock))).toBe(false);
    expect(
      isOutOfStock(item('a', { status: 'not_managed', quantity: null })),
    ).toBe(false);
  });

  it('is agotado for a variant product only when every presentation is agotado', () => {
    expect(
      isOutOfStock(
        item('a', inStock, [variant('v1', 'A', out), variant('v2', 'B', out)]),
      ),
    ).toBe(true);
    expect(
      isOutOfStock(
        item('a', out, [variant('v1', 'A', out), variant('v2', 'B', inStock)]),
      ),
    ).toBe(false);
  });

  it('moves agotado products after available ones, stable, never dropping any', () => {
    const items = [
      item('o1', out),
      item('a1', inStock),
      item('o2', out),
      item('a2', inStock),
    ];
    expect(preferInStock(items).map((i) => i.productId)).toEqual([
      'a1',
      'a2',
      'o1',
      'o2',
    ]);
    expect(preferInStock([])).toEqual([]);
  });
});
