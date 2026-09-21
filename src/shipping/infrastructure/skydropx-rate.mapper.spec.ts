import type { ShippingQuoteRate } from '../domain/shipping-quote.result';
import { mapSkydropxRate } from './skydropx-rate.mapper';

type Rec = Record<string, unknown>;

const MAX = Number.MAX_SAFE_INTEGER;
const SECRET = 'SECRET_SENTINEL_7f';
const validRaw: Rec = {
  id: 'rate-1',
  success: true,
  provider_name: 'estafeta',
  provider_display_name: 'Estafeta',
  provider_service_name: 'Día Siguiente',
  provider_service_code: 'estafeta_next_day',
  currency_code: 'MXN',
  amount: '999.99',
  total: '129.00',
  days: 1,
};
const validRate = {
  rateId: 'rate-1',
  carrierName: 'Estafeta',
  serviceName: 'Día Siguiente',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 1,
  validUntil: null,
} satisfies ShippingQuoteRate;
const map = mapSkydropxRate;
const raw = (over: Rec = {}): Rec => ({ ...validRaw, ...over });
const mapWith = (over: Rec) => map(raw(over));
const validTotals: Array<[unknown, number]> = [
  ['0', 0],
  ['0.0', 0],
  ['0.00', 0],
  ['150', 15_000],
  ['150.0', 15_000],
  ['150.00', 15_000],
  ['150.5', 15_050],
  ['150.55', 15_055],
  [0, 0],
  [0.01, 1],
  [0.29, 29],
  [150, 15_000],
  [150.5, 15_050],
  [150.99, 15_099],
];
const invalidTotals: unknown[] = [
  '',
  ' ',
  ' 150',
  '150 ',
  '+150',
  '-150',
  '-0',
  '0150',
  '00',
  '01.5',
  '150.',
  '.5',
  '1e2',
  '150.000',
  '1.234',
  'NaN',
  'Infinity',
  '0x10',
  '1_000',
  '150,5',
  -1,
  -0.01,
  -0,
  1.234,
  1.005,
  0.30000000000000004,
  1e21,
  1e-7,
  NaN,
  Infinity,
  -Infinity,
  MAX,
  90071992547409.92,
  Object(150),
  { valueOf: () => 150 },
  true,
  null,
  undefined,
  [],
  {},
  150n,
];
const invalidStrings: Record<string, unknown[]> = {
  id: ['', ' r', 'r ', '   ', 'x'.repeat(129), 42, true, null, undefined],
  provider_display_name: ['', 'x ', 'x'.repeat(129), 42, null, undefined],
  provider_service_name: ['', ' x', 'x'.repeat(129), 42, null, undefined],
};

