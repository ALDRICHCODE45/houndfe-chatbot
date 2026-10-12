import {
  CHECKOUT_CONTEXT_DEFAULT_LIMIT,
  normalizeCheckoutContextQuery,
  normalizeCustomerCheckoutContext,
  isDigitCheckoutCountryCode,
  isDigitCheckoutPhone,
  isCheckoutUuid,
} from './checkout-context.dto';

type Rec = Record<string, unknown>;

const ADDRESS_ID = 'a1bc2def-1111-4111-8111-111111111111';
const ADDRESS_ID_2 = 'b2cd3ef0-2222-4222-8222-222222222222';
const CUSTOMER_ID = 'd4ef5012-4444-4444-8444-444444444444';
const VALID_UUID = 'e5f06123-5555-4555-8555-555555555555';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const UPPER_UUID = 'A1BC2DEF-1111-4111-8111-111111111111';
const BAD_VERSION_UUID = 'a1bc2def-1111-0111-8111-111111111111';
const BAD_VARIANT_UUID = 'a1bc2def-1111-4111-0111-111111111111';
const V9_UUID = 'a1bc2def-1111-9111-8111-111111111111';
const VERSION = '2026-06-22T10:30:00.000Z';

const omit = (o: Rec, k: string): Rec => {
  const c = { ...o };
  delete c[k];
  return c;
};
const boom = (): never => {
  throw new Error('boom');
};

const address = (extra: Rec = {}): Rec => ({
  id: ADDRESS_ID,
  version: VERSION,
  label: 'Casa',
  street: 'Av. Reforma 123',
  exteriorNumber: '123',
  interiorNumber: null,
  zipCode: '06600',
  neighborhood: 'Juárez',
  municipality: 'Cuauhtémoc',
  city: 'CDMX',
  state: 'CDMX',
  visualReferences: null,
  carrierPhone: null,
  ...extra,
});

const customer = (extra: Rec = {}): Rec => ({
  customerId: CUSTOMER_ID,
  firstName: 'Ana',
  lastName: 'López',
  ...extra,
});

const notFound = (extra: Rec = {}): Rec => ({
  status: 'not_found',
  customer: null,
  addresses: [],
  nextAfterAddressId: null,
  ...extra,
});

const ambiguous = (extra: Rec = {}): Rec => ({
  status: 'ambiguous',
  customer: null,
  addresses: [],
  nextAfterAddressId: null,
  ...extra,
});

const unique = (extra: Rec = {}): Rec => ({
  status: 'unique',
  customer: customer(),
  addresses: [address()],
  nextAfterAddressId: null,
  ...extra,
});

const norm = (v: unknown) => normalizeCustomerCheckoutContext(v);
const normQuery = (v: unknown) => normalizeCheckoutContextQuery(v);

