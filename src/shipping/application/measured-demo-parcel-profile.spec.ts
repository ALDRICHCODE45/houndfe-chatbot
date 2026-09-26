import {
  MAX_MEASURED_DEMO_PROFILE_ITEM_LINES as MAX,
  matchMeasuredDemoParcelProfile as match,
  normalizeMeasuredDemoParcelProfile as norm,
  type MeasuredDemoPreparedItem,
} from './measured-demo-parcel-profile';

type Rec = Record<string, unknown>;
const SECRET = 'svc_secret_value';
const P = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const V = '33333333-3333-3333-3333-333333333333';
const M: Rec = { weightGrams: 500, lengthCm: 10, widthCm: 20, heightCm: 30 };
// prettier-ignore
const mg = (x: Rec = {}): Rec => ({ ...M, ...x });
// prettier-ignore
const el = (x: Rec = {}): Rec => ({ productId: P, variantId: null, quantity: 1, measurement: mg(), ...x });
// prettier-ignore
const prof = (x: Rec = {}): Rec => ({ version: 1, items: [el()], parcel: mg({ weightGrams: 500 }), ...x });
// prettier-ignore
const prof2 = (items: unknown, w: unknown): Rec => ({ version: 1, items, parcel: mg({ weightGrams: w }) });
// prettier-ignore
const cl = (x: Rec = {}): Rec => ({ productId: P, variantId: null, quantity: 1, unitPriceCents: 1500, ...x });
// prettier-ignore
const pid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// prettier-ignore
const EXPECTED = { version: 1, items: [{ productId: P, variantId: null, quantity: 1, measurement: { ...M } }], parcel: { ...M } };
// prettier-ignore
const MATCHED = { items: [{ productId: P, variantId: null, quantity: 1, unitPriceCents: 1500, measurement: { ...M } }], parcels: [{ ...M }] };
// prettier-ignore
function boom(): never { throw new Error('x'); }
const T = new Proxy({}, { get: boom });
const rev = Proxy.revocable({}, {});
rev.revoke();
const REVOKED = rev.proxy;
// prettier-ignore
const exotic = (element: unknown): unknown => { const a: unknown[] = []; Object.setPrototypeOf(a, [element]); a.length = 1; return a; };
// prettier-ignore
const count = (target: Rec, log: Rec): Rec => new Proxy(target, { get: (t, k) => { const key = String(k); log[key] = ((log[key] as number) ?? 0) + 1; return t[String(k)]; } });
// prettier-ignore
const deepFrozen = (v: unknown): boolean => { if (typeof v !== 'object' || v === null) return true; if (!Object.isFrozen(v)) return false; return Object.values(v as Rec).every(deepFrozen); };
// prettier-ignore
const stateful = (t: Rec): Rec => { const seen: Rec = {}; return new Proxy(t, { get: (x, k) => { const key = String(k); const n = ((seen[key] as number) ?? 0) + 1; seen[key] = n; return n === 1 ? x[String(k)] : SECRET; } }); };
// prettier-ignore
const throws = (target: Rec, key: string): Rec => new Proxy(target, { get: (t, k) => { if (String(k) === key) throw new Error('x'); return t[String(k)]; } });

