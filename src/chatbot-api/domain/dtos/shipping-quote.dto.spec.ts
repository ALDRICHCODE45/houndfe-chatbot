import {
  CreateShippingQuoteInputSchema,
  normalizeShippingQuoteResponse,
  PACKAGING_DATA_MISSING,
  SHIPPING_QUOTE_UNAVAILABLE,
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

  it('accepts a raw address destination with optional street and city', () => {
    expect(
      CreateShippingQuoteInputSchema.safeParse({
        items: [{ productId: id, quantity: 1 }],
        ...identity,
        destination: { ...raw, street: 'Reforma', city: 'CDMX' },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['both forms', { shippingAddressId: id, ...raw }],
    ['neither form', {}],
    ['raw address without zipCode', { ...raw, zipCode: undefined }],
    ['raw address without neighborhood', { ...raw, neighborhood: undefined }],
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
  it.each(['FREE', 'SURCHARGE', 'CARRIER_ONLY'])(
    'parses %s with a quoteId',
    (zoneStatus) => {
      const body = { ...quoteResponse, zoneStatus };
      expect(normalizeShippingQuoteResponse(body)).toEqual(body);
    },
  );

  it.each(['PENDING', 'DENIED'])(
    'parses %s with a null quoteId and option',
    (zoneStatus) => {
      const body = {
        ...quoteResponse,
        zoneStatus,
        quoteId: null,
        option: null,
        costCents: 0,
        creditCents: 0,
        customerChargeCents: 0,
      };
      expect(normalizeShippingQuoteResponse(body)).toEqual(body);
    },
  );

  it('parses a STOCK_PENDING eta', () => {
    const body = {
      ...quoteResponse,
      eta: { days: null, reason: 'STOCK_PENDING' },
    };
    expect(normalizeShippingQuoteResponse(body)).toEqual(body);
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
    ['unknown key', { surprise: true }],
  ])('fails closed on %s', (_label, override) => {
    expect(
      normalizeShippingQuoteResponse({ ...quoteResponse, ...override }),
    ).toBeNull();
  });

  it('exports the known quote error codes', () => {
    expect(PACKAGING_DATA_MISSING).toBe('PACKAGING_DATA_MISSING');
    expect(SHIPPING_QUOTE_UNAVAILABLE).toBe('SHIPPING_QUOTE_UNAVAILABLE');
  });
});
