import type { ShippingQuoteRate } from '../domain/shipping-quote.result';
import {
  buildShippingQuoteDraft as build,
  selectBestEligibleRate as select,
  type ShippingQuoteDraft,
  type ShippingQuoteDraftOutcome,
} from './shipping-quote-draft';
type Rec = Record<string, unknown>;
const ISO = '2026-01-02T03:04:05.000Z';
const T = 50_000;
const C = 12_000;
const SECRET = 'svc_super_secret_token_value';
const RATE_KEYS =
  'rateId,carrierName,serviceName,priceCents,currency,estimatedDeliveryDays,validUntil';
const res = {
  quote: { kind: 'unavailable', reason: 'invalid_quote' },
  cart: { kind: 'unavailable', reason: 'invalid_cart' },
  overflow: { kind: 'handoff', reason: 'credit_overflow' },
};
const r = (over: Partial<ShippingQuoteRate> = {}): ShippingQuoteRate => ({
  rateId: 'rate-1',
  carrierName: 'Estafeta',
  serviceName: 'Dia Siguiente',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 2,
  validUntil: null,
  ...over,
});
const mk = (
  rateId: string,
  priceCents: number,
  estimatedDeliveryDays: number | null = 2,
  carrierName = 'carrier',
  serviceName = 'service',
): ShippingQuoteRate =>
  r({ rateId, priceCents, estimatedDeliveryDays, carrierName, serviceName });
