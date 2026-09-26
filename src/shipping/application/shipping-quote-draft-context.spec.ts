import {
  SHIPPING_QUOTE_DRAFT_CONTEXT_VERSION as VERSION,
  buildShippingQuoteDraftContext as build,
  compareShippingQuoteDraftContext as compare,
  normalizeShippingQuoteDraftContext as norm,
} from './shipping-quote-draft-context';

type Rec = Record<string, unknown>;
const ISO = '2026-06-22T12:00:00.000Z';
const CUST = '11111111-1111-1111-1111-111111111111';
const ADDR = '22222222-2222-2222-2222-222222222222';
const P = '33333333-3333-3333-3333-333333333333';
const P2 = '44444444-4444-4444-4444-444444444444';
const V = '55555555-5555-5555-5555-555555555555';
const DEST: Rec = {
  zipCode: '06700',
  state: 'CDMX',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};

function line(overrides: Rec = {}): Rec {
  return {
    productId: P,
    variantId: null,
    quantity: 1,
    unitPriceCents: 1500,
    ...overrides,
  };
}

function fields(overrides: Rec = {}): Rec {
  return {
    customerId: CUST,
    shippingAddressId: ADDR,
    cart: [line()],
    destination: { ...DEST },
    ...overrides,
  };
}

function deepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Rec).every(deepFrozen);
}

describe('SQ-5E1a buildShippingQuoteDraftContext', () => {
  it('builds a fresh exact-key deeply frozen version-1 context and canonicalizes UUID case', () => {
    const out = build(fields(), ISO);
    expect(out).toEqual({
      schemaVersion: VERSION,
      draftCreatedAt: ISO,
      customerId: CUST,
      shippingAddressId: ADDR,
      cart: [line()],
      destination: { ...DEST },
    });
    expect(deepFrozen(out)).toBe(true);
    expect(Object.keys(out as unknown as Rec)).toEqual([
      'schemaVersion',
      'draftCreatedAt',
      'customerId',
      'shippingAddressId',
      'cart',
      'destination',
    ]);
    const upper = fields({
      customerId: CUST.toUpperCase(),
      shippingAddressId: ADDR.toUpperCase(),
    });
    expect(build(upper, ISO)).toEqual(out);
  });
});

describe('SQ-5E1a normalizeShippingQuoteDraftContext', () => {
  it('round-trips a built context to fresh deeply frozen values', () => {
    const built = build(fields(), ISO);
    const out = norm(built);
    expect(out).toEqual(built);
    expect(out).not.toBe(built);
    expect(deepFrozen(out)).toBe(true);
  });
});

describe('SQ-5E1a compareShippingQuoteDraftContext', () => {
  it('matches identical contexts and safe cart reorders only', () => {
    const two = [
      line({ productId: P }),
      line({ productId: P2, variantId: V, quantity: 2, unitPriceCents: 900 }),
    ];
    const a = build(fields({ cart: two }), ISO);
    const b = build(fields({ cart: [...two].reverse() }), ISO);
    expect(compare(a, b)).toBe(true);
    expect(compare(norm(a), a)).toBe(true);
  });
});
