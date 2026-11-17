import type {
  CatalogItemResponse,
  StockCheckResponse,
  StockStatus,
} from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  deriveAvailability,
  hintsOutOfStock,
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
const fresh = (
  id: string,
  stock: Stock,
  variants: Array<{ variantId: string; stock: Stock }> = [],
) =>
  ({
    productId: id,
    name: `Producto ${id}`,
    stock,
    variants: variants.map((v) => ({
      ...v,
      name: v.variantId,
      option: null,
      value: null,
    })),
  }) as unknown as StockCheckResponse;

describe('hintsOutOfStock / preferInStock (S11 ordering hint)', () => {
  it('hints agotado for a simple out_of_stock product only', () => {
    expect(hintsOutOfStock(item('a', out))).toBe(true);
    expect(hintsOutOfStock(item('a', inStock))).toBe(false);
    expect(
      hintsOutOfStock(item('a', { status: 'not_managed', quantity: null })),
    ).toBe(false);
  });

  it('hints agotado for a variant product only when every presentation is agotado', () => {
    expect(
      hintsOutOfStock(
        item('a', inStock, [variant('v1', 'A', out), variant('v2', 'B', out)]),
      ),
    ).toBe(true);
    expect(
      hintsOutOfStock(
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

describe('deriveAvailability (S11 fresh read)', () => {
  it('marks a simple product agotado from a consistent fresh read (prod case: lata with 0)', () => {
    expect(deriveAvailability(item('a', inStock), fresh('a', out))).toEqual({
      status: 'out_of_stock',
      variants: [],
      agotadoPresentations: [],
    });
  });

  it.each([
    ['available', { status: 'available', quantity: 3 }, 'available'],
    ['low_stock', { status: 'low_stock', quantity: 1 }, 'low_stock'],
    ['not_managed', { status: 'not_managed', quantity: null }, 'not_managed'],
  ] as const)('keeps %s', (_n, stock, expected) => {
    expect(deriveAvailability(item('a', out), fresh('a', stock)).status).toBe(
      expected,
    );
  });

  it.each([
    ['no fresh read', null],
    ['a mismatched product', fresh('zzz', out)],
    [
      'out_of_stock with a positive quantity',
      fresh('a', { status: 'out_of_stock', quantity: 3 }),
    ],
    [
      'out_of_stock with unknown quantity',
      fresh('a', { status: 'out_of_stock', quantity: null }),
    ],
    [
      'available with zero quantity',
      fresh('a', { status: 'available', quantity: 0 }),
    ],
  ] as const)('is unverified on %s', (_n, read) => {
    expect(deriveAvailability(item('a', out), read).status).toBe('unverified');
  });

  it('reports each presentation and names the agotado ones', () => {
    const it1 = item('a', inStock, [
      variant('v1', 'Lata', out),
      variant('v2', 'Bolsa', inStock),
    ]);
    const read = fresh('a', inStock, [
      { variantId: 'v1', stock: out },
      { variantId: 'v2', stock: inStock },
    ]);
    expect(deriveAvailability(it1, read)).toEqual({
      status: 'available',
      variants: [
        { variantId: 'v1', status: 'out_of_stock' },
        { variantId: 'v2', status: 'available' },
      ],
      agotadoPresentations: ['Lata'],
    });
  });

  it('is agotado when every presentation is agotado, whatever the parent says', () => {
    const it1 = item('a', inStock, [variant('v1', 'Lata', out)]);
    const read = fresh('a', inStock, [{ variantId: 'v1', stock: out }]);
    expect(deriveAvailability(it1, read).status).toBe('out_of_stock');
  });

  it('marks a presentation missing from the fresh read unverified and never agotado', () => {
    const it1 = item('a', inStock, [
      variant('v1', 'Lata', out),
      variant('v2', 'Bolsa', out),
    ]);
    const read = fresh('a', inStock, [{ variantId: 'v1', stock: out }]);
    const result = deriveAvailability(it1, read);
    expect(result.variants).toEqual([
      { variantId: 'v1', status: 'out_of_stock' },
      { variantId: 'v2', status: 'unverified' },
    ]);
    expect(result.status).toBe('unverified');
    expect(result.agotadoPresentations).toEqual(['Lata']);
  });
});
