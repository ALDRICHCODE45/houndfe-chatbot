import {
  RESTOCK_MAX_PRODUCT_NAME_LENGTH,
  normalizeRestockIntake,
} from './human-decisions.dto';

type Rec = Record<string, unknown>;

const U = {
  source: '11111111-1111-4111-8111-111111111111',
  product: '22222222-2222-4222-8222-222222222222',
  variant: '33333333-3333-4333-8333-333333333333',
  supersedes: '44444444-4444-4444-8444-444444444444',
};

const omitted = (obj: Rec, key: string): Rec => {
  const copy = { ...obj };
  delete copy[key];
  return copy;
};

const intake = (extra: Rec = {}): Rec => ({
  sourceRequestId: U.source,
  type: 'RESTOCK',
  productId: U.product,
  productName: 'Croquetas Premium',
  ...extra,
});

const defined = (obj: Rec, key: string, value: unknown): Rec =>
  Object.defineProperty({ ...obj }, key, { value });
const accessor = (obj: Rec, key: string): Rec =>
  Object.defineProperty({ ...obj }, key, { get: () => 'x', enumerable: true });
const boom = (): never => {
  throw new Error('boom');
};
const throwingProxy = (target: Rec, trap: 'get' | 'ownKeys'): object =>
  new Proxy(target, { [trap]: boom });

class IntakeClass {
  sourceRequestId = U.source;
  type = 'RESTOCK';
  productId = U.product;
  productName = 'Croquetas Premium';
}

