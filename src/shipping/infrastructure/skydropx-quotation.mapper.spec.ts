import type { ShippingQuoteProviderResult } from '../domain/shipping-quote.port';
import { normalizeShippingQuoteQuotedResult } from '../domain/shipping-quote.result';
import { mapSkydropxQuotation } from './skydropx-quotation.mapper';

type Rec = Record<string, unknown>;

const SECRET = 'SECRET_SENTINEL_7f';
const QUOTE = 'quote-1';
const raw = (over: Rec = {}): Rec => ({
  id: 'rate-1',
  success: true,
  provider_display_name: 'Estafeta',
  provider_service_name: 'Día Siguiente',
  currency_code: 'MXN',
  total: '129.00',
  days: 1,
  ...over,
});
const dead = (over: Rec = {}): Rec => raw({ success: false, ...over });
const rate = {
  rateId: 'rate-1',
  carrierName: 'Estafeta',
  serviceName: 'Día Siguiente',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 1,
  validUntil: null,
};
const quoted = (rates: unknown[]) => ({
  kind: 'quoted',
  quoteId: QUOTE,
  rates,
  expiresAt: null,
});
const noRates = { kind: 'error', error: { kind: 'no_rates' } };
const malformed = { kind: 'error', error: { kind: 'malformed_response' } };
const map = mapSkydropxQuotation;
const many = (count: number): Rec[] =>
  Array.from({ length: count }, (_, i) => raw({ id: `r-${i}` }));
const ids = (out: ShippingQuoteProviderResult): readonly string[] => {
  if (out.kind !== 'quoted') throw new Error('expected a quoted result');
  return out.rates.map((item) => item.rateId);
};

