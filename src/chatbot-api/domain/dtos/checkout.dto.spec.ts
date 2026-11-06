import {
  checkoutErrorMismatches,
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
    shipping: { quoteId: 'quote-1' },
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
    discountCents: 0,
    subtotalCents: 60000,
    shippingChargeCents: 1000,
    fulfillmentMode: 'DELIVERY',
    paidCents: 0,
    debtCents: 61000,
    confirmedAt: '2026-06-22T00:00:00.000Z',
  },
};

describe('atomic checkout DTO', () => {
  it('accepts existingUpdated with exact version and the updated receipt', () => {
    const deliveryAddress = {
      mode: 'existingUpdated',
      addressId: id,
      expectedVersion: checkoutResponse.address.version,
      address: { street: 'Centro', zipCode: '55635' },
    };
    expect(
      CreateCheckoutInputSchema.safeParse({ ...checkoutInput, deliveryAddress })
        .success,
    ).toBe(true);
    const response = {
      ...checkoutResponse,
      address: { ...checkoutResponse.address, resolution: 'updated' },
    };
    expect(normalizeCheckoutResponse(response)?.address?.resolution).toBe(
      'updated',
    );
    expect(
      normalizeCheckoutStatus({ status: 'succeeded', checkout: response })
        ?.status,
    ).toBe('succeeded');
    for (const patch of [
      { expectedVersion: 'bad' },
      { addressId: 'bad' },
      { address: { zipCode: '55635' } },
      { address: { street: 'Centro', latitude: 19 } },
    ]) {
      expect(
        CreateCheckoutInputSchema.safeParse({
          ...checkoutInput,
          deliveryAddress: { ...deliveryAddress, ...patch },
        }).success,
      ).toBe(false);
    }
  });
  it('S1 trims header and shipping identifiers', () => {
    expect(CheckoutIdempotencyKeySchema.parse(' key ')).toBe('key');
    const parsed = CreateCheckoutInputSchema.parse({
      ...checkoutInput,
      sale: {
        ...checkoutInput.sale,
        shipping: { quoteId: ' quote ' },
      },
    });
    expect(parsed.sale.shipping).toEqual({ quoteId: 'quote' });
  });
  it.each([
    { quoteId: 'q', chargeCents: 1000 },
    { quoteId: 'q', approvalId: 'a' },
    { chargeCents: 1000, approvalId: 'a' },
    { mode: 'pickup', quoteId: 'q' },
    { mode: 'delivery' },
    {},
  ])('S2 rejects shipping %j', (shipping) => {
    expect(
      CreateCheckoutInputSchema.safeParse({
        ...checkoutInput,
        sale: { ...checkoutInput.sale, shipping },
      }).success,
    ).toBe(false);
  });
  it('S4 accepts store pickup', () => {
    const { deliveryAddress, ...rest } = checkoutInput;
    const pickup = {
      ...rest,
      sale: { ...checkoutInput.sale, shipping: { mode: 'pickup' } },
    };
    expect(CreateCheckoutInputSchema.parse(pickup)).toEqual(pickup);
    // Pickup with an address is a mixed shape (400 INVALID_CHECKOUT_REQUEST).
    expect(
      CreateCheckoutInputSchema.safeParse({ ...pickup, deliveryAddress })
        .success,
    ).toBe(false);
  });
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
  it('S1 caps and rejects blank quoteId', () => {
    for (const quoteId of [' ', 'x'.repeat(201), null]) {
      expect(
        CreateCheckoutInputSchema.safeParse({
          ...checkoutInput,
          sale: { ...checkoutInput.sale, shipping: { quoteId } },
        }).success,
      ).toBe(false);
    }
  });
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
  it('requires the delivery freight and discount fields', () => {
    for (const key of ['discountCents', 'shippingChargeCents']) {
      const sale = { ...checkoutResponse.sale };
      Reflect.deleteProperty(sale, key);
      expect(
        normalizeCheckoutResponse({ ...checkoutResponse, sale }),
      ).toBeNull();
    }
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

/** docs/contracts/checkout-shipping.md examples; "…" ids replaced by UUIDs. */
export const contractDelivery201 = {
  status: 'created',
  customer: {
    resolution: 'existing',
    customerId: 'c0a1c0a1-0000-4000-8000-000000000001',
    firstName: 'Ana',
    lastName: null,
  },
  address: {
    resolution: 'created',
    id: 'd4e5d4e5-0000-4000-8000-000000000002',
    version: '2026-11-06T18:01:02.345Z',
  },
  sale: {
    saleId: '1e061e06-0000-4000-8000-000000000003',
    folio: 'A-202611-000001',
    paymentStatus: 'CREDIT',
    channel: 'ONLINE',
    deliveryStatus: 'PENDING',
    totalCents: 78000,
    discountCents: 0,
    subtotalCents: 60000,
    shippingChargeCents: 18000,
    fulfillmentMode: 'DELIVERY',
    paidCents: 0,
    debtCents: 78000,
    confirmedAt: '2026-11-06T18:01:02.400Z',
  },
};
export const contractPickup201 = {
  status: 'created',
  customer: {
    resolution: 'created',
    customerId: '77b077b0-0000-4000-8000-000000000004',
    firstName: 'Luis',
    lastName: null,
  },
  address: null,
  sale: {
    saleId: '9c219c21-0000-4000-8000-000000000005',
    folio: 'A-202611-000002',
    paymentStatus: 'CREDIT',
    channel: 'ONLINE',
    deliveryStatus: 'PENDING',
    totalCents: 60000,
    discountCents: 0,
    fulfillmentMode: 'PICKUP',
    paidCents: 0,
    debtCents: 60000,
    confirmedAt: '2026-11-06T18:05:00.000Z',
  },
  pickupLocation: {
    name: 'Sucursal Centro',
    address: {
      addressLine1: 'Av. Juárez 123',
      addressLine2: null,
      neighborhood: 'Centro',
      municipality: 'Cuauhtémoc',
      state: 'Ciudad de México',
      postalCode: '06000',
      formatted:
        'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
    },
    hours: {
      timeZone: 'America/Mexico_City',
      days: [
        ['MONDAY', 'Lunes'],
        ['TUESDAY', 'Martes'],
        ['WEDNESDAY', 'Miércoles'],
        ['THURSDAY', 'Jueves'],
        ['FRIDAY', 'Viernes'],
        ['SATURDAY', 'Sábado'],
      ]
        .map(([day, label]) => ({
          day,
          label,
          closed: false,
          ranges: [{ open: '09:00', close: '18:00' }],
        }))
        .concat([
          { day: 'SUNDAY', label: 'Domingo', closed: true, ranges: [] },
        ]),
      summary: 'Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
    },
  },
};

describe('checkout shipping contract (C1)', () => {
  it('parses the delivery 201 exactly', () => {
    expect(normalizeCheckoutResponse(contractDelivery201)).toEqual(
      contractDelivery201,
    );
  });
  it('parses the pickup 201 exactly, also through /checkouts/status', () => {
    expect(normalizeCheckoutResponse(contractPickup201)).toEqual(
      contractPickup201,
    );
    expect(
      normalizeCheckoutStatus({
        status: 'succeeded',
        checkout: contractPickup201,
      }),
    ).toEqual({ status: 'succeeded', checkout: contractPickup201 });
  });
  it('accepts a formatted-only pickup address and null address/hours', () => {
    const formattedOnly = {
      ...contractPickup201,
      pickupLocation: {
        name: 'Sucursal Centro',
        address: {
          addressLine1: null,
          addressLine2: null,
          neighborhood: null,
          municipality: null,
          state: null,
          postalCode: null,
          formatted: 'Av. Juárez 123, Centro',
        },
        hours: null,
      },
    };
    expect(normalizeCheckoutResponse(formattedOnly)).toEqual(formattedOnly);
    const bare = {
      ...contractPickup201,
      pickupLocation: { name: 'Sucursal Centro', address: null, hours: null },
    };
    expect(normalizeCheckoutResponse(bare)).toEqual(bare);
  });
  it('pickup request: existing and new customer without deliveryAddress', () => {
    const items = [
      {
        productId: id,
        productName: 'Croquetas',
        quantity: 1,
        unitPriceCents: 60000,
      },
    ];
    const sale = {
      cashierUserId: id,
      items,
      expectedTotalCents: 60000,
      shipping: { mode: 'pickup' },
    };
    const created = {
      phoneCountryCode: '52',
      phone: '5511112222',
      customer: { mode: 'createIfAbsent', firstName: 'Luis' },
      sale,
    };
    expect(CreateCheckoutInputSchema.parse(created)).toEqual(created);
    const existing = {
      ...created,
      customer: { mode: 'existing', customerId: id },
    };
    expect(CreateCheckoutInputSchema.parse(existing)).toEqual(existing);
    // Delivery still needs an address.
    expect(
      CreateCheckoutInputSchema.safeParse({
        ...created,
        sale: { ...sale, shipping: { quoteId: 'q' } },
      }).success,
    ).toBe(false);
  });
  it.each([
    [
      'delivery without subtotal',
      {
        ...contractDelivery201,
        sale: { ...contractDelivery201.sale, subtotalCents: undefined },
      },
    ],
    [
      'delivery with pickup mode',
      {
        ...contractDelivery201,
        sale: { ...contractDelivery201.sale, fulfillmentMode: 'PICKUP' },
      },
    ],
    [
      'delivery with pickupLocation',
      {
        ...contractDelivery201,
        pickupLocation: contractPickup201.pickupLocation,
      },
    ],
    ['delivery without address', { ...contractDelivery201, address: null }],
    [
      'pickup with shipping charge',
      {
        ...contractPickup201,
        sale: { ...contractPickup201.sale, shippingChargeCents: 0 },
      },
    ],
    [
      'pickup with an address',
      { ...contractPickup201, address: contractDelivery201.address },
    ],
    [
      'pickup sale extra key',
      { ...contractPickup201, sale: { ...contractPickup201.sale, extra: 1 } },
    ],
    [
      'pickupLocation extra key',
      {
        ...contractPickup201,
        pickupLocation: { ...contractPickup201.pickupLocation, phone: 'x' },
      },
    ],
    [
      'no fulfillmentMode',
      {
        ...contractDelivery201,
        sale: { ...contractDelivery201.sale, fulfillmentMode: undefined },
      },
    ],
  ])('fails closed: %s', (_name, body) => {
    expect(
      normalizeCheckoutResponse(JSON.parse(JSON.stringify(body))),
    ).toBeNull();
  });
  it('reads mismatches from an error body', () => {
    expect(
      checkoutErrorMismatches({
        statusCode: 409,
        error: 'SHIPPING_QUOTE_MISMATCH',
        message: 'SHIPPING_QUOTE_MISMATCH',
        mismatches: ['LINES', 'DESTINATION'],
      }),
    ).toEqual(['LINES', 'DESTINATION']);
    expect(checkoutErrorMismatches({ statusCode: 409 })).toEqual([]);
    expect(checkoutErrorMismatches(null)).toEqual([]);
  });
});
