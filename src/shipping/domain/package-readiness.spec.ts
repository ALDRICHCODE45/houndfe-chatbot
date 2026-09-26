import {
  PACKAGE_MAX_TOTAL_WEIGHT_GRAMS as MAX_GRAMS,
  assessPackageReadiness,
  type PackageReadinessItemInput,
} from './package-readiness';

const MAX = Number.MAX_SAFE_INTEGER;
const measured = { weightGrams: 500, lengthCm: 10, widthCm: 10, heightCm: 10 };
const item = (
  over: Partial<PackageReadinessItemInput> = {},
): PackageReadinessItemInput => ({
  productId: 'p1',
  quantity: 1,
  measurement: { ...measured },
  ...over,
});
const withWeight = (weightGrams: number, quantity = 1) =>
  item({ quantity, measurement: { ...measured, weightGrams } });
const assess = (items: PackageReadinessItemInput[]) =>
  assessPackageReadiness({ items });
const single = (over: object = {}) => ({
  kind: 'single_package_candidate' as const,
  totalWeightGrams: 0,
  totalUnits: 1,
  readiness: 'candidate_only' as const,
  ...over,
});
const split = (over: object = {}) => ({
  kind: 'balanced_split_required' as const,
  totalWeightGrams: 0,
  totalUnits: 1,
  minimumPackageCount: 2,
  resolution: 'manual_unresolved' as const,
  ...over,
});
const unavailable = (
  missingFields: string[],
  variantId: string | null = null,
) => ({
  kind: 'unavailable' as const,
  items: [{ productId: 'p1', variantId, missingFields }],
});

/** SQ-1B contract tests for the pure package-readiness rule. */
describe('assessPackageReadiness', () => {
  it('marks fully measured carts as a single-package candidate', () => {
    expect(assess([item({ quantity: 2 })])).toEqual(
      single({ totalWeightGrams: 1_000, totalUnits: 2 }),
    );
  });

  it('multiplies line weight by quantity', () => {
    expect(
      assess([
        withWeight(400, 3),
        item({
          productId: 'p2',
          quantity: 2,
          measurement: { ...measured, weightGrams: 250 },
        }),
      ]),
    ).toEqual(single({ totalWeightGrams: 1_700, totalUnits: 5 }));
  });

  it.each([
    [MAX_GRAMS, single({ totalWeightGrams: MAX_GRAMS })],
    [MAX_GRAMS + 1, split({ totalWeightGrams: MAX_GRAMS + 1 })],
    [MAX_GRAMS * 2, split({ totalWeightGrams: MAX_GRAMS * 2 })],
    [
      MAX_GRAMS * 2 + 1,
      split({ totalWeightGrams: MAX_GRAMS * 2 + 1, minimumPackageCount: 3 }),
    ],
    [
      MAX_GRAMS * 3,
      split({ totalWeightGrams: MAX_GRAMS * 3, minimumPackageCount: 3 }),
    ],
    [
      MAX_GRAMS * 3 + 1,
      split({ totalWeightGrams: MAX_GRAMS * 3 + 1, minimumPackageCount: 4 }),
    ],
    [
      MAX_GRAMS * 10,
      split({ totalWeightGrams: MAX_GRAMS * 10, minimumPackageCount: 10 }),
    ],
  ])('classifies %i grams at the 25 kg boundary', (weightGrams, expected) => {
    expect(assess([withWeight(weightGrams)])).toEqual(expected);
  });

  it.each(['weightGrams', 'lengthCm', 'widthCm', 'heightCm'] as const)(
    'reports a null %s as unavailable',
    (field) => {
      expect(
        assess([
          item({
            variantId: 'v1',
            measurement: { ...measured, [field]: null },
          }),
        ]),
      ).toEqual(unavailable([field], 'v1'));
    },
  );

  it('reports all measurement fields missing when measurement is absent', () => {
    expect(assess([item({ measurement: null })])).toEqual(
      unavailable(['weightGrams', 'lengthCm', 'widthCm', 'heightCm']),
    );
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1])(
    'reports an invalid weight %p as unavailable',
    (weightGrams) => {
      expect(assess([withWeight(weightGrams)])).toEqual(
        unavailable(['weightGrams']),
      );
    },
  );

  it.each(['lengthCm', 'widthCm', 'heightCm'] as const)(
    'reports an invalid %s as unavailable',
    (field) => {
      expect(
        assess([item({ measurement: { ...measured, [field]: 0 } })]),
      ).toEqual(unavailable([field]));
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    'reports an invalid quantity %p as unavailable',
    (quantity) => {
      expect(assess([item({ quantity })])).toEqual(unavailable(['quantity']));
    },
  );

  it('aggregates unusable lines without customer or address data', () => {
    const result = assess([
      item({ variantId: 'v1', measurement: { ...measured, lengthCm: null } }),
      item({ productId: 'p2', measurement: null }),
    ]);
    expect(result).toEqual({
      kind: 'unavailable',
      items: [
        { productId: 'p1', variantId: 'v1', missingFields: ['lengthCm'] },
        {
          productId: 'p2',
          variantId: null,
          missingFields: ['weightGrams', 'lengthCm', 'widthCm', 'heightCm'],
        },
      ],
    });
    if (result.kind === 'unavailable') {
      for (const entry of result.items) {
        expect(Object.keys(entry)).toEqual([
          'productId',
          'variantId',
          'missingFields',
        ]);
      }
    }
  });

  it('fails explicitly when a line or summed weight overflows', () => {
    const half = Math.floor(MAX / 2) + 1;
    expect(assess([withWeight(half, 2)])).toEqual({ kind: 'overflow' });
    expect(assess([withWeight(half), withWeight(half)])).toEqual({
      kind: 'overflow',
    });
  });
});