describe('mapSkydropxQuotation', () => {
  it('maps one valid rate into a fresh provider-neutral envelope', () => {
    const element = raw();
    const out = map(QUOTE, [element]);
    expect(out).toEqual(quoted([rate]));
    expect(out).toEqual(normalizeShippingQuoteQuotedResult(quoted([rate])));
    if (out.kind !== 'quoted') throw new Error('expected a quoted result');
    expect(out.rates[0]).not.toBe(element);
    expect(out.expiresAt).toBeNull();
  });

  it('filters unusable rates, preserves order, and keeps duplicates', () => {
    const out = map(QUOTE, [
      raw(),
      dead(),
      raw({ id: 'rate-2' }),
      raw({ id: 'rate-2' }),
      raw({ id: 'bad', total: 'not-money' }),
    ]);
    expect(ids(out)).toEqual(['rate-1', 'rate-2', 'rate-2']);
  });

  it('accepts a dense 100-rate boundary and rejects 101 as malformed', () => {
    const out = map(QUOTE, many(100));
    if (out.kind !== 'quoted') throw new Error('expected a quoted result');
    expect(out.rates).toHaveLength(100);
    expect(map(QUOTE, many(101))).toEqual(malformed);
  });

  it('rejects invalid or hostile quotation ids as malformed', () => {
    for (const id of [
      '',
      ' q',
      'q ',
      'x'.repeat(129),
      42,
      null,
      undefined,
      {},
      ['q'],
    ]) {
      expect(map(id, [raw()])).toEqual(malformed);
    }
    const hostile = map({ quoteId: QUOTE, token: SECRET }, [raw()]);
    expect(hostile).toEqual(malformed);
    expect(JSON.stringify(hostile)).not.toContain(SECRET);
  });

  it('rejects invalid or hostile ids before rate filtering', () => {
    for (const id of [
      '',
      ' q',
      'q ',
      'x'.repeat(129),
      42,
      null,
      undefined,
      {},
      ['q'],
    ]) {
      const empty = map(id, []);
      expect(empty).toEqual(malformed);
      expect(empty).not.toEqual(noRates);
      expect(map(id, [dead()])).toEqual(malformed);
      expect(map(id, [dead(), raw({ currency_code: 'USD' })])).toEqual(
        malformed,
      );
    }
    expect(map(QUOTE, [])).toEqual(noRates);
    expect(map(QUOTE, [dead()])).toEqual(noRates);
    expect(map(QUOTE, [dead(), raw({ currency_code: 'USD' })])).toEqual(
      noRates,
    );
  });

  it('returns the exact no_rates error for empty or fully invalid rates', () => {
    for (const input of [
      [],
      [dead()],
      [dead(), raw({ currency_code: 'USD' })],
    ]) {
      const out = map(QUOTE, input);
      expect(out).toEqual(noRates);
      expect(Object.keys(out)).toEqual(['kind', 'error']);
      if (out.kind !== 'error') throw new Error('expected an error envelope');
      expect(Object.keys(out.error)).toEqual(['kind']);
    }
  });

  it('rejects non-arrays, subclasses, and null-prototype arrays', () => {
    for (const value of [
      null,
      undefined,
      42,
      'rates',
      {},
      { length: 1 },
      new Date(),
      () => 1,
    ]) {
      expect(map(QUOTE, value)).toEqual(malformed);
    }
    class Rates extends Array<Rec> {
      marker = true;
    }
    const subclass = new Rates();
    subclass.push(raw());
    expect(map(QUOTE, subclass)).toEqual(malformed);
    expect(map(QUOTE, Object.setPrototypeOf([raw()], null))).toEqual(malformed);
  });

  it('rejects sparse and hole-only arrays as malformed', () => {
    const gapped: unknown[] = [raw()];
    gapped[2] = raw({ id: 'r-2' });
    const holeOnly: unknown[] = [];
    holeOnly.length = 2;
    expect(map(QUOTE, gapped)).toEqual(malformed);
    expect(map(QUOTE, holeOnly)).toEqual(malformed);
  });

  it('rejects throwing length, index, own, and prototype proxy traps', () => {
    const lengthBoom = new Proxy([raw()], {
      get(target, property) {
        if (property === 'length') throw new Error(SECRET);
        return Reflect.get(target, property) as unknown;
      },
    });
    const indexBoom = new Proxy([raw()], {
      get(target, property) {
        if (property === 'length') return target.length;
        throw new Error(SECRET);
      },
    });
    const ownBoom = new Proxy([raw()], {
      getOwnPropertyDescriptor() {
        throw new Error(SECRET);
      },
    });
    const protoBoom = new Proxy([raw()], {
      getPrototypeOf() {
        throw new Error(SECRET);
      },
    });
    for (const value of [lengthBoom, indexBoom, ownBoom, protoBoom]) {
      const out = map(QUOTE, value);
      expect(out).toEqual(malformed);
      expect(out).not.toEqual(noRates);
      expect(JSON.stringify(out)).not.toContain(SECRET);
    }
  });

  it('rejects oversized lengths and snapshots a mutating length once', () => {
    const oversized = new Proxy([raw()], {
      get(target, property) {
        if (property === 'length') return 101;
        return Reflect.get(target, property) as unknown;
      },
    });
    let lengthReads = 0;
    const live = new Proxy([raw()], {
      get(target, property) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 500;
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    expect(map(QUOTE, oversized)).toEqual(malformed);
    expect(ids(map(QUOTE, live))).toEqual(['rate-1']);
    expect(lengthReads).toBe(1);
  });

  it('reads each element once so stateful index getters cannot swap values', () => {
    let reads = 0;
    const once = new Proxy([raw()], {
      get(target, property) {
        if (property === 'length') return target.length;
        reads += 1;
        return reads === 1 ? raw() : raw({ total: SECRET });
      },
    });
    const out = map(QUOTE, once);
    expect(out).toEqual(quoted([rate]));
    expect(reads).toBe(1);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('detaches output from later input mutation and raw references', () => {
    const element = raw({ token: SECRET });
    const source: unknown[] = [element];
    const out = map(QUOTE, source);
    element.total = '9999.99';
    element.id = 'mutated';
    source.push(raw({ id: 'later' }));
    expect(out).toEqual(quoted([rate]));
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('strips extra keys and sentinels from the envelope and rates', () => {
    const out = map(QUOTE, [
      raw({
        token: SECRET,
        authorization: SECRET,
        body: { token: SECRET },
        fees: SECRET,
      }),
    ]);
    if (out.kind !== 'quoted') throw new Error('expected a quoted result');
    expect(Object.keys(out).sort().join()).toBe('expiresAt,kind,quoteId,rates');
    expect(Object.keys(out.rates[0]).sort().join()).toBe(
      'carrierName,currency,estimatedDeliveryDays,priceCents,rateId,serviceName,validUntil',
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('triangulates holes, frozen inputs, foreign elements, and id bounds', () => {
    const headerHole: unknown[] = [];
    headerHole[1] = raw();
    expect(map(QUOTE, headerHole)).toEqual(malformed);
    expect(map(QUOTE, Object.freeze([raw()]))).toEqual(quoted([rate]));
    class Foreign {
      marker = true;
    }
    expect(ids(map(QUOTE, [new Foreign(), raw()]))).toEqual(['rate-1']);
    const longId = 'q'.repeat(128);
    const long = map(longId, [raw()]);
    if (long.kind !== 'quoted') throw new Error('expected a quoted result');
    expect(long.quoteId).toBe(longId);
  });

  it('does not mutate the input array', () => {
    const source = [raw()];
    const snapshot = JSON.stringify(source);
    expect(map(QUOTE, source)).toEqual(quoted([rate]));
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it.each([null, undefined, 42, 'rates', {}, [], new Date(), () => 1])(
    'never throws and returns a finite envelope for %p',
    (value) => {
      expect(() => map(QUOTE, value)).not.toThrow();
      expect([noRates, malformed]).toContainEqual(map(QUOTE, value));
    },
  );
});