describe('normalizeRestockIntake', () => {
  it('fills every omitted nullable field with null', () => {
    expect(normalizeRestockIntake(intake())).toEqual({
      ...intake(),
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
      supersedesDecisionId: null,
    });
  });

  it('treats explicit null like omitted nullable fields', () => {
    const allNull = intake({
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
      supersedesDecisionId: null,
    });
    expect(normalizeRestockIntake(allNull)).toEqual(
      normalizeRestockIntake(intake()),
    );
  });

  it('canonicalizes a fully populated intake', () => {
    expect(
      normalizeRestockIntake(
        intake({
          variantId: U.variant,
          sku: '  SKU-9  ',
          requestedQuantity: 3,
          observedStockAtRequest: 0,
          stockObservedAt: '2026-06-22T10:30:00+02:00',
          supersedesDecisionId: U.supersedes,
        }),
      ),
    ).toEqual({
      sourceRequestId: U.source,
      type: 'RESTOCK',
      productId: U.product,
      productName: 'Croquetas Premium',
      variantId: U.variant,
      sku: 'SKU-9',
      requestedQuantity: 3,
      observedStockAtRequest: 0,
      stockObservedAt: '2026-06-22T08:30:00.000Z',
      supersedesDecisionId: U.supersedes,
    });
  });

  it('collapses productName whitespace', () => {
    const input = intake({ productName: '  Croquetas   Premium  ' });
    expect(normalizeRestockIntake(input)?.productName).toBe(
      'Croquetas Premium',
    );
  });

  it('normalizes sku and productName to NFC', () => {
    const n = normalizeRestockIntake(
      intake({ sku: 'Cafe\u0301', productName: 'Cafe\u0301' }),
    );
    expect([n?.sku, n?.productName]).toEqual(['Caf\u00e9', 'Caf\u00e9']);
  });

  it('normalizes a blank sku to null', () => {
    expect(normalizeRestockIntake(intake({ sku: '   ' }))?.sku).toBeNull();
  });

  it('accepts a productName at the bound and rejects one over it', () => {
    const at = 'a'.repeat(RESTOCK_MAX_PRODUCT_NAME_LENGTH);
    expect(
      normalizeRestockIntake(intake({ productName: at }))?.productName,
    ).toBe(at);
    expect(
      normalizeRestockIntake(intake({ productName: at + 'a' })),
    ).toBeNull();
  });

  const bad: Array<[string, unknown]> = [
    ['non-uuid sourceRequestId', intake({ sourceRequestId: 'x' })],
    ['missing sourceRequestId', omitted(intake(), 'sourceRequestId')],
    ['non-uuid productId', intake({ productId: 42 })],
    ['missing productId', omitted(intake(), 'productId')],
    ['wrong type', intake({ type: 'SHIPPING' })],
    ['missing type', omitted(intake(), 'type')],
    ['non-string productName', intake({ productName: 7 })],
    ['empty productName', intake({ productName: '' })],
    ['whitespace productName', intake({ productName: ' \t ' })],
    ['productName C0 control', intake({ productName: 'a\u001f' })],
    ['productName C1 control', intake({ productName: '\u007fb' })],
    ['productName edge tab', intake({ productName: 'Croquetas\t' })],
    ['non-uuid variantId', intake({ variantId: 'nope' })],
    ['non-string sku', intake({ sku: 5 })],
    ['sku C0 control', intake({ sku: 'a\u0000' })],
    ['sku C1 control', intake({ sku: '\u009fb' })],
    ['sku edge tab', intake({ sku: '\tSKU-9' })],
    ['zero requestedQuantity', intake({ requestedQuantity: 0 })],
    ['negative requestedQuantity', intake({ requestedQuantity: -1 })],
    ['fractional requestedQuantity', intake({ requestedQuantity: 2.5 })],
    ['string requestedQuantity', intake({ requestedQuantity: '2' })],
    ['negative stock tick', intake({ observedStockAtRequest: -1 })],
    ['fractional stock tick', intake({ observedStockAtRequest: 1.5 })],
    ['non-string stockObservedAt', intake({ stockObservedAt: 1719000000 })],
    ['unparseable instant', intake({ stockObservedAt: 'nope' })],
    ['malformed instant', intake({ stockObservedAt: '2026-13-40T99:99:99Z' })],
    ['date-only instant', intake({ stockObservedAt: '2026-06-22' })],
    ['tick without instant', intake({ observedStockAtRequest: 5 })],
    [
      'instant without tick',
      intake({ stockObservedAt: '2026-06-22T10:30:00Z' }),
    ],
    ['non-uuid supersedesDecisionId', intake({ supersedesDecisionId: 'x' })],
    ['extra tenantId', intake({ tenantId: U.source })],
    ['extra source', intake({ source: 'houndfe-chatbot' })],
    ['extra branchId', intake({ branchId: U.source })],
    ['extra credentialId', intake({ credentialId: U.source })],
    [
      'impossible Feb 30 offset',
      intake({
        observedStockAtRequest: 1,
        stockObservedAt: '2026-02-30T10:00:00+02:00',
      }),
    ],
    [
      'impossible Apr 31 offset',
      intake({
        observedStockAtRequest: 1,
        stockObservedAt: '2026-04-31T10:00:00-05:00',
      }),
    ],
    [
      'unsafe integer quantity',
      intake({ requestedQuantity: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      'unsafe integer stock tick',
      intake({
        observedStockAtRequest: 2 ** 60,
        stockObservedAt: '2026-06-22T10:30:00Z',
      }),
    ],
    ['symbol extra key', { ...intake(), [Symbol('tenantId')]: 1 }],
    ['non-enumerable extra key', defined(intake(), 'tenantId', 'x')],
    ['accessor property', accessor(intake(), 'sku')],
    ['class instance', new IntakeClass()],
    ['inherited object', Object.create(intake())],
    ['own __proto__ object', defined(intake(), '__proto__', { x: 1 })],
    ['own __proto__ primitive', defined(intake(), '__proto__', 1)],
    ['null input', null],
    ['string input', 'nope'],
    ['array input', []],
  ];

  it.each(bad)('rejects %s', (_label, input) => {
    expect(normalizeRestockIntake(input)).toBeNull();
  });

  it('fails closed on hostile getters and proxies', () => {
    const getter = intake();
    Object.defineProperty(getter, 'productName', {
      enumerable: true,
      get: boom,
    });
    expect(normalizeRestockIntake(getter)).toBeNull();
    const spoof = new Proxy(intake(), {
      get: (t, k) => (k === 'productId' ? U.variant : t[String(k)]),
    });
    expect(normalizeRestockIntake(spoof)).toBeNull();
    expect(normalizeRestockIntake(throwingProxy({}, 'ownKeys'))).toBeNull();
    expect(normalizeRestockIntake(throwingProxy(intake(), 'get'))).toBeNull();
  });
});
