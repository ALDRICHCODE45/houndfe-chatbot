import {
  isShippingQuoteAddress,
  isShippingQuoteParcel,
  isShippingQuoteRequest,
  type ShippingQuoteAddress,
  type ShippingQuoteParcel,
  type ShippingQuoteRequest,
} from './shipping-quote.request';

const MAX = Number.MAX_SAFE_INTEGER;
const POSTAL_MAX = '1'.repeat(12);
const ADMIN_MAX = 'x'.repeat(100);

const addr = (over: Partial<ShippingQuoteAddress> = {}) => ({
  countryCode: 'MX',
  postalCode: '06700',
  state: 'Ciudad de Mexico',
  municipality: 'Cuauhtemoc',
  neighborhood: 'Roma Norte',
  ...over,
});

const parcel = (over: Partial<ShippingQuoteParcel> = {}) => ({
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  weightGrams: 500,
  ...over,
});

const valid = {
  origin: addr(),
  destination: addr({ postalCode: '44100', state: 'Jalisco' }),
  parcels: [parcel()],
} satisfies ShippingQuoteRequest;

const multi = {
  ...valid,
  parcels: [parcel(), parcel({ weightGrams: 1 })],
} satisfies ShippingQuoteRequest;

const req = (over: Record<string, unknown> = {}) => ({ ...valid, ...over });

describe('isShippingQuoteAddress', () => {
  it('accepts a canonical address and exact length boundaries', () => {
    expect(isShippingQuoteAddress(addr())).toBe(true);
    expect(
      isShippingQuoteAddress(
        addr({ postalCode: POSTAL_MAX, state: ADMIN_MAX }),
      ),
    ).toBe(true);
  });

  it.each([
    { ...addr(), countryCode: 'mx' },
    { ...addr(), countryCode: 'MEX' },
    { ...addr(), countryCode: ' MX' },
    { ...addr(), countryCode: 'MX ' },
    { ...addr(), countryCode: 'M' },
    { ...addr(), countryCode: undefined },
    { ...addr(), postalCode: '' },
    { ...addr(), postalCode: ' 06700' },
    { ...addr(), postalCode: '06700 ' },
    { ...addr(), postalCode: '1'.repeat(13) },
    { ...addr(), state: '' },
    { ...addr(), state: ' CDMX' },
    { ...addr(), state: 'x'.repeat(101) },
    { ...addr(), municipality: '' },
    { ...addr(), neighborhood: '   ' },
  ])('rejects a non-canonical address %#', (value) => {
    expect(isShippingQuoteAddress(value)).toBe(false);
  });
});

describe('isShippingQuoteParcel', () => {
  it.each(['lengthCm', 'widthCm', 'heightCm', 'weightGrams'] as const)(
    'accepts 1 and MAX_SAFE_INTEGER but rejects invalid %s values',
    (field) => {
      expect(isShippingQuoteParcel({ ...parcel(), [field]: 1 })).toBe(true);
      expect(isShippingQuoteParcel({ ...parcel(), [field]: MAX })).toBe(true);
      const invalid = [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        MAX + 1,
        null,
        undefined,
        '10',
        {},
        [],
      ];
      for (const bad of invalid) {
        expect(isShippingQuoteParcel({ ...parcel(), [field]: bad })).toBe(
          false,
        );
      }
    },
  );
});

describe('isShippingQuoteRequest', () => {
  it('accepts valid requests without mutating a frozen input', () => {
    expect(isShippingQuoteRequest(valid)).toBe(true);
    expect(isShippingQuoteRequest(multi)).toBe(true);
    const frozen = Object.freeze({
      origin: Object.freeze(addr()),
      destination: Object.freeze(addr({ postalCode: '44100' })),
      parcels: Object.freeze([Object.freeze(parcel())]),
    });
    const before = JSON.stringify(frozen);
    expect(isShippingQuoteRequest(frozen)).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it.each([
    [],
    undefined,
    null,
    'parcels',
    {},
    [parcel(), parcel({ weightGrams: 0 })],
  ])('rejects empty, missing, or invalid parcels %p', (parcels) => {
    expect(isShippingQuoteRequest({ ...req(), parcels })).toBe(false);
  });

  it.each([
    { ...addr(), state: '' },
    { ...addr(), countryCode: 'mx' },
    null,
    {},
  ])('rejects an invalid origin or destination %#', (value) => {
    expect(isShippingQuoteRequest({ ...req(), origin: value })).toBe(false);
    expect(isShippingQuoteRequest({ ...req(), destination: value })).toBe(
      false,
    );
  });

  it.each([null, undefined, [], ['MX'], 'value', 42, true, () => 'value'])(
    'rejects non-plain values %p from every guard',
    (value) => {
      expect(isShippingQuoteAddress(value)).toBe(false);
      expect(isShippingQuoteParcel(value)).toBe(false);
      expect(isShippingQuoteRequest(value)).toBe(false);
    },
  );

  it('rejects class instances and non-plain prototypes', () => {
    expect(isShippingQuoteRequest(Object.create(req()) as object)).toBe(false);
  });
});