const q = (rates: ShippingQuoteRate[], over: Rec = {}): Rec => ({
  kind: 'quoted',
  quoteId: 'quote-1',
  rates,
  expiresAt: ISO,
  ...over,
});
const l = (unitPriceCents: number, quantity = 1): Rec => ({
  unitPriceCents,
  quantity,
});
const draftOf = (outcome: ShippingQuoteDraftOutcome): ShippingQuoteDraft => {
  if (outcome.kind !== 'draft') throw new Error(outcome.kind);
  return outcome.draft;
};
describe('selectBestEligibleRate', () => {
  it.each<[ShippingQuoteRate[], string]>([
    [[mk('a', 2), mk('b', 1)], 'b'],
    [[mk('a', 1, 4), mk('b', 1, 1)], 'b'],
    [[mk('a', 1, null), mk('b', 1, 9)], 'b'],
    [[mk('a', 1, 2, 'alfa'), mk('b', 1, 2, 'Beta')], 'b'],
    [[mk('a', 1, 2, 'c', 'zeta'), mk('b', 1, 2, 'c', 'Alfa')], 'b'],
    [[mk('b', 1), mk('a', 1)], 'a'],
  ])('applies the total order regardless of order (%#)', (rates, expected) => {
    expect(select(rates)?.rateId).toBe(expected);
    expect(select([...rates].reverse())?.rateId).toBe(expected);
  });
  it('snapshots direct input: exact keys, no source ref, frozen', () => {
    const nested = { secret: SECRET };
    const extra = { token: SECRET, nested };
    const source = { ...r({ rateId: 'dup' }), ...extra } as ShippingQuoteRate;
    const result = select([source, r({ rateId: 'dup' })]);
    expect(result).toEqual(r({ rateId: 'dup' }));
    expect(Object.keys(result ?? {}).join()).toBe(RATE_KEYS);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result).not.toBe(source);
    expect(Object.isFrozen(result)).toBe(true);
    nested.secret = 'mutated';
    expect(JSON.stringify(result)).not.toContain('mutated');
  });
  it('reads each declared field once with no stateful secret leak', () => {
    const reads: Rec = {};
    const source: Rec = {};
    for (const [k, v] of Object.entries(r()) as [string, unknown][]) {
      Object.defineProperty(source, k, {
        get: () => {
          const next = ((reads[k] as number) ?? 0) + 1;
          reads[k] = next;
          return next === 1 ? v : SECRET;
        },
      });
    }
    const result = select([source, r()]);
    expect(result).toEqual(r());
    expect(Object.values(reads)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it('returns null and never throws for empty, bad-field, or hostile input', () => {
    expect(select([])).toBeNull();
    const bad = {
      ...r(),
      rateId: { secret: SECRET },
    } as unknown as ShippingQuoteRate;
    expect(select([bad])).toBeNull();
    const throwing = {
      get rateId(): never {
        throw new Error('boom');
      },
    };
    expect(select([throwing as unknown as ShippingQuoteRate])).toBeNull();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(select([proxy as ShippingQuoteRate])).toBeNull();
    const rates = [r({ rateId: 'z', priceCents: 20_000 }), r({ rateId: 'a' })];
    const snapshot = JSON.stringify(rates);
    select(rates);
    expect(JSON.stringify(rates)).toBe(snapshot);
  });
});
describe('buildShippingQuoteDraft credit composition', () => {
  it('delegates threshold strictness and quantity to the credit rule', () => {
    const at = draftOf(build(q([r({ priceCents: 9_000 })]), [l(T)]));
    expect(at.totalCreditCents).toBe(0);
    expect(at.customerPaysCents).toBe(9_000);
    const above = draftOf(build(q([r({ priceCents: 9_000 })]), [l(T + 1, 3)]));
    expect(above.totalCreditCents).toBe(C * 3);
    expect(above.qualifyingUnitCount).toBe(3);
  });
  it('copies the calculated credit fields exactly', () => {
    const draft = draftOf(
      build(q([r({ priceCents: 50_000 })]), [l(T, 5), l(100_000, 2), l(T + 1)]),
    );
    expect(draft).toMatchObject({
      quoteId: 'quote-1',
      providerExpiresAt: ISO,
      bestRateCents: 50_000,
      totalCreditCents: 36_000,
      appliedCreditCents: 36_000,
      unusedCreditCents: 0,
      qualifyingUnitCount: 3,
      customerPaysCents: 14_000,
    });
    expect(draft.selectedRate.priceCents).toBe(50_000);
  });
  it('floors customer payment at zero and reports unused or zero credit', () => {
    const draft = draftOf(build(q([r({ priceCents: 5_000 })]), [l(T + 1)]));
    expect(draft.appliedCreditCents).toBe(5_000);
    expect(draft.unusedCreditCents).toBe(C - 5_000);
    expect(draft.customerPaysCents).toBe(0);
    const zero = draftOf(build(q([r({ priceCents: 5_000 })]), [l(T, 4)]));
    expect(zero).toMatchObject({
      totalCreditCents: 0,
      appliedCreditCents: 0,
      unusedCreditCents: 0,
      qualifyingUnitCount: 0,
      customerPaysCents: 5_000,
    });
  });
});
describe('buildShippingQuoteDraft finite failures', () => {
  const validQuote = q([r()]);
  const validCart = [l(T + 1)];
  it.each([
    null,
    undefined,
    42,
    'quoted',
    [],
    {},
    { kind: 'error' },
    q([], { rates: [] }),
  ])('fails closed to invalid_quote for %p', (value) => {
    expect(build(value, validCart)).toEqual(res.quote);
  });
  it('fails closed for hostile quote and cart input', () => {
    const quoteGetter: Rec = {
      kind: 'quoted',
      quoteId: 'quote-1',
      expiresAt: ISO,
      get rates(): never {
        throw new Error('boom');
      },
    };
    const quoteProxy = Proxy.revocable({}, {});
    quoteProxy.revoke();
    expect(build(quoteGetter, validCart)).toEqual(res.quote);
    expect(build(quoteProxy.proxy, validCart)).toEqual(res.quote);
    const cartGetter = [
      {
        quantity: 1,
        get unitPriceCents(): never {
          throw new Error('boom');
        },
      },
    ];
    const cartProxy = Proxy.revocable([l(T + 1)], {});
    cartProxy.revoke();
    expect(build(validQuote, cartGetter)).toEqual(res.cart);
    expect(build(validQuote, cartProxy.proxy)).toEqual(res.cart);
  });
  it.each([
    ['non-array', {}],
    ['null', null],
    ['empty', []],
    ['over bound', Array.from({ length: 101 }, () => l(0))],
    ['sparse', Object.assign([l(T + 1)], { 2: l(T + 1) })],
    ['invalid price', [l(-1)]],
    ['fractional price', [l(1.5)]],
    ['invalid quantity', [l(T + 1, 0)]],
    ['missing field', [{ quantity: 1 }]],
  ])('fails closed to invalid_cart for %s', (_label, cart) => {
    expect(build(validQuote, cart)).toEqual(res.cart);
  });
  it('returns a finite handoff on credit overflow', () => {
    const quantity = Math.floor(Number.MAX_SAFE_INTEGER / C) + 1;
    expect(build(validQuote, [l(T + 1, quantity)])).toEqual(res.overflow);
  });
});
describe('buildShippingQuoteDraft output safety', () => {
  const sensitive = { token: SECRET, secret: SECRET, body: SECRET };
  it('strips sensitive fields, exposes exact keys, fresh and frozen', () => {
    const quotedValue = q([{ ...r(), ...sensitive }], {
      ...sensitive,
      expiresAt: ISO,
    });
    const cart = [{ ...l(T + 1), ...sensitive }];
    const outcome = build(quotedValue, cart);
    const draft = draftOf(outcome);
    expect(Object.keys(outcome).sort()).toEqual(['draft', 'kind']);
    expect(Object.keys(draft).sort().join()).toBe(
      'appliedCreditCents,bestRateCents,customerPaysCents,providerExpiresAt,qualifyingUnitCount,quoteId,selectedRate,totalCreditCents,unusedCreditCents',
    );
    expect(Object.keys(draft.selectedRate).join()).toBe(RATE_KEYS);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.selectedRate)).toBe(true);
    expect(build(quotedValue, cart)).not.toBe(outcome);
  });
  it('is unaffected by post-return mutation of every input', () => {
    const rates = [r({ rateId: 'a', priceCents: 9_000 })];
    const source = rates[0];
    const quotedValue = q(rates);
    const cart = [l(T + 1)];
    const draft = draftOf(build(quotedValue, cart));
    rates[0] = r({ rateId: 'z', priceCents: 999_999 });
    quotedValue.quoteId = 'mutated';
    quotedValue.expiresAt = null;
    Object.assign(cart[0], { unitPriceCents: 1 });
    expect(draft.selectedRate).not.toBe(source);
    expect(draft.quoteId).toBe('quote-1');
    expect(draft.providerExpiresAt).toBe(ISO);
    expect(draft.selectedRate.rateId).toBe('a');
    expect(draft.bestRateCents).toBe(9_000);
    expect(draft.totalCreditCents).toBe(C);
  });
});