describe('normalizeCustomerCheckoutContext', () => {
  it('normalizes the three discriminants and canonical values', () => {
    const empty = unique({
      customer: customer({ lastName: null }),
      addresses: [],
    });
    const twoPages = unique({
      addresses: [address(), address({ id: ADDRESS_ID_2, street: ' ' })],
      nextAfterAddressId: ADDRESS_ID_2,
    });
    for (const v of [notFound(), ambiguous(), unique(), empty, twoPages]) {
      expect(norm(v)).toEqual(v);
    }
  });

  it('accepts uppercase, nil and max UUIDs without altering the projected values', () => {
    const upper = unique({
      customer: customer({ customerId: CUSTOMER_ID.toUpperCase() }),
      addresses: [address({ id: UPPER_UUID })],
      nextAfterAddressId: UPPER_UUID,
    });
    const nil = unique({
      customer: customer({ customerId: NIL_UUID }),
      addresses: [address({ id: NIL_UUID })],
      nextAfterAddressId: NIL_UUID,
    });
    const max = unique({
      customer: customer({ customerId: MAX_UUID }),
      addresses: [address({ id: MAX_UUID })],
      nextAfterAddressId: MAX_UUID,
    });
    for (const v of [upper, nil, max]) {
      expect(norm(v)).toEqual(v);
    }
  });

  it('treats case-different UUIDs as distinct opaque strings', () => {
    const distinct = unique({
      addresses: [address({ id: ADDRESS_ID }), address({ id: UPPER_UUID })],
    });
    expect(norm(distinct)).toEqual(distinct);

    const exactDuplicate = unique({
      addresses: [address({ id: ADDRESS_ID }), address({ id: ADDRESS_ID })],
    });
    expect(norm(exactDuplicate)).toBeNull();
  });

  it('rejects a cursor that differs only by case from the last address id', () => {
    expect(
      norm(
        unique({
          addresses: [address({ id: ADDRESS_ID })],
          nextAfterAddressId: UPPER_UUID,
        }),
      ),
    ).toBeNull();

    const exact = unique({
      addresses: [address({ id: ADDRESS_ID })],
      nextAfterAddressId: ADDRESS_ID,
    });
    expect(norm(exact)).toEqual(exact);

    const exactUpper = unique({
      addresses: [address({ id: UPPER_UUID })],
      nextAfterAddressId: UPPER_UUID,
    });
    expect(norm(exactUpper)).toEqual(exactUpper);
  });

  it('requires every declared envelope key and rejects extras and symbols', () => {
    for (const k of Object.keys(unique())) {
      expect(norm(omit(unique(), k))).toBeNull();
      expect(norm(omit(notFound(), k))).toBeNull();
    }
    expect(norm(unique({ tenantId: CUSTOMER_ID }))).toBeNull();
    expect(norm({ ...unique(), [Symbol('x')]: 1 })).toBeNull();
    expect(norm(unique({ status: undefined }))).toBeNull();
    expect(norm(unique({ nextAfterAddressId: undefined }))).toBeNull();
  });

  it('rejects an unknown or non-string status', () => {
    for (const status of ['CANCELLED', '', 7, null, undefined]) {
      expect(norm(unique({ status }))).toBeNull();
    }
  });

  it('forces not_found/ambiguous to null customer, empty addresses and no cursor', () => {
    for (const make of [notFound, ambiguous]) {
      expect(norm(make())).not.toBeNull();
      expect(norm(make({ customer: customer() }))).toBeNull();
      expect(norm(make({ addresses: [address()] }))).toBeNull();
      expect(norm(make({ nextAfterAddressId: VALID_UUID }))).toBeNull();
    }
  });

  it('rejects malformed customer projections', () => {
    const cases: Rec[] = [
      { customer: null },
      { customer: omit(customer(), 'customerId') },
      { customer: omit(customer(), 'firstName') },
      { customer: omit(customer(), 'lastName') },
      { customer: customer({ tenantId: 'x' }) },
      { customer: customer({ customerId: 'not-a-uuid' }) },
      { customer: customer({ customerId: BAD_VERSION_UUID }) },
      { customer: customer({ customerId: V9_UUID }) },
      { customer: customer({ customerId: BAD_VARIANT_UUID }) },
      { customer: customer({ firstName: 7 }) },
      { customer: customer({ lastName: 7 }) },
      { customer: customer({ lastName: undefined }) },
      { customer: customer({ [Symbol('x')]: 1 }) },
      { customer: [] },
    ];
    for (const extra of cases) {
      expect(norm(unique(extra))).toBeNull();
    }
  });

  it('requires a bounded address array and rejects duplicates', () => {
    expect(norm(unique({ addresses: 'nope' }))).toBeNull();
    expect(norm(unique({ addresses: [address(), 'x'] }))).toBeNull();
    expect(norm(unique({ addresses: [address(), address()] }))).toBeNull();
    const twenty = Array.from({ length: 20 }, (_, i) =>
      address({ id: `a1bc2def-1111-4111-8111-${String(i).padStart(12, '0')}` }),
    );
    expect(norm(unique({ addresses: twenty }))).not.toBeNull();
    const twentyOne = [
      ...twenty,
      address({ id: 'a1bc2def-1111-4111-8111-999999999999' }),
    ];
    expect(
      norm(
        unique({
          addresses: twentyOne,
          nextAfterAddressId: 'a1bc2def-1111-4111-8111-999999999999',
        }),
      ),
    ).toBeNull();
  });

  it('rejects malformed address projections', () => {
    const cases: Array<Rec | null> = [
      omit(address(), 'id'),
      omit(address(), 'version'),
      omit(address(), 'street'),
      address({ id: 'not-a-uuid' }),
      address({ id: BAD_VERSION_UUID }),
      address({ id: V9_UUID }),
      address({ id: BAD_VARIANT_UUID }),
      address({ version: 'not-a-date' }),
      address({ version: '2026-06-22T12:30:00+02:00' }),
      address({ version: '2026-06-22' }),
      address({ version: 7 }),
      address({ street: null }),
      address({ street: 7 }),
      address({ label: 7 }),
      address({ exteriorNumber: 7 }),
      address({ interiorNumber: false }),
      address({ zipCode: 123 }),
      address({ neighborhood: true }),
      address({ municipality: 1 }),
      address({ city: [] }),
      address({ state: {} }),
      address({ visualReferences: 3 }),
      address({ carrierPhone: 5 }),
      address({ createdAt: VERSION }),
      address({ [Symbol('x')]: 1 }),
      { ...address(), version: undefined },
    ];
    for (const value of cases) {
      expect(norm(unique({ addresses: [value] }))).toBeNull();
    }
  });

  it('rejects a malformed or inconsistent nextAfterAddressId', () => {
    expect(norm(unique({ nextAfterAddressId: 'not-a-uuid' }))).toBeNull();
    expect(norm(unique({ nextAfterAddressId: BAD_VERSION_UUID }))).toBeNull();
    expect(norm(unique({ nextAfterAddressId: V9_UUID }))).toBeNull();
    expect(norm(unique({ nextAfterAddressId: BAD_VARIANT_UUID }))).toBeNull();
    expect(norm(unique({ nextAfterAddressId: NIL_UUID }))).toBeNull();
    expect(
      norm(unique({ addresses: [], nextAfterAddressId: VALID_UUID })),
    ).toBeNull();
    expect(norm(unique({ nextAfterAddressId: ADDRESS_ID_2 }))).toBeNull();
  });

  it('fails closed on hostile getters, proxies and non-objects', () => {
    const getter = unique();
    Object.defineProperty(getter, 'status', { enumerable: true, get: boom });
    expect(norm(getter)).toBeNull();
    expect(norm(new Proxy(unique(), { ownKeys: boom }))).toBeNull();
    expect(norm(new Proxy(unique(), { get: boom }))).toBeNull();
    for (const v of [null, 'nope', 7, true]) expect(norm(v)).toBeNull();
  });
});

