import {
  SHIPPING_CREDIT_PER_QUALIFYING_UNIT_CENTS as CREDIT,
  SHIPPING_CREDIT_QUALIFYING_UNIT_PRICE_CENTS as THRESHOLD,
  calculateShippingCredit,
  type ShippingCreditLine,
} from './shipping-credit';

const MAX = Number.MAX_SAFE_INTEGER;
const line = (unitPriceCents: number, quantity = 1): ShippingCreditLine => ({
  unitPriceCents,
  quantity,
});
const calc = (bestRateCents: number, items: ShippingCreditLine[] = []) =>
  calculateShippingCredit({ bestRateCents, items });
const calculated = (over: object = {}) => ({
  kind: 'calculated' as const,
  bestRateCents: 0,
  totalCreditCents: 0,
  appliedCreditCents: 0,
  unusedCreditCents: 0,
  qualifyingUnitCount: 0,
  customerPaysCents: 0,
  ...over,
});

/** SQ-1 contract tests for the pure shipping-credit rule. */
describe('calculateShippingCredit', () => {
  it('qualifies only units strictly above $500', () => {
    expect(calc(0, [line(THRESHOLD)])).toEqual(calculated());
    expect(calc(0, [line(THRESHOLD + 1)])).toEqual(
      calculated({
        totalCreditCents: CREDIT,
        unusedCreditCents: CREDIT,
        qualifyingUnitCount: 1,
      }),
    );
  });

  it('multiplies by quantity and sums only qualifying units', () => {
    expect(
      calc(50_000, [line(THRESHOLD, 5), line(100_000, 2), line(THRESHOLD + 1)]),
    ).toEqual(
      calculated({
        bestRateCents: 50_000,
        totalCreditCents: 36_000,
        appliedCreditCents: 36_000,
        customerPaysCents: 14_000,
        qualifyingUnitCount: 3,
      }),
    );
  });

  it.each([
    [0, 0, CREDIT, 0],
    [10_000, 10_000, 2_000, 0],
    [CREDIT, CREDIT, 0, 0],
    [20_000, CREDIT, 0, 8_000],
    [100_000, CREDIT, 0, 88_000],
  ])(
    'applies credit at rate %i: %i applied / %i unused / %i payable',
    (
      bestRateCents,
      appliedCreditCents,
      unusedCreditCents,
      customerPaysCents,
    ) => {
      expect(calc(bestRateCents, [line(THRESHOLD + 1)])).toEqual(
        calculated({
          bestRateCents,
          totalCreditCents: CREDIT,
          appliedCreditCents,
          unusedCreditCents,
          qualifyingUnitCount: 1,
          customerPaysCents,
        }),
      );
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1])(
    'rejects an invalid best rate %p',
    (bestRateCents) =>
      expect(calc(bestRateCents)).toEqual({
        kind: 'invalid_input',
        field: 'bestRateCents',
        itemIndex: null,
      }),
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1])(
    'rejects an invalid unit price %p',
    (unitPriceCents) =>
      expect(calc(0, [line(unitPriceCents)])).toEqual({
        kind: 'invalid_input',
        field: 'unitPriceCents',
        itemIndex: 0,
      }),
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1])(
    'rejects an invalid quantity %p',
    (quantity) =>
      expect(calc(0, [line(THRESHOLD + 1, quantity)])).toEqual({
        kind: 'invalid_input',
        field: 'quantity',
        itemIndex: 0,
      }),
  );

  it('fails explicitly on single-line and accumulated credit overflow', () => {
    const overLine = Math.floor(MAX / CREDIT) + 1;
    const half = Math.floor(MAX / CREDIT / 2) + 1;
    expect(calc(0, [line(THRESHOLD + 1, overLine)])).toEqual({
      kind: 'overflow',
    });
    expect(
      calc(0, [line(THRESHOLD + 1, half), line(THRESHOLD + 1, half)]),
    ).toEqual({ kind: 'overflow' });
  });
});
