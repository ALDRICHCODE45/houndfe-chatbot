import {
  normalizeShippingQuoteQuotedResult,
  type ShippingQuoteRate,
} from './shipping-quote.result';

type Rec = Record<string, unknown>;

const MAX = Number.MAX_SAFE_INTEGER;
const ISO = '2026-01-02T03:04:05.000Z';
const validRate = {
  rateId: 'rate-1',
  carrierName: 'Estafeta',
  serviceName: 'Dia Siguiente',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 1,
  validUntil: ISO,
} satisfies ShippingQuoteRate;
const validResult = {
  kind: 'quoted',
  quoteId: 'quote-1',
  rates: [validRate],
  expiresAt: ISO,
};
const rate = (over: Rec = {}): Rec => ({ ...validRate, ...over });
const make = (over: Rec = {}): Rec => ({ ...validResult, ...over });
const normalize = normalizeShippingQuoteQuotedResult;
const rateWith = (over: Rec) => normalize(make({ rates: [rate(over)] }));
const resultWith = (over: Rec) => normalize(make(over));
const many = (count: number): Rec[] =>
  Array.from({ length: count }, (_, i) => rate({ rateId: `r-${i}` }));
const keys = (value: object): string => Object.keys(value).sort().join();
const withLength = (length: unknown): Rec[] =>
  new Proxy([rate()], {
    get(target, property, receiver) {
      if (property === 'length') return length;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

const badTimestamps = [
  'not-a-date',
  '2026-01-02',
  '2026-01-02T03:04:05',
  'Jan 2, 2026',
  '2026-13-45T00:00:00Z',
  '2026-02-30T00:00:00Z',
  '2026-01-02T03:60:05Z',
  '2026-01-02T03:04:60Z',
  '2026-01-02T03:04:05+24:00',
  '2026-01-02T03:04:05+00:60',
];
const badFields: Record<string, unknown[]> = {
  rateId: ['', ' r', 'r ', 'r'.repeat(129), 42],
  carrierName: ['', 'x ', 'x'.repeat(129)],
  serviceName: ['', ' x', 'x'.repeat(129)],
  priceCents: [-1, 1.5, NaN, Infinity, MAX + 1, '12900', null, undefined],
  currency: ['USD', 'mxn', 'MXN ', null, undefined],
  estimatedDeliveryDays: [-1, 1.5, NaN, Infinity, MAX + 1, '1', undefined],
  validUntil: badTimestamps,
};
const badMeta: Rec[] = [
  { kind: 'rejected' },
  { kind: undefined },
  { quoteId: '' },
  { quoteId: 'q'.repeat(129) },
  { quoteId: 42 },
  { expiresAt: undefined },
];

describe('normalizeShippingQuoteQuotedResult', () => {
  it('normalizes one rate into fresh exact objects', () => {
    const out = normalize(validResult);
    expect(out).toEqual({ ...validResult, rates: [{ ...validRate }] });
    expect(out).not.toBe(validResult);
    expect(out?.rates).not.toBe(validResult.rates);
    expect(out?.rates[0]).not.toBe(validRate);
  });

  it('bounds the rate count at 100 and rejects empty and overflow', () => {
    expect(normalize(make({ rates: many(100) }))?.rates).toHaveLength(100);
    expect(normalize(make({ rates: many(101) }))).toBeNull();
    expect(normalize(make({ rates: [] }))).toBeNull();
  });

  it('rejects untrusted array lengths without indexing or looping', () => {
    for (const length of [
      NaN,
      1.5,
      -1,
      0,
      101,
      MAX + 1,
      Infinity,
      '2',
      undefined,
    ]) {
      expect(normalize(make({ rates: withLength(length) }))).toBeNull();
    }
  });

  it('strips extra result and rate keys including sentinel secrets', () => {
    const secret = 'svc_super_secret_token_value';
    const out = normalize({
      ...validResult,
      token: secret,
      payload: { authorization: secret },
      shippingAddress: 'Calle Secreta 123',
      message: secret,
      rates: [{ ...validRate, internalCostCents: 1, token: secret }],
    });
    if (out === null) throw new Error('expected a normalized result');
    expect(`${keys(out)}|${keys(out.rates[0])}`).toBe(
      'expiresAt,kind,quoteId,rates|carrierName,currency,estimatedDeliveryDays,priceCents,rateId,serviceName,validUntil',
    );
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('does not mutate a frozen input', () => {
    const frozen = Object.freeze({
      ...validResult,
      rates: Object.freeze([Object.freeze({ ...validRate })]),
    });
    const before = JSON.stringify(frozen);
    expect(normalize(frozen)).not.toBeNull();
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('canonicalizes zoned timestamps and passes through nulls', () => {
    const out = normalize(
      make({
        expiresAt: '2026-01-02T08:34:05+05:30',
        rates: [rate({ validUntil: '2026-01-02T03:04:05Z' })],
      }),
    );
    expect(out?.expiresAt).toBe(ISO);
    expect(out?.rates[0].validUntil).toBe(ISO);
    const negative = normalize(
      make({ expiresAt: '2026-01-01T22:04:05-05:00' }),
    );
    expect(negative?.expiresAt).toBe(ISO);
    const nulls = normalize(
      make({ expiresAt: null, rates: [rate({ validUntil: null })] }),
    );
    expect(nulls?.expiresAt).toBeNull();
    expect(nulls?.rates[0].validUntil).toBeNull();
  });

  it('accepts 128-char strings and boundary numbers including same-day', () => {
    const padded = { rateId: 'x'.repeat(128), serviceName: 'x'.repeat(128) };
    expect(rateWith(padded)).not.toBeNull();
    expect(rateWith({ priceCents: MAX })).not.toBeNull();
    expect(rateWith({ estimatedDeliveryDays: 0 })).not.toBeNull();
    expect(rateWith({ estimatedDeliveryDays: MAX })).not.toBeNull();
  });

  it('rejects invalid rate fields, timestamps, and result metadata', () => {
    for (const [field, values] of Object.entries(badFields)) {
      for (const value of values) {
        expect(rateWith({ [field]: value })).toBeNull();
      }
    }
    for (const timestamp of badTimestamps) {
      expect(resultWith({ expiresAt: timestamp })).toBeNull();
    }
    for (const over of badMeta) {
      expect(resultWith(over)).toBeNull();
    }
  });

  it('rejects sparse, non-array, and invalid rate entries', () => {
    const sparse: unknown[] = [validRate];
    sparse.length = 2;
    const holeOnly: unknown[] = [];
    holeOnly.length = 1;
    expect(normalize(make({ rates: sparse }))).toBeNull();
    expect(normalize(make({ rates: holeOnly }))).toBeNull();
    for (const rates of ['rates', null, undefined, {}, 42, [42], [null]]) {
      expect(normalize(make({ rates }))).toBeNull();
    }
  });

  it.each([null, undefined, [], 'value', 42, true, () => 'value', new Date()])(
    'rejects non-plain result values %p',
    (value) => expect(normalize(value)).toBeNull(),
  );

  it('rejects class instances', () => {
    class Quote {
      kind = 'quoted';
      quoteId = 'quote-1';
      rates = [validRate];
      expiresAt = null;
    }
    expect(normalize(new Quote())).toBeNull();
  });

  it('returns null when getters or proxies throw', () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    const boom = (): never => {
      throw new Error('boom');
    };
    const rateBoom: Rec = { ...validRate };
    Object.defineProperty(rateBoom, 'priceCents', { get: boom });
    expect(normalize(make({ rates: [rateBoom] }))).toBeNull();
    expect(normalize(new Proxy(make(), { get: boom }))).toBeNull();
    expect(normalize(proxy)).toBeNull();
  });

  it('snapshots each field once so stateful getters cannot leak secrets', () => {
    const secret = 'svc_late_secret_value';
    const quoteReads = { n: 0 };
    const rateReads = { n: 0 };
    const statefulRate: Rec = { ...validRate };
    const quote: Rec = { ...validResult, rates: [statefulRate] };
    Object.defineProperty(statefulRate, 'priceCents', {
      get: () => ((rateReads.n += 1) === 1 ? 12_900 : secret),
    });
    Object.defineProperty(quote, 'quoteId', {
      get: () => ((quoteReads.n += 1) === 1 ? 'quote-1' : secret),
    });
    const out = normalize(quote);
    expect(out?.quoteId).toBe('quote-1');
    expect(out?.rates[0].priceCents).toBe(12_900);
    expect(quoteReads.n).toBe(1);
    expect(rateReads.n).toBe(1);
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('bounds work by the initial rates length when it grows live', () => {
    let lengthReads = 0;
    const live = new Proxy([rate()], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 10_000;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(normalize(make({ rates: live }))?.rates).toHaveLength(1);
  });
});
