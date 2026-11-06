import {
  parseCatalogSearchResponse,
  parseStockCheckResponse,
} from './catalog.dto';

const omit = (body: object, key: string) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));

/** Real `GET /chatbot-api/catalog/search` item shape (contract-smoke keys). */
const catalogItem = () => ({
  productId: '0b6f2c0e-6a8e-4f7e-9f3a-2d1f6b9c4e11',
  name: 'Croquetas Adulto 20 kg',
  brand: 'Hound',
  imageUrl: 'https://cdn.example.com/p/croquetas.jpg',
  description: null,
  price: {
    priceCents: 89900,
    fromPriceCents: null,
    promoPriceCents: null,
    promotionEvaluationStatus: 'needs_human_review',
  },
  stock: { status: 'available', quantity: 12 },
  packageInfo: { weightGrams: null, dimensions: null },
  variants: [
    {
      variantId: '5d7a9e21-3c4b-4a1f-8e2d-7b6c5a4f3e22',
      name: 'Pollo',
      option: 'Sabor',
      value: 'Pollo',
      priceCents: 89900,
      stock: { status: 'low_stock', quantity: 2 },
    },
  ],
});

/** Real `GET /chatbot-api/catalog/:productId/stock` shape. */
const stockCheck = () => ({
  productId: '0b6f2c0e-6a8e-4f7e-9f3a-2d1f6b9c4e11',
  name: 'Croquetas Adulto 20 kg',
  stock: { status: 'not_managed', quantity: null },
  variants: [
    {
      variantId: '5d7a9e21-3c4b-4a1f-8e2d-7b6c5a4f3e22',
      name: 'Pollo',
      option: null,
      value: null,
      stock: { status: 'out_of_stock', quantity: 0 },
    },
  ],
});

describe('parseCatalogSearchResponse', () => {
  it('parses a real-shaped search body with no unknown keys', () => {
    expect(parseCatalogSearchResponse([catalogItem()])).toEqual({
      value: [catalogItem()],
      unknownKeys: [],
    });
    expect(parseCatalogSearchResponse([])).toEqual({
      value: [],
      unknownKeys: [],
    });
  });

  it('strips unknown keys and reports their paths once, never values', () => {
    const item = {
      ...catalogItem(),
      sku: 'SECRET-SKU',
      price: { ...catalogItem().price, listPriceCents: 1 },
      variants: [
        { ...catalogItem().variants[0], barcode: '750' },
        { ...catalogItem().variants[0], barcode: '751' },
      ],
    };
    const parsed = parseCatalogSearchResponse([item, item]);
    expect(parsed?.value[0]).not.toHaveProperty('sku');
    expect(parsed?.value[0].price).not.toHaveProperty('listPriceCents');
    expect(parsed?.value[0].variants[1]).not.toHaveProperty('barcode');
    expect(parsed?.unknownKeys.sort()).toEqual(
      ['[].sku', '[].price.listPriceCents', '[].variants[].barcode'].sort(),
    );
    expect(JSON.stringify(parsed?.unknownKeys)).not.toContain('SECRET');
  });

  it.each<[string, (item: ReturnType<typeof catalogItem>) => unknown]>([
    ['non-array body', (item) => item],
    ['missing productId', (item) => [omit(item, 'productId')]],
    ['numeric name', (item) => [{ ...item, name: 7 }]],
    ['brand undefined', (item) => [omit(item, 'brand')]],
    [
      'negative price',
      (item) => [{ ...item, price: { ...item.price, priceCents: -1 } }],
    ],
    [
      'fractional price',
      (item) => [{ ...item, price: { ...item.price, priceCents: 10.5 } }],
    ],
    [
      'string price',
      (item) => [{ ...item, price: { ...item.price, fromPriceCents: '1' } }],
    ],
    [
      'unknown promotion status',
      (item) => [
        {
          ...item,
          price: {
            ...item.price,
            promotionEvaluationStatus: 'fully_evaluated',
          },
        },
      ],
    ],
    [
      'unknown stock status',
      (item) => [{ ...item, stock: { status: 'in_stock', quantity: 1 } }],
    ],
    [
      'string stock quantity',
      (item) => [{ ...item, stock: { status: 'available', quantity: '1' } }],
    ],
    [
      'non-null package weight',
      (item) => [
        { ...item, packageInfo: { weightGrams: 500, dimensions: null } },
      ],
    ],
    ['variants not an array', (item) => [{ ...item, variants: {} }]],
    [
      'variant missing stock',
      (item) => [
        {
          ...item,
          variants: [{ ...item.variants[0], stock: undefined }],
        },
      ],
    ],
    [
      'variant negative price',
      (item) => [
        { ...item, variants: [{ ...item.variants[0], priceCents: -5 }] },
      ],
    ],
  ])('rejects %s', (_label, mutate) => {
    expect(parseCatalogSearchResponse(mutate(catalogItem()))).toBeNull();
  });
});

describe('parseStockCheckResponse', () => {
  it('parses a real-shaped stock body', () => {
    expect(parseStockCheckResponse(stockCheck())).toEqual({
      value: stockCheck(),
      unknownKeys: [],
    });
  });

  it('strips unknown keys and reports their paths', () => {
    const body = {
      ...stockCheck(),
      warehouse: 'A1',
      stock: { ...stockCheck().stock, reservedQuantity: 3 },
    };
    const parsed = parseStockCheckResponse(body);
    expect(parsed?.value).toEqual(stockCheck());
    expect(parsed?.unknownKeys.sort()).toEqual(
      ['stock.reservedQuantity', 'warehouse'].sort(),
    );
  });

  it.each<[string, (body: ReturnType<typeof stockCheck>) => unknown]>([
    ['null body', () => null],
    ['array body', (body) => [body]],
    ['missing name', (body) => omit(body, 'name')],
    ['empty productId', (body) => ({ ...body, productId: '' })],
    [
      'unknown stock status',
      (body) => ({ ...body, stock: { status: 'AVAILABLE', quantity: 1 } }),
    ],
    [
      'fractional quantity',
      (body) => ({ ...body, stock: { status: 'available', quantity: 1.5 } }),
    ],
    ['variants null', (body) => ({ ...body, variants: null })],
    [
      'variant numeric option',
      (body) => ({ ...body, variants: [{ ...body.variants[0], option: 1 }] }),
    ],
  ])('rejects %s', (_label, mutate) => {
    expect(parseStockCheckResponse(mutate(stockCheck()))).toBeNull();
  });
});
