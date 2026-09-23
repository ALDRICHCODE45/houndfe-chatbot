import {
  MAX_SHIPPING_QUOTE_DRAFT_CONTEXT_LINES as MAX,
  SHIPPING_QUOTE_DRAFT_CONTEXT_KEY as KEY,
  SHIPPING_QUOTE_DRAFT_CONTEXT_VERSION as VERSION,
  buildShippingQuoteDraftContext as build,
  compareShippingQuoteDraftContext as compare,
  normalizeShippingQuoteDraftContext as norm,
} from './shipping-quote-draft-context';

type Rec = Record<string, unknown>;
const ISO = '2026-06-22T12:00:00.000Z';
const ISO2 = '2026-06-22T12:30:00.000Z';
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

function rec(overrides: Rec = {}): Rec {
  return {
    schemaVersion: VERSION,
    draftCreatedAt: ISO,
    ...fields(),
    ...overrides,
  };
}

function pid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

function many(n: number): Rec[] {
  return Array.from({ length: n }, (_, index) =>
    line({ productId: pid(index + 1) }),
  );
}

function boom(): never {
  throw new Error('x');
}

function throws(target: Rec, key: string): Rec {
  return new Proxy(target, {
    get: (source, property) => {
      if (String(property) === key) throw new Error('x');
      return source[String(property)];
    },
  });
}

function baseCart(): Rec[] {
  return [
    line({ productId: P }),
    line({ productId: P2, variantId: V, quantity: 2, unitPriceCents: 900 }),
  ];
}

describe('SQ-5E1a buildShippingQuoteDraftContext boundaries', () => {
  it('bounds the cart to one through twenty lines and rejects empty, sparse, or duplicate lines', () => {
    expect(KEY).toBe('shippingQuoteDraftContext');
    expect(build(fields({ cart: many(MAX) }), ISO)).not.toBeNull();
    expect(build(fields({ cart: many(MAX + 1) }), ISO)).toBeNull();
    expect(build(fields({ cart: [] }), ISO)).toBeNull();
    const sparse = many(1);
    sparse[2] = line({ productId: P2 });
    expect(build(fields({ cart: sparse }), ISO)).toBeNull();
    expect(build(fields({ cart: [line(), line()] }), ISO)).toBeNull();
    const reorderedCase = [line({ productId: P.toUpperCase() }), line()];
    expect(build(fields({ cart: reorderedCase }), ISO)).toBeNull();
  });

  it('sorts the canonical cart by product then variant so reordered carts build equally', () => {
    const two = [
      line({ productId: P }),
      line({ productId: P2 }),
      line({ productId: P2, variantId: V, quantity: 2 }),
    ];
    const a = build(fields({ cart: two }), ISO);
    const b = build(fields({ cart: [...two].reverse() }), ISO);
    expect(a!.cart.map((entry) => [entry.productId, entry.variantId])).toEqual([
      [P, null],
      [P2, null],
      [P2, V],
    ]);
    expect(compare(a, b)).toBe(true);
  });

  it('rejects malformed cart lines, hostile getters, and non-plain containers', () => {
    const bad = [
      line({ quantity: 0 }),
      line({ quantity: -1 }),
      line({ quantity: 1.5 }),
      line({ quantity: Number.MAX_SAFE_INTEGER + 1 }),
      line({ quantity: '1' }),
      line({ unitPriceCents: -1 }),
      line({ unitPriceCents: 1.5 }),
      line({ unitPriceCents: Number.MAX_SAFE_INTEGER + 1 }),
      line({ productId: 'not-a-uuid' }),
      line({ variantId: 'nope' }),
      line({ extra: 'x' }),
    ];
    for (const one of bad) {
      expect(build(fields({ cart: [one] }), ISO)).toBeNull();
    }
    expect(build([], ISO)).toBeNull();
    expect(build(fields({ cart: [new Date()] }), ISO)).toBeNull();
    const hostileCart = [throws(line(), 'quantity')];
    expect(build(fields({ cart: hostileCart }), ISO)).toBeNull();
  });

  it('rejects malformed identity, destination, and record keys', () => {
    expect(build(fields({ customerId: 'x' }), ISO)).toBeNull();
    expect(build(fields({ shippingAddressId: null }), ISO)).toBeNull();
    const shortZip = { ...DEST, zipCode: '0670' };
    expect(build(fields({ destination: shortZip }), ISO)).toBeNull();
    const paddedState = { ...DEST, state: ' CDMX' };
    expect(build(fields({ destination: paddedState }), ISO)).toBeNull();
    const emptyNeighborhood = { ...DEST, neighborhood: '' };
    expect(build(fields({ destination: emptyNeighborhood }), ISO)).toBeNull();
    const withStreet = { ...DEST, street: 'Reforma 1' };
    expect(build(fields({ destination: withStreet }), ISO)).toBeNull();
    expect(build({ ...fields(), extra: 'x' }, ISO)).toBeNull();
    const missingAddress = {
      customerId: CUST,
      cart: [],
      destination: { ...DEST },
    };
    expect(build(missingAddress, ISO)).toBeNull();
    const hostile = new Proxy(fields(), { get: boom, getPrototypeOf: boom });
    expect(build(hostile, ISO)).toBeNull();
  });

  it('rejects inherited, accessor, non-enumerable, or symbol keys in place of required data keys', () => {
    const inherited = Object.create({ cart: [line()] }) as Rec;
    inherited.customerId = CUST;
    inherited.shippingAddressId = ADDR;
    inherited.destination = { ...DEST };
    inherited.extra = 'x';
    const spoofed = new Proxy(inherited, {
      getPrototypeOf: () => Object.prototype,
    });
    expect(build(spoofed, ISO)).toBeNull();

    const accessor: Rec = {
      customerId: CUST,
      shippingAddressId: ADDR,
      destination: { ...DEST },
    };
    Object.defineProperty(accessor, 'cart', {
      enumerable: true,
      get: () => [line()],
    });
    expect(build(accessor, ISO)).toBeNull();

    const nonEnumerable: Rec = {
      customerId: CUST,
      shippingAddressId: ADDR,
      destination: { ...DEST },
      extra: 'x',
    };
    Object.defineProperty(nonEnumerable, 'cart', {
      value: [line()],
      enumerable: false,
    });
    expect(build(nonEnumerable, ISO)).toBeNull();

    const withSymbol = fields();
    Object.defineProperty(withSymbol, Symbol('extra'), {
      value: 'x',
      enumerable: true,
    });
    expect(build(withSymbol, ISO)).toBeNull();
  });

  it('requires an exact canonical ISO draftCreatedAt', () => {
    expect(build(fields(), ISO)).not.toBeNull();
    const bad = [
      ISO.replace('Z', '+00:00'),
      '2026-06-22',
      '2026-06-22T12:00:00',
      ISO.slice(0, -1),
      ` ${ISO} `,
      1,
      null,
      new Date(ISO),
    ];
    for (const one of bad) expect(build(fields(), one)).toBeNull();
  });
});

