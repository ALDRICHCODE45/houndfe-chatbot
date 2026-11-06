import {
  CreateShippingQuoteInputSchema,
  CUSTOMER_PHONE_AMBIGUOUS,
  DUPLICATE_CART_LINE,
  INVALID_SHIPPING_DESTINATION,
  NO_SHIPPING_BOX_FITS,
  normalizeShippingQuoteResponse,
  PACKAGING_DATA_MISSING,
  PRICE_OUT_OF_DATE,
  PRODUCT_NOT_FOUND,
  SHIPPING_ADDRESS_INCOMPLETE,
  SHIPPING_ADDRESS_NOT_FOUND,
  SHIPPING_ORIGIN_NOT_CONFIGURED,
  SHIPPING_QUOTE_UNAVAILABLE,
  VARIANT_NOT_FOUND,
} from './shipping-quote.dto';

const id = '11111111-1111-4111-8111-111111111111';
const items = [{ productId: id, variantId: null, quantity: 2 }];
const identity = { phoneCountryCode: '52', phone: '5512345678' };
const raw = {
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: 'Cuauhtémoc',
  state: 'Ciudad de México',
};
export const quoteResponse = {
  quoteId: 'quote-1',
  expiresAt: '2026-11-05T12:00:00.000Z',
  zoneStatus: 'CARRIER_ONLY',
  option: { carrier: 'Envios Perros', service: 'Estándar', etaDays: 3 },
  costCents: 18000,
  creditCents: 12000,
  customerChargeCents: 6000,
  currency: 'MXN',
  eta: { days: 3, reason: null },
};
const undeliverable = {
  ...quoteResponse,
  quoteId: null,
  expiresAt: null,
  option: null,
  eta: { days: null, reason: null },
  costCents: 0,
  creditCents: 0,
  customerChargeCents: 0,
};

