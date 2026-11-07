import { parseOrderHistoryResponse } from './sales.dto';

/** Real `GET /chatbot-api/customers/by-phone/:phone/orders` entry (§4.4.9). */
const order = () => ({
  saleId: '5c1a0e4e-1b7b-4c55-9a3f-0f3a1c2b9d10',
  folio: 'B-0042',
  confirmedAt: '2026-10-20T18:00:00.000Z',
  channel: 'ONLINE',
  deliveryStatus: 'DELIVERED',
  paymentStatus: 'PAID',
  totalCents: 259700,
  paidCents: 259700,
  debtCents: 0,
  items: [
    {
      productId: '0b6f2c0e-6a8e-4f7e-9f3a-2d1f6b9c4e11',
      variantId: null,
      productName: 'Croquetas Adulto 18 kg',
      variantName: null,
      quantity: 1,
      unitPriceCents: 159900,
    },
    {
      productId: '1c7f3d1f-7b9f-4a8f-8a4b-3e2a7c0d5f22',
      variantId: '2d8a4e2a-8caa-4b9a-9b5c-4f3b8d1e6a33',
      productName: 'Croquetas Mini',
      variantName: '2 kg',
      quantity: 2,
      unitPriceCents: 49900,
    },
  ],
  payments: [{ method: 'TRANSFER', amountCents: 259700, reference: 'R-1' }],
  shippingAddress: { street: 'Av. Coyoacán', zipCode: '03100' },
});
type Order = ReturnType<typeof order>;
const withItem = (body: Order, patch: Record<string, unknown>) => ({
  ...body,
  items: [{ ...body.items[0], ...patch }],
});

describe('parseOrderHistoryResponse', () => {
  it('parses a real-shaped history', () => {
    expect(parseOrderHistoryResponse([order()])).toEqual({
      value: [order()],
      unknownKeys: [],
    });
  });

  it('parses the empty history of an unknown customer', () => {
    expect(parseOrderHistoryResponse([])).toEqual({
      value: [],
      unknownKeys: [],
    });
  });

  it('accepts nullable folio, confirmedAt, paymentStatus and shippingAddress', () => {
    const body = {
      ...order(),
      folio: null,
      confirmedAt: null,
      paymentStatus: null,
      shippingAddress: null,
    };
    expect(parseOrderHistoryResponse([body])?.value).toEqual([body]);
  });

  it('strips unknown keys and reports their paths', () => {
    const parsed = parseOrderHistoryResponse([
      { ...withItem(order(), { sku: 'X-1' }), branchId: 'b-1' },
    ]);
    expect(parsed?.value).toEqual([withItem(order(), {})]);
    expect(parsed?.unknownKeys.sort()).toEqual(
      ['[].branchId', '[].items[].sku'].sort(),
    );
  });

  it.each([
    ['not an array', { orders: [] }],
    ['missing items', [{ ...order(), items: undefined }]],
    ['zero quantity', [withItem(order(), { quantity: 0 })]],
    ['fractional quantity', [withItem(order(), { quantity: 1.5 })]],
    ['negative unit price', [withItem(order(), { unitPriceCents: -1 })]],
    ['empty productId', [withItem(order(), { productId: '' })]],
    ['numeric folio', [{ ...order(), folio: 42 }]],
    ['string total', [{ ...order(), totalCents: '2597.00' }]],
    ['missing payments', [{ ...order(), payments: undefined }]],
  ])('rejects %s', (_label, body) => {
    expect(parseOrderHistoryResponse(body)).toBeNull();
  });
});