describe('normalizeCheckoutContextQuery', () => {
  it('defaults the limit and cursor', () => {
    expect(normQuery(undefined)).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: null,
    });
    expect(normQuery({})).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: null,
    });
    expect(normQuery({ limit: undefined, afterAddressId: null })).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: null,
    });
  });

  it('accepts the inclusive limit boundaries and an optional cursor', () => {
    expect(normQuery({ limit: 1 })).toEqual({ limit: 1, afterAddressId: null });
    expect(normQuery({ limit: 20 })).toEqual({
      limit: 20,
      afterAddressId: null,
    });
    expect(normQuery({ afterAddressId: VALID_UUID })).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: VALID_UUID,
    });
    expect(normQuery({ afterAddressId: UPPER_UUID })).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: UPPER_UUID,
    });
    expect(normQuery({ afterAddressId: NIL_UUID })).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: NIL_UUID,
    });
    expect(normQuery({ afterAddressId: MAX_UUID })).toEqual({
      limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT,
      afterAddressId: MAX_UUID,
    });
  });

  it('rejects an invalid limit instead of clamping it', () => {
    for (const limit of [0, 21, -1, 1.5, Number.NaN, '5', null, true, {}]) {
      expect(normQuery({ limit })).toBeNull();
    }
  });

  it('rejects a malformed cursor and unknown option keys', () => {
    for (const afterAddressId of [
      'not-a-uuid',
      ` ${VALID_UUID}`,
      BAD_VERSION_UUID,
      V9_UUID,
      BAD_VARIANT_UUID,
      7,
    ]) {
      expect(normQuery({ afterAddressId })).toBeNull();
    }
    expect(normQuery({ extra: 1 })).toBeNull();
    expect(normQuery({ [Symbol('x')]: 1 })).toBeNull();
    expect(normQuery(null)).toBeNull();
    expect(normQuery('nope')).toBeNull();
    expect(normQuery([])).toBeNull();
  });
});

describe('checkout-context identity validators', () => {
  it('accepts only 1-10 ASCII digit country codes', () => {
    for (const value of ['1', '52', '1234567890']) {
      expect(isDigitCheckoutCountryCode(value)).toBe(true);
    }
    for (const value of ['', '12345678901', '+52', '5 2', '٥٢', '52a', 52]) {
      expect(isDigitCheckoutCountryCode(value)).toBe(false);
    }
  });

  it('accepts only 1-20 ASCII digit phone numbers', () => {
    for (const value of ['1', '5550001111', '12345678901234567890']) {
      expect(isDigitCheckoutPhone(value)).toBe(true);
    }
    for (const value of [
      '',
      '123456789012345678901',
      '+525550001111',
      '5-5',
      null,
    ]) {
      expect(isDigitCheckoutPhone(value)).toBe(false);
    }
  });

  it('accepts the backend @IsUUID all profile: v1-v8 any case plus nil and max', () => {
    for (const value of [
      VALID_UUID,
      VALID_UUID.toUpperCase(),
      UPPER_UUID,
      NIL_UUID,
      MAX_UUID,
      MAX_UUID.toUpperCase(),
    ]) {
      expect(isCheckoutUuid(value)).toBe(true);
    }
    for (const value of [
      BAD_VERSION_UUID,
      V9_UUID,
      BAD_VARIANT_UUID,
      'x',
      null,
    ]) {
      expect(isCheckoutUuid(value)).toBe(false);
    }
  });
});