describe('SQ-5B1 normalizeMeasuredDemoParcelProfile', () => {
  it('normalizes the canonical profile to fresh deeply frozen exact-key values', () => {
    const source = prof();
    const out = norm(source);
    expect(out).toEqual(EXPECTED);
    expect(deepFrozen(out)).toBe(true);
    // prettier-ignore
    expect(Object.keys(out as unknown as Rec)).toEqual(['version', 'items', 'parcel']);
    // prettier-ignore
    expect(Object.keys(out!.items[0])).toEqual(['productId', 'variantId', 'quantity', 'measurement']);
    (source.items as Rec[])[0].quantity = 99;
    (source.parcel as Rec).weightGrams = 1;
    expect(out).toEqual(EXPECTED);
  });

  it('strips extras and secrets and reads each declared source property once', () => {
    const pLog: Rec = {};
    const iLog: Rec = {};
    const mLog: Rec = {};
    const xLog: Rec = {};
    // prettier-ignore
    const item = count({ productId: P, variantId: null, quantity: 1, measurement: count(mg(), mLog) }, iLog);
    // prettier-ignore
    const source = count({ version: 1, items: [item], parcel: count(mg({ weightGrams: 500 }), xLog) }, pLog);
    expect(norm(source)).toEqual(EXPECTED);
    expect(pLog).toEqual({ version: 1, items: 1, parcel: 1 });
    // prettier-ignore
    expect(iLog).toEqual({ productId: 1, variantId: 1, quantity: 1, measurement: 1 });
    // prettier-ignore
    expect(mLog).toEqual({ weightGrams: 1, lengthCm: 1, widthCm: 1, heightCm: 1 });
    // prettier-ignore
    expect(xLog).toEqual({ weightGrams: 1, lengthCm: 1, widthCm: 1, heightCm: 1 });
    // prettier-ignore
    const extra = prof({ extra: SECRET, items: [el({ secret: SECRET })], parcel: mg({ secret: SECRET }) });
    expect(JSON.stringify(norm(extra))).not.toContain(SECRET);
  });

  it('fails closed when re-reading a stateful getter could inject a secret', () => {
    // prettier-ignore
    const source = { version: 1, items: [stateful(el())], parcel: stateful(mg({ weightGrams: 500 })) };
    const out = norm(source);
    expect(out).toEqual(EXPECTED);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('exposes the 20-line bound', () => expect(MAX).toBe(20));
});

describe('SQ-5B1 profile rejection', () => {
  it.each([2, 0, '1', null, undefined, 1.5, true])(
    'rejects unknown version %#',
    (version) => expect(norm(prof({ version }))).toBeNull(),
  );

  // prettier-ignore
  it.each<[string, unknown]>([
    ['undefined', undefined], ['null', null], ['empty', []], ['string', 'x'], ['record', {}],
    ['non-record element', [42]], ['throwing element', [T]], ['revoked', REVOKED], ['exotic', exotic(el())],
    ['sparse', Object.assign([el()], { 2: el() })],
  ])('rejects %s items', (_l, items) => expect(norm(prof({ items }))).toBeNull());

  it('accepts 20 lines and rejects 21', () => {
    // prettier-ignore
    const lines = (n: number): Rec[] => Array.from({ length: n }, (_, i) => el({ productId: pid(i) }));
    expect(norm(prof2(lines(20), 10_000))).not.toBeNull();
    expect(norm(prof2(lines(21), 10_500))).toBeNull();
  });

  it('rejects duplicate productId+variantId lines', () => {
    expect(norm(prof2([el(), el()], 1_000))).toBeNull();
    expect(norm(prof2([el(), el({ quantity: 2 })], 1_500))).toBeNull();
    // prettier-ignore
    expect(norm(prof2([el({ variantId: V }), el({ variantId: V.toUpperCase() })], 1_000))).toBeNull();
    expect(norm(prof2([el(), el({ variantId: V })], 1_000))).not.toBeNull();
  });

  // prettier-ignore
  it.each([undefined, null, 'x', '', 123, `${P}\n`])('rejects invalid productId %#', (productId) => expect(norm(prof({ items: [el({ productId })] }))).toBeNull());
  // prettier-ignore
  it.each(['x', '', 123, `${V}\n`])('rejects invalid variantId %#', (variantId) => expect(norm(prof({ items: [el({ variantId })] }))).toBeNull());
  // prettier-ignore
  it('normalizes uppercase UUIDs to canonical lowercase', () => expect(norm(prof({ items: [el({ productId: P.toUpperCase() })] }))!.items[0].productId).toBe(P));

  // prettier-ignore
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined])('rejects invalid quantity %#', (quantity) => expect(norm(prof({ items: [el({ quantity })] }))).toBeNull());
  // prettier-ignore
  it.each(['weightGrams', 'lengthCm', 'widthCm', 'heightCm'])('rejects invalid %s values', (field) => { for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) expect(norm(prof({ items: [el({ measurement: mg({ [field]: bad }) })] }))).toBeNull(); });
  // prettier-ignore
  it.each([0, -1, 1.5, NaN, Infinity, '1', null, undefined])('rejects invalid parcel measurement %#', (bad) => expect(norm(prof({ parcel: mg({ weightGrams: bad, lengthCm: bad }) }))).toBeNull());

  it('enforces parcel weight equal to the summed item weight', () => {
    expect(norm(prof({ parcel: mg({ weightGrams: 501 }) }))).toBeNull();
    expect(norm(prof2([el({ quantity: 2 })], 1_000))).not.toBeNull();
    expect(norm(prof2([el({ quantity: 2 })], 999))).toBeNull();
  });

  it('accepts exactly the 25kg readiness cap and rejects above it', () => {
    expect(norm(prof2([el({ quantity: 50 })], 25_000))).not.toBeNull();
    expect(norm(prof2([el({ quantity: 51 })], 25_500))).toBeNull();
  });

  // prettier-ignore
  it('fails closed on arithmetic overflow', () => expect(norm(prof2([el({ quantity: Number.MAX_SAFE_INTEGER })], Number.MAX_SAFE_INTEGER))).toBeNull());

  // prettier-ignore
  it.each<[string, unknown]>([['undefined', undefined], ['null', null], ['string', 'x'], ['number', 42], ['function', () => undefined], ['class', new (class {})()], ['revoked', REVOKED], ['throwing', T]])('returns null without throwing for a %s profile', (_l, v) => { expect(() => norm(v)).not.toThrow(); expect(norm(v)).toBeNull(); });
  // prettier-ignore
  it.each(['version', 'items', 'parcel'])('returns null when the %s property throws', (key) => expect(norm(throws(prof(), key))).toBeNull());
  // prettier-ignore
  it.each(['productId', 'variantId', 'quantity', 'measurement'])('returns null when item %s throws', (key) => expect(norm(prof({ items: [throws(el(), key)] }))).toBeNull());
  // prettier-ignore
  it('returns null when prototype access throws', () => expect(norm(new Proxy({}, { getPrototypeOf: boom }))).toBeNull());
});