describe('SQ-5E1a normalizeShippingQuoteDraftContext boundaries', () => {
  it('rejects wrong version, missing or extra keys, and legacy contextless shapes', () => {
    const missing = rec();
    delete missing.schemaVersion;
    const bad = [
      rec({ schemaVersion: 2 }),
      rec({ schemaVersion: '1' }),
      missing,
      rec({ extra: 'x' }),
      fields(),
      { schemaVersion: VERSION, ...fields() },
    ];
    for (const one of bad) expect(norm(one)).toBeNull();
  });

  it('rejects malformed timestamps and never throws on garbage JSONB', () => {
    const bad = [
      rec({ draftCreatedAt: '2026-06-22' }),
      rec({ draftCreatedAt: ISO.replace('Z', '+00:00') }),
      rec({ draftCreatedAt: ISO.slice(0, -1) }),
      rec({ draftCreatedAt: '2026-02-30T00:00:00.000Z' }),
    ];
    for (const one of bad) expect(norm(one)).toBeNull();
    const garbage = [
      null,
      undefined,
      42,
      'x',
      [],
      new Date(),
      new Proxy({}, { get: boom, getPrototypeOf: boom }),
    ];
    for (const one of garbage) expect(norm(one)).toBeNull();
  });
});

describe('SQ-5E1a compareShippingQuoteDraftContext boundaries', () => {
  it('rejects cart, identity, and destination drift without loose matches', () => {
    const base = (): unknown => build(fields({ cart: baseCart() }), ISO);
    const drift = [
      fields({ customerId: ADDR }),
      fields({ shippingAddressId: CUST }),
      fields({ destination: { ...DEST, zipCode: '06701' } }),
      fields({ destination: { ...DEST, state: 'cdmx' } }),
      fields({
        cart: [
          line({ productId: P }),
          line({
            productId: P2,
            variantId: V,
            quantity: 2,
            unitPriceCents: 901,
          }),
        ],
      }),
      fields({ cart: [...baseCart(), line({ productId: pid(9) })] }),
      fields({
        cart: [
          line({ productId: P }),
          line({ productId: P2, variantId: V, quantity: 2 }),
        ],
      }),
    ];
    for (const one of drift) {
      expect(compare(base(), build(one, ISO))).toBe(false);
    }
  });

  it('rejects when either side is malformed, absent, or legacy', () => {
    const base = (): unknown => build(fields(), ISO);
    expect(compare(null, null)).toBe(false);
    expect(compare(base(), null)).toBe(false);
    expect(compare(null, base())).toBe(false);
    expect(compare(base(), fields())).toBe(false);
    expect(compare(fields(), base())).toBe(false);
    expect(compare(base(), rec({ schemaVersion: 2 }))).toBe(false);
  });

  it('does not use the draft-created pin as a match key', () => {
    expect(compare(build(fields(), ISO), build(fields(), ISO2))).toBe(true);
  });
});