describe('mapSkydropxRate', () => {
  it('maps the documented string and numeric totals into a fresh rate', () => {
    const out = map(validRaw);
    expect(out).toEqual(validRate);
    expect(out).not.toBe(validRaw);
    expect(map(raw({ total: 129 }))?.priceCents).toBe(12_900);
    expect(map(raw({ total: 129.5 }))?.priceCents).toBe(12_950);
  });

  it('accepts a null-prototype record', () => {
    const bare = Object.assign(Object.create(null) as Rec, validRaw);
    expect(map(bare)).toEqual(validRate);
  });

  it('accepts 128-char identifiers and rejects blanks, padding, and overflow', () => {
    expect(mapWith({ id: 'x'.repeat(128) })).not.toBeNull();
    expect(mapWith({ provider_display_name: 'x'.repeat(128) })).not.toBeNull();
    expect(mapWith({ provider_service_name: 'x'.repeat(128) })).not.toBeNull();
    expect(mapWith({ id: 'x'.repeat(129) })).toBeNull();
    expect(mapWith({ id: '' })).toBeNull();
    expect(mapWith({ id: ' x' })).toBeNull();
    expect(mapWith({ id: 'x ' })).toBeNull();
  });

  it('accepts the decimal table and rejects malformed, negative, or overflow totals', () => {
    for (const [total, cents] of validTotals) {
      const out = mapWith({ total });
      expect(out).not.toBeNull();
      expect(out?.priceCents).toBe(cents);
    }
    for (const total of invalidTotals) {
      expect(mapWith({ total })).toBeNull();
    }
  });

  it('handles MAX_SAFE cents and rejects ambiguous numeric totals', () => {
    expect(mapWith({ total: '90071992547409.91' })?.priceCents).toBe(MAX);
    expect(mapWith({ total: '90071992547409.92' })).toBeNull();
    expect(mapWith({ total: MAX })).toBeNull();
    expect(mapWith({ total: 90071992547409.92 })).toBeNull();
    expect(mapWith({ total: 90071992547409.9 })).toBeNull();
    expect(mapWith({ total: 80000000000000.02 })).toBeNull();
    expect(mapWith({ total: 90071992547409.89 })).not.toBeNull();
  });

  it('requires a primitive nonnegative safe integer `days`', () => {
    expect(mapWith({ days: 0 })?.estimatedDeliveryDays).toBe(0);
    expect(mapWith({ days: MAX })?.estimatedDeliveryDays).toBe(MAX);
    for (const days of [
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      MAX + 1,
      '1',
      true,
      null,
      1n,
    ]) {
      expect(mapWith({ days })).toBeNull();
    }
    const absent = { ...validRaw };
    delete absent.days;
    expect(map(absent)).toBeNull();
  });

  it('rejects every invalid required string field', () => {
    for (const [field, values] of Object.entries(invalidStrings)) {
      for (const value of values) {
        expect(mapWith({ [field]: value })).toBeNull();
      }
    }
  });

  it('does not fall back to provider_name or provider_service_code', () => {
    const noDisplay = { ...validRaw };
    delete noDisplay.provider_display_name;
    const noService = { ...validRaw };
    delete noService.provider_service_name;
    expect(map(noDisplay)).toBeNull();
    expect(map(noService)).toBeNull();
  });

  it('requires success === true and the exact currency_code MXN', () => {
    for (const success of [false, 'true', 1, 0, null, undefined]) {
      expect(mapWith({ success })).toBeNull();
    }
    for (const currency_code of [
      'USD',
      'mxn',
      'MXN ',
      ' MXN',
      42,
      null,
      undefined,
    ]) {
      expect(mapWith({ currency_code })).toBeNull();
    }
  });

  it.each([null, undefined, [], 'value', 42, true, () => 'value', new Date()])(
    'returns null for non-record input %p',
    (value) => expect(map(value)).toBeNull(),
  );

  it('rejects class instances', () => {
    class Rate {
      id = 'rate-1';
      success = true;
    }
    expect(map(new Rate())).toBeNull();
  });

  it('returns null when getters, proxies, or prototypes throw', () => {
    const boom = (): never => {
      throw new Error(SECRET);
    };
    const hostile: Rec = { ...validRaw };
    Object.defineProperty(hostile, 'total', { get: boom });
    const proxy = new Proxy(
      { ...validRaw },
      {
        get: boom,
        getPrototypeOf: boom,
        has: boom,
      },
    );
    let result: unknown;
    expect(() => {
      result = map(hostile);
    }).not.toThrow();
    expect(result).toBeNull();
    expect(() => map(proxy)).not.toThrow();
    expect(map(proxy)).toBeNull();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('snapshots each field once so stateful getters cannot swap values', () => {
    let totalReads = 0;
    let idReads = 0;
    const stateful: Rec = { ...validRaw };
    Object.defineProperty(stateful, 'total', {
      get: () => ((totalReads += 1) === 1 ? '129.00' : SECRET),
    });
    Object.defineProperty(stateful, 'id', {
      get: () => ((idReads += 1) === 1 ? 'rate-1' : SECRET),
    });
    const out = map(stateful);
    expect(out).toMatchObject({ priceCents: 12_900, rateId: 'rate-1' });
    expect(totalReads).toBe(1);
    expect(idReads).toBe(1);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('returns a fresh frozen object with only domain keys and strips secrets', () => {
    const out = map(
      raw({
        token: SECRET,
        authorization: `Bearer ${SECRET}`,
        body: { authorization: SECRET },
        status: SECRET,
        fees: SECRET,
        protection: SECRET,
        amount: SECRET,
      }),
    );
    if (out === null) throw new Error('expected a mapped rate');
    expect(Object.keys(out).sort().join()).toBe(
      'carrierName,currency,estimatedDeliveryDays,priceCents,rateId,serviceName,validUntil',
    );
    expect(out).not.toBe(validRaw);
    expect(Object.isFrozen(out)).toBe(true);
    expect(out).toMatchObject({ currency: 'MXN', validUntil: null });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('does not mutate a frozen input', () => {
    const frozen = Object.freeze({ ...validRaw });
    const before = JSON.stringify(frozen);
    expect(map(frozen)).not.toBeNull();
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('ignores unrelated fields and rejects prototype mismatches', () => {
    expect(map(raw({ amount: '9999.99', total: '1.00' }))?.priceCents).toBe(
      100,
    );
    expect(mapWith({ days: false })).toBeNull();
    const arrayProto = Object.create(Array.prototype) as Rec;
    Object.assign(arrayProto, validRaw);
    expect(map(arrayProto)).toBeNull();
    class ProviderRate {}
    const classProto = Object.create(ProviderRate.prototype) as Rec;
    Object.assign(classProto, validRaw);
    expect(map(classProto)).toBeNull();
    expect(mapWith({ total: '1'.repeat(32) })).toBeNull();
  });
});