describe('SQ-5B1 matchMeasuredDemoParcelProfile', () => {
  it('matches an identical cart and returns profile-ordered frozen prepared input', () => {
    const out = match(prof(), [cl()]);
    expect(out).toEqual(MATCHED);
    expect(deepFrozen(out)).toBe(true);
    // prettier-ignore
    expect(Object.keys(out as unknown as Rec)).toEqual(['items', 'parcels']);
    // prettier-ignore
    expect(Object.keys(out!.items[0])).toEqual(['productId', 'variantId', 'quantity', 'unitPriceCents', 'measurement']);
  });

  it('matches a reordered cart, preserves profile order, and copies cart prices', () => {
    const profile = prof2([el({ productId: P }), el({ productId: P2 })], 1_000);
    // prettier-ignore
    const out = match(profile, [cl({ productId: P2, unitPriceCents: 200 }), cl({ productId: P, unitPriceCents: 100 })]);
    // prettier-ignore
    expect(out!.items.map((i: MeasuredDemoPreparedItem) => [i.productId, i.unitPriceCents])).toEqual([[P, 100], [P2, 200]]);
  });

  it('normalizes an absent variantId, ignores extras, and reads each cart property once', () => {
    const log: Rec = {};
    // prettier-ignore
    const out = match(prof(), [count({ ...cl(), variantId: undefined, extra: SECRET, measurement: SECRET }, log)]);
    expect(out).toEqual(MATCHED);
    // prettier-ignore
    expect(log).toEqual({ productId: 1, variantId: 1, quantity: 1, unitPriceCents: 1 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('matches exact normalized variantIds case-insensitively', () => {
    // prettier-ignore
    const out = match(prof2([el({ productId: P, variantId: V })], 500), [cl({ productId: P.toUpperCase(), variantId: V.toUpperCase() })]);
    expect(out!.items[0].productId).toBe(P);
    expect(out!.items[0].variantId).toBe(V);
    expect(
      match(prof2([el({ variantId: V })], 500), [cl({ variantId: null })]),
    ).toBeNull();
  });

  it('ignores unit price in identity but copies the matching line price', () =>
    // prettier-ignore
    expect(match(prof(), [cl({ unitPriceCents: 0 })])!.items[0].unitPriceCents).toBe(0));

  it('never accepts a subset, superset, quantity change, variant change, or weight-only match', () => {
    const two = prof2([el(), el({ productId: P2 })], 1_000);
    expect(match(two, [cl()])).toBeNull();
    expect(match(prof(), [cl(), cl({ productId: P2 })])).toBeNull();
    expect(match(two, [cl(), cl({ productId: P2, quantity: 2 })])).toBeNull();
    expect(match(two, [cl(), cl({ productId: V })])).toBeNull();
    expect(match(two, [cl(), cl({ productId: P2, variantId: V })])).toBeNull();
    // prettier-ignore
    expect(match(prof2([el({ productId: P, quantity: 2 })], 1_000), [cl({ productId: P2, quantity: 2 })])).toBeNull();
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['undefined', undefined], ['null', null], ['empty', []], ['string', 'x'], ['record', {}],
    ['missing cents', [cl({ unitPriceCents: undefined })]], ['negative cents', [cl({ unitPriceCents: -1 })]],
    ['fraction cents', [cl({ unitPriceCents: 1.5 })]], ['NaN cents', [cl({ unitPriceCents: NaN })]],
    ['unsafe cents', [cl({ unitPriceCents: Number.MAX_SAFE_INTEGER + 1 })]], ['string cents', [cl({ unitPriceCents: '1' })]],
    ['zero quantity', [cl({ quantity: 0 })]], ['bad product', [cl({ productId: 'x' })]], ['bad variant', [cl({ variantId: 'x' })]],
    ['duplicate lines', [cl(), cl()]], ['non-record line', [42]], ['throwing line', [T]], ['revoked', REVOKED],
    ['sparse', Object.assign([cl()], { 2: cl() })], ['exotic', exotic(cl())],
  ])('rejects %s cart input', (_l, cartValue) => expect(match(prof(), cartValue)).toBeNull());

  it('fails closed without throwing on a hostile cart', () => {
    const hostile = new Proxy([cl()], { get: boom });
    expect(() => match(prof(), hostile)).not.toThrow();
    expect(match(prof(), hostile)).toBeNull();
  });

  it('returns null when the profile is invalid and never touches the cart', () => {
    const log: Rec = {};
    expect(match(prof({ version: 2 }), [count(cl(), log)])).toBeNull();
    expect(match(null, [cl()])).toBeNull();
    expect(log).toEqual({});
  });
});