describe('shipping quote request DTO', () => {
  it('accepts a saved address destination', () => {
    expect(
      CreateShippingQuoteInputSchema.safeParse({
        items,
        ...identity,
        destination: { shippingAddressId: id },
      }).success,
    ).toBe(true);
  });

  it('accepts exactly the four loose destination fields', () => {
    expect(
      CreateShippingQuoteInputSchema.safeParse({
        items: [{ productId: id, quantity: 1 }],
        ...identity,
        destination: raw,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['both forms', { shippingAddressId: id, ...raw }],
    ['neither form', {}],
    ['raw address without zipCode', { ...raw, zipCode: undefined }],
    ['raw address without neighborhood', { ...raw, neighborhood: undefined }],
    ['raw address with street', { ...raw, street: 'Reforma' }],
    ['raw address with city', { ...raw, city: 'CDMX' }],
    ['raw address with exteriorNumber', { ...raw, exteriorNumber: '10' }],
    ['raw address with interiorNumber', { ...raw, interiorNumber: 'A' }],
    ['non-uuid saved address', { shippingAddressId: 'addr-1' }],
  ])('rejects %s', (_label, destination) => {
    expect(
      CreateShippingQuoteInputSchema.safeParse({
        items,
        ...identity,
        destination,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['empty items', { items: [] }],
    ['zero quantity', { items: [{ productId: id, quantity: 0 }] }],
    ['non-uuid product', { items: [{ productId: 'p', quantity: 1 }] }],
  ])('rejects %s', (_label, override) => {
    const base = { items, ...identity, destination: { shippingAddressId: id } };
    expect(
      CreateShippingQuoteInputSchema.safeParse({ ...base, ...override })
        .success,
    ).toBe(false);
  });
});

describe('shipping quote response DTO', () => {
  it('parses CARRIER_ONLY with a quoteId, expiresAt and option', () => {
    expect(normalizeShippingQuoteResponse(quoteResponse)).toEqual(
      quoteResponse,
    );
  });

  it.each(['FREE', 'SURCHARGE'])(
    'parses %s with a quoteId and a null option',
    (zoneStatus) => {
      const body = { ...quoteResponse, zoneStatus, option: null };
      expect(normalizeShippingQuoteResponse(body)).toEqual(body);
    },
  );

  it.each(['PENDING', 'DENIED'])(
    'parses %s with null quoteId and expiresAt and zero amounts',
    (zoneStatus) => {
      const body = { ...undeliverable, zoneStatus };
      expect(normalizeShippingQuoteResponse(body)).toEqual(body);
    },
  );

  it.each([
    ['a quoteId', { quoteId: 'quote-1' }],
    ['an expiresAt', { expiresAt: '2026-11-05T12:00:00.000Z' }],
    ['a cost', { costCents: 100 }],
    ['a credit', { creditCents: 100 }],
    ['a charge', { customerChargeCents: 100 }],
  ])('fails closed on PENDING/DENIED with %s', (_label, override) => {
    for (const zoneStatus of ['PENDING', 'DENIED'])
      expect(
        normalizeShippingQuoteResponse({
          ...undeliverable,
          zoneStatus,
          ...override,
        }),
      ).toBeNull();
  });

  it('parses a STOCK_PENDING eta', () => {
    const body = {
      ...quoteResponse,
      eta: { days: null, reason: 'STOCK_PENDING' },
    };
    expect(normalizeShippingQuoteResponse(body)).toEqual(body);
  });

  it.each(['FREE', 'SURCHARGE', 'CARRIER_ONLY'])(
    'fails closed on a deliverable %s without expiresAt',
    (zoneStatus) => {
      expect(
        normalizeShippingQuoteResponse({
          ...quoteResponse,
          zoneStatus,
          option: zoneStatus === 'CARRIER_ONLY' ? quoteResponse.option : null,
          expiresAt: null,
        }),
      ).toBeNull();
    },
  );

  it.each(['FREE', 'SURCHARGE'])(
    'fails closed on %s with an option',
    (zoneStatus) => {
      expect(
        normalizeShippingQuoteResponse({ ...quoteResponse, zoneStatus }),
      ).toBeNull();
    },
  );

  it('fails closed on CARRIER_ONLY without an option', () => {
    expect(
      normalizeShippingQuoteResponse({ ...quoteResponse, option: null }),
    ).toBeNull();
  });

  it('fails closed on a missing eta', () => {
    const body: Record<string, unknown> = { ...quoteResponse };
    delete body.eta;
    expect(normalizeShippingQuoteResponse(body)).toBeNull();
  });

  it('fails closed on an eta without reason', () => {
    expect(
      normalizeShippingQuoteResponse({ ...quoteResponse, eta: { days: 3 } }),
    ).toBeNull();
  });

  it.each([
    ['unknown zoneStatus', { zoneStatus: 'MAYBE' }],
    ['negative costCents', { costCents: -1 }],
    ['negative creditCents', { creditCents: -1 }],
    ['negative customerChargeCents', { customerChargeCents: -1 }],
    ['fractional cents', { costCents: 1.5 }],
    ['other currency', { currency: 'USD' }],
    ['null quoteId on a deliverable zone', { quoteId: null }],
    ['non-ISO expiresAt', { expiresAt: 'tomorrow' }],
    ['unknown eta reason', { eta: { days: null, reason: 'LATER' } }],
    ['negative eta days', { eta: { days: -1, reason: null } }],
    ['unknown key', { surprise: true }],
  ])('fails closed on %s', (_label, override) => {
    expect(
      normalizeShippingQuoteResponse({ ...quoteResponse, ...override }),
    ).toBeNull();
  });

  it('exports the backend quote error codes', () => {
    expect([
      INVALID_SHIPPING_DESTINATION,
      DUPLICATE_CART_LINE,
      PRODUCT_NOT_FOUND,
      VARIANT_NOT_FOUND,
      SHIPPING_ADDRESS_NOT_FOUND,
      CUSTOMER_PHONE_AMBIGUOUS,
      PRICE_OUT_OF_DATE,
      SHIPPING_ADDRESS_INCOMPLETE,
      PACKAGING_DATA_MISSING,
      NO_SHIPPING_BOX_FITS,
      SHIPPING_ORIGIN_NOT_CONFIGURED,
      SHIPPING_QUOTE_UNAVAILABLE,
    ]).toEqual([
      'INVALID_SHIPPING_DESTINATION',
      'DUPLICATE_CART_LINE',
      'PRODUCT_NOT_FOUND',
      'VARIANT_NOT_FOUND',
      'SHIPPING_ADDRESS_NOT_FOUND',
      'CUSTOMER_PHONE_AMBIGUOUS',
      'PRICE_OUT_OF_DATE',
      'SHIPPING_ADDRESS_INCOMPLETE',
      'PACKAGING_DATA_MISSING',
      'NO_SHIPPING_BOX_FITS',
      'SHIPPING_ORIGIN_NOT_CONFIGURED',
      'SHIPPING_QUOTE_UNAVAILABLE',
    ]);
  });
});
