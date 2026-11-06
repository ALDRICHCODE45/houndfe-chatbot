import { parseCartEvaluationResult } from './pricing.dto';

/** Real `POST /chatbot-api/pricing/evaluate-cart` shape with a phone sent. */
const evaluation = () => ({
  items: [
    {
      productId: '0b6f2c0e-6a8e-4f7e-9f3a-2d1f6b9c4e11',
      variantId: null,
      quantity: 2,
      unitPriceCents: 89900,
      originalPriceCents: 179800,
      finalPriceCents: 161820,
      appliedPromotionTitle: '10% croquetas',
      discountAmountCents: 17980,
    },
  ],
  promotionEvaluationStatus: 'fully_evaluated',
  customerResolution: 'unique',
});
type Evaluation = ReturnType<typeof evaluation>;
const omit = (body: object, key: string) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));
const withLine = (body: Evaluation, patch: Record<string, unknown>) => ({
  ...body,
  items: [{ ...body.items[0], ...patch }],
});

describe('parseCartEvaluationResult', () => {
  it('parses a real-shaped body with customerResolution', () => {
    expect(parseCartEvaluationResult(evaluation())).toEqual({
      value: evaluation(),
      unknownKeys: [],
    });
  });

  it.each(['unique', 'not_found', 'ambiguous', 'not_provided'])(
    'accepts customerResolution %s',
    (customerResolution) => {
      expect(
        parseCartEvaluationResult({ ...evaluation(), customerResolution })
          ?.value.customerResolution,
      ).toBe(customerResolution);
    },
  );

  it('accepts an older body without customerResolution', () => {
    const older = omit(evaluation(), 'customerResolution');
    const parsed = parseCartEvaluationResult(older);
    expect(parsed?.value).toEqual(older);
    expect(parsed?.value).not.toHaveProperty('customerResolution');
  });

  it('strips unknown keys and reports their paths', () => {
    const parsed = parseCartEvaluationResult({
      ...withLine(evaluation(), { promotionId: 'promo-1' }),
      priceListId: 'list-1',
    });
    expect(parsed?.value).toEqual(evaluation());
    expect(parsed?.unknownKeys.sort()).toEqual(
      ['items[].promotionId', 'priceListId'].sort(),
    );
  });

  it.each<[string, (body: Evaluation) => unknown]>([
    ['string body', () => 'ok'],
    ['items not an array', (body) => ({ ...body, items: {} })],
    ['missing items', (body) => omit(body, 'items')],
    [
      'unknown promotion status',
      (body) => ({ ...body, promotionEvaluationStatus: 'partial' }),
    ],
    [
      'unknown customerResolution',
      (body) => ({ ...body, customerResolution: 'multiple' }),
    ],
    [
      'null customerResolution',
      (body) => ({ ...body, customerResolution: null }),
    ],
    ['zero quantity', (body) => withLine(body, { quantity: 0 })],
    ['negative unit price', (body) => withLine(body, { unitPriceCents: -1 })],
    [
      'fractional final price',
      (body) => withLine(body, { finalPriceCents: 1.5 }),
    ],
    ['string discount', (body) => withLine(body, { discountAmountCents: '0' })],
    [
      'missing original price',
      (body) => withLine(body, { originalPriceCents: undefined }),
    ],
    ['numeric variantId', (body) => withLine(body, { variantId: 1 })],
    [
      'numeric promotion title',
      (body) => withLine(body, { appliedPromotionTitle: 1 }),
    ],
  ])('rejects %s', (_label, mutate) => {
    expect(parseCartEvaluationResult(mutate(evaluation()))).toBeNull();
  });
});
