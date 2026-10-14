import {
  CheckoutIdempotencyKeySchema,
  CreateCheckoutInputSchema,
  normalizeCheckoutResponse,
  normalizeCheckoutStatus,
} from './checkout.dto';

const id = '11111111-1111-4111-8111-111111111111';
export const checkoutInput = {
  phoneCountryCode: '52',
  phone: '5512345678',
  customer: { mode: 'createIfAbsent' as const, firstName: 'Ana' },
  deliveryAddress: { mode: 'newSaved' as const, address: { street: 'Centro' } },
  sale: {
    cashierUserId: id,
    items: [
      {
        productId: id,
        productName: 'Food',
        quantity: 1,
        unitPriceCents: 60000,
      },
    ],
    expectedTotalCents: 61000,
    shipping: {
      chargeCents: 1000,
      approvalId: 'approval-1',
      quoteId: 'quote-1',
    },
  },
};
export const checkoutResponse = {
  status: 'created',
  customer: {
    resolution: 'created',
    customerId: id,
    firstName: 'Ana',
    lastName: null,
  },
  address: { resolution: 'created', id, version: '2026-06-22T00:00:00.000Z' },
  sale: {
    saleId: id,
    folio: null,
    paymentStatus: 'CREDIT',
    channel: 'ONLINE',
    deliveryStatus: 'PENDING',
    totalCents: 61000,
    subtotalCents: 60000,
    shippingChargeCents: 1000,
    paidCents: 0,
    debtCents: 61000,
    confirmedAt: '2026-06-22T00:00:00.000Z',
  },
};

describe('atomic checkout DTO', () => {
  it('S1 trims header and shipping identifiers', () => {
    expect(CheckoutIdempotencyKeySchema.parse(' key ')).toBe('key');
    const parsed = CreateCheckoutInputSchema.parse({
      ...checkoutInput,
      sale: {
        ...checkoutInput.sale,
        shipping: {
          chargeCents: 1,
          approvalId: ' approval ',
          quoteId: ' quote ',
        },
      },
    });
    expect(parsed.sale.shipping).toEqual({
      chargeCents: 1,
      approvalId: 'approval',
      quoteId: 'quote',
    });
  });
  it.each([0, -1, 1.5, 2147483648])(
    'S1 rejects shipping charge %s',
    (chargeCents) => {
      expect(
        CreateCheckoutInputSchema.safeParse({
          ...checkoutInput,
          sale: {
            ...checkoutInput.sale,
            shipping: { chargeCents, approvalId: 'a' },
          },
        }).success,
      ).toBe(false);
    },
  );
  it.each([undefined, -1, 1.5, 2147483648])(
    'S1 rejects total %s',
    (expectedTotalCents) => {
      expect(
        CreateCheckoutInputSchema.safeParse({
          ...checkoutInput,
          sale: { ...checkoutInput.sale, expectedTotalCents },
        }).success,
      ).toBe(false);
    },
  );
  it.each(['approvalId', 'quoteId'])(
    'S1 caps and rejects blank %s',
    (field) => {
      for (const value of [' ', 'x'.repeat(201), null]) {
        expect(
          CreateCheckoutInputSchema.safeParse({
            ...checkoutInput,
            sale: {
              ...checkoutInput.sale,
              shipping: { ...checkoutInput.sale.shipping, [field]: value },
            },
          }).success,
        ).toBe(false);
      }
    },
  );
  it('S1 restricts both resolution vocabularies', () => {
    expect(
      normalizeCheckoutResponse({
        ...checkoutResponse,
        customer: { ...checkoutResponse.customer, resolution: 'unknown' },
      }),
    ).toBeNull();
    expect(
      normalizeCheckoutResponse({
        ...checkoutResponse,
        address: { ...checkoutResponse.address, resolution: 'unknown' },
      }),
    ).toBeNull();
  });
  it('accepts both strict modes and zero total without shipping', () => {
    expect(CreateCheckoutInputSchema.parse(checkoutInput)).toEqual(
      checkoutInput,
    );
    expect(
      CreateCheckoutInputSchema.safeParse({
        ...checkoutInput,
        customer: { mode: 'existing', customerId: id },
        deliveryAddress: {
          mode: 'existing',
          addressId: id,
          expectedVersion: checkoutResponse.address.version,
        },
        sale: {
          ...checkoutInput.sale,
          shipping: undefined,
          expectedTotalCents: 0,
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    { ...checkoutInput, extra: true },
    {
      ...checkoutInput,
      customer: { ...checkoutInput.customer, customerId: id },
    },
    {
      ...checkoutInput,
      deliveryAddress: { ...checkoutInput.deliveryAddress, addressId: id },
    },
    {
      ...checkoutInput,
      sale: { ...checkoutInput.sale, expectedTotalCents: 0 },
    },
    {
      ...checkoutInput,
      sale: {
        ...checkoutInput.sale,
        shipping: { ...checkoutInput.sale.shipping, extra: true },
      },
    },
    { ...checkoutInput, phone: '+52' },
    {
      ...checkoutInput,
      deliveryAddress: {
        mode: 'newSaved',
        address: { street: 'Centro', extra: true },
      },
    },
  ])('rejects invalid or mixed fields %#', (input) => {
    expect(CreateCheckoutInputSchema.safeParse(input).success).toBe(false);
  });
  it('normalizes the receipt without inventing optional freight fields', () => {
    expect(
      normalizeCheckoutResponse(checkoutResponse)?.sale.discountCents,
    ).toBe(0);
    const sale = { ...checkoutResponse.sale };
    Reflect.deleteProperty(sale, 'subtotalCents');
    Reflect.deleteProperty(sale, 'shippingChargeCents');
    expect(
      normalizeCheckoutResponse({ ...checkoutResponse, sale })?.sale,
    ).not.toHaveProperty('subtotalCents');
  });
  it.each([
    null,
    {},
    { ...checkoutResponse, status: 'succeeded' },
    {
      ...checkoutResponse,
      sale: { ...checkoutResponse.sale, totalCents: '61000' },
    },
    {
      ...checkoutResponse,
      address: { ...checkoutResponse.address, version: 'bad' },
    },
  ])('fails closed on malformed receipt %#', (body) => {
    expect(normalizeCheckoutResponse(body)).toBeNull();
  });
  it('requires status and checkout to agree', () => {
    expect(
      normalizeCheckoutStatus({
        status: 'succeeded',
        checkout: checkoutResponse,
      })?.status,
    ).toBe('succeeded');
    expect(
      normalizeCheckoutStatus({ status: 'not_observed', checkout: null }),
    ).toEqual({ status: 'not_observed', checkout: null });
    expect(
      normalizeCheckoutStatus({ status: 'succeeded', checkout: null }),
    ).toBeNull();
    expect(
      normalizeCheckoutStatus({
        status: 'not_observed',
        checkout: checkoutResponse,
      }),
    ).toBeNull();
  });
});
