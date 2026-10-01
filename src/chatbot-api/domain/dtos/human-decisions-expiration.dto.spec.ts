import { normalizeExpirationIntake } from './human-decisions-expiration.dto';

type Rec = Record<string, unknown>;

const U = {
  source: '11111111-1111-4111-8111-111111111111',
  product: '22222222-2222-4222-8222-222222222222',
  variant: '33333333-3333-4333-8333-333333333333',
};
const NIL = '00000000-0000-0000-0000-000000000000';

const omit = (o: Rec, k: string): Rec => {
  const copy = { ...o };
  delete copy[k];
  return copy;
};

const intake = (extra: Rec = {}): Rec => ({
  sourceRequestId: U.source,
  type: 'EXPIRATION',
  productId: U.product,
  variantId: null,
  ...extra,
});

describe('normalizeExpirationIntake', () => {
  it('normalizes a simple product with an explicit null variantId', () => {
    expect(normalizeExpirationIntake(intake())).toEqual({
      sourceRequestId: U.source,
      type: 'EXPIRATION',
      productId: U.product,
      variantId: null,
    });
  });

  it('normalizes a variant product with an explicit variantId', () => {
    expect(normalizeExpirationIntake(intake({ variantId: U.variant }))).toEqual(
      {
        sourceRequestId: U.source,
        type: 'EXPIRATION',
        productId: U.product,
        variantId: U.variant,
      },
    );
  });

  it('preserves UUID letter case exactly as received', () => {
    const lower = 'abcdef01-2345-4678-89ab-cdef01234567';
    const upper = lower.toUpperCase();
    expect(upper).not.toBe(lower);
    expect(
      normalizeExpirationIntake(intake({ productId: upper }))?.productId,
    ).toBe(upper);
  });

  it('rejects nil, wrong-version, wrong-variant and non-RFC UUIDs', () => {
    for (const productId of [
      NIL,
      '11111111-1111-0111-8111-111111111111',
      '11111111-1111-4111-c111-111111111111',
      'not-a-uuid',
    ]) {
      expect(normalizeExpirationIntake(intake({ productId }))).toBeNull();
    }
  });

  it.each<[string, unknown]>([
    ['missing sourceRequestId', omit(intake(), 'sourceRequestId')],
    ['missing type', omit(intake(), 'type')],
    ['wrong type', intake({ type: 'RESTOCK' })],
    ['non-string type', intake({ type: 1 })],
    ['missing productId', omit(intake(), 'productId')],
    ['missing variantId', omit(intake(), 'variantId')],
    ['undefined sourceRequestId', intake({ sourceRequestId: undefined })],
    ['undefined variantId', intake({ variantId: undefined })],
    ['non-uuid sourceRequestId', intake({ sourceRequestId: 'x' })],
    ['non-uuid variantId', intake({ variantId: 'x' })],
    ['extra tenantId', intake({ tenantId: U.source })],
    ['extra metadata', intake({ metadata: {} })],
    ['extra productName', intake({ productName: 'X' })],
    ['symbol key', { ...intake(), [Symbol('x')]: 1 }],
    ['null input', null],
    ['string input', 'nope'],
    ['number input', 7],
    ['array input', []],
  ])('rejects %s', (_label, input) => {
    expect(normalizeExpirationIntake(input)).toBeNull();
  });

  it('fails closed when a property read throws', () => {
    const hostile = intake();
    Object.defineProperty(hostile, 'productId', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(normalizeExpirationIntake(hostile)).toBeNull();
  });
});
