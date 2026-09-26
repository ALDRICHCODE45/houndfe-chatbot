import {
  MAX_SHIPPING_QUOTE_PARCELS,
  assembleShippingQuoteRequest as run,
} from './shipping-quote-input';

type Rec = Record<string, unknown>;
const S = 'svc_secret';
const K = 'manual_packing_required';
const BIG = Math.floor(Number.MAX_SAFE_INTEGER / 500) + 1;
const M: Rec = { weightGrams: 500, lengthCm: 1, widthCm: 1, heightCm: 1 };
const O = { postalCode: '1', state: 'S', municipality: 'M', neighborhood: 'N' };
const D = { zipCode: '2', state: 'T', municipality: 'U', neighborhood: 'V' };
const B: Rec = { lengthCm: 1, widthCm: 1, heightCm: 1, weightGrams: 500 };
const mg = (x: Rec = {}): Rec => ({ ...M, ...x });
// prettier-ignore
const el = (x: Rec = {}): Rec => ({ productId: 'p', quantity: 1, measurement: M, ...x });
const bx = (x: Rec = {}): Rec => ({ ...B, ...x });
const O1 = (x: Rec): Rec => ({ origin: { ...O, ...x } });
const D1 = (x: Rec): Rec => ({ destination: { ...D, ...x } });
const I = (x: unknown): Rec => ({ items: x });
const P = (x: unknown): Rec => ({ parcels: x });
// prettier-ignore
const base = (x: Rec = {}): Rec => ({ origin: { ...O }, destination: { ...D }, items: [el()], parcels: [bx()], ...x });
// prettier-ignore
const heavy = (n: number): Rec => ({ items: [el({ quantity: n, measurement: mg({ weightGrams: 5000 }) })] });
// prettier-ignore
function boom(): never { throw new Error('x'); }
const T = new Proxy({}, { get: boom });
const NR: unknown[] = [undefined, null, [], () => undefined, new (class {})()];
const rev = Proxy.revocable({}, {});
rev.revoke();
const REVOKED = rev.proxy;
// prettier-ignore
const exotic = (element: unknown): unknown => { const a: unknown[] = []; Object.setPrototypeOf(a, [element]); a.length = 1; return a; };
// prettier-ignore
const staged = (keys: Rec, boomKey: string, log: Rec): Rec => new Proxy(keys, { get: (t, k) => { const key = String(k); log[key] = ((log[key] as number) ?? 0) + 1; if (key === boomKey) throw new Error('x'); return t[key]; } });
const U = (r: string): Rec => ({ kind: 'unavailable', reason: r });
const MPR = (n: number): Rec => ({ kind: K, minimumPackageCount: n });
const eq = (v: unknown, e: unknown): void => expect(run(v)).toEqual(e);
const un = (x: Rec, r: string): void => eq(base(x), U(r));
// prettier-ignore
const ok = (v: unknown) => { const out = run(v); if (out.kind !== 'ready') throw new Error(out.kind); return out.request; };

describe('SQ-4B ready assembly', () => {
  // prettier-ignore
  it('assembles the canonical MX request and maps zipCode to postalCode', () => {
    expect(ok(base())).toEqual({
      origin: { ...O, countryCode: 'MX' },
      destination: { countryCode: 'MX', postalCode: '2', state: 'T', municipality: 'U', neighborhood: 'V' },
      parcels: [{ ...B }],
    });
  });
  it('accepts a multi-unit cart under 25kg via one prepared parcel', () => {
    const req = ok(
      base({
        items: [el({ quantity: 3, measurement: mg({ weightGrams: 5000 }) })],
        parcels: [bx({ weightGrams: 15_000 })],
      }),
    );
    expect(req.parcels).toEqual([bx({ weightGrams: 15_000 })]);
  });
  it('exposes the parcel bound', () =>
    expect(MAX_SHIPPING_QUOTE_PARCELS).toBe(20));
});

describe('SQ-4B finite failure reasons', () => {
  // prettier-ignore
  it.each<[Rec, string]>([
    [{ origin: {}, destination: {}, items: 'x' }, 'invalid_origin'], [{ destination: {}, items: 'x' }, 'invalid_destination'],
    [{ origin: {} }, 'invalid_origin'], [O1({ state: ' S' }), 'invalid_origin'],
    [{ destination: {} }, 'invalid_destination'], [D1({ state: 'T ' }), 'invalid_destination'],
    [D1({ zipCode: '' }), 'invalid_destination'], [D1({ municipality: null, city: 'B' }), 'invalid_destination'],
    [O1({ municipality: null, city: 'A' }), 'invalid_origin'], [I(undefined), 'invalid_items'],
    [I({}), 'invalid_items'], [I([]), 'invalid_items'],
    [I(Object.assign([el()], { 2: el() })), 'invalid_items'], [I(Array.from({ length: 101 }, () => el())), 'invalid_items'],
    [I([{}]), 'invalid_items'], [I([42]), 'invalid_items'],
    [I(REVOKED), 'invalid_items'], [I([T]), 'invalid_items'],
    [I(exotic(el())), 'invalid_items'], [P(exotic(bx())), 'packing_required'],
    [I([el({ measurement: [] })]), 'missing_measurements'], [I([el({ measurement: mg({ weightGrams: null }) })]), 'missing_measurements'],
    [I([el({ measurement: mg({ lengthCm: null }) })]), 'missing_measurements'], [I([el({ measurement: mg({ widthCm: null }) })]), 'missing_measurements'],
    [I([el({ measurement: mg({ heightCm: null }) })]), 'missing_measurements'], [I([el({ measurement: null })]), 'missing_measurements'],
    [I([el({ quantity: 0 })]), 'missing_measurements'], [I([el({ quantity: 1.5 })]), 'missing_measurements'],
    [I([el({ quantity: BIG })]), 'overflow'], [P(undefined), 'packing_required'],
    [P([]), 'packing_required'], [P('x'), 'packing_required'],
    [P([{}]), 'packing_required'], [P(Object.assign([bx()], { 2: bx() })), 'packing_required'],
    [P(REVOKED), 'packing_required'], [P([T]), 'packing_required'],
    [P([bx({ weightGrams: 501 })]), 'packing_required'], [P(Array.from({ length: 21 }, () => ({}))), 'parcel_limit_exceeded'],
  ])('maps case %# to a finite outcome', (over, reason) => un(over, reason));
  it('requires manual packing above 25kg and never inspects malformed parcels', () => {
    eq(base({ ...heavy(6), parcels: { nope: true } }), MPR(2));
    eq(base({ ...heavy(12), parcels: null }), MPR(3));
    eq(base(P([bx(), bx()])), MPR(1));
    eq(base(P(Array.from({ length: 20 }, () => bx()))), MPR(1));
  });
});

describe('SQ-4B lazy stage reads', () => {
  it('reads a later category only when its stage is reached', () => {
    const a: Rec = {};
    const b: Rec = {};
    const c: Rec = {};
    eq(staged(base({ origin: {} }), 'destination', a), U('invalid_origin'));
    eq(staged(base({ destination: {} }), 'items', b), U('invalid_destination'));
    eq(staged(base(heavy(6)), 'parcels', c), MPR(2));
    // prettier-ignore
    expect([a.destination, b.items, c.parcels]).toEqual([undefined, undefined, undefined]);
  });
});

describe('SQ-4B finite and hostile input handling', () => {
  it.each([...NR, REVOKED])('maps %# to invalid_input', (v) =>
    eq(v, U('invalid_input')),
  );
  it('never throws for hostile nested input and maps stage-local proxies', () => {
    for (const v of [REVOKED, T, I([T]), P([T])])
      expect(() => run(v)).not.toThrow();
    // A plain-record proxy whose first read throws is a stage-local origin value.
    eq(T, U('invalid_origin'));
  });
});

describe('SQ-4B output safety', () => {
  it('returns exact, fresh, deeply frozen, reference-free output', () => {
    const source = base();
    const req = ok(source);
    const keys = (o: object): string => Object.keys(o).sort().join();
    const A = 'countryCode,municipality,neighborhood,postalCode,state';
    expect(keys(run(source) as object)).toBe('kind,request');
    expect(keys(req)).toBe('destination,origin,parcels');
    expect(keys(req.origin)).toBe(A);
    expect(keys(req.parcels[0])).toBe('heightCm,lengthCm,weightGrams,widthCm');
    // prettier-ignore
    expect([run(source), req, req.origin, req.destination, req.parcels, req.parcels[0]].every(Object.isFrozen)).toBe(true);
    expect(req.origin).not.toBe(source.origin);
    expect(req.parcels[0]).not.toBe((source.parcels as Rec[])[0]);
    expect(run(source)).not.toBe(run(source));
  });
  it('strips sensitive and unrelated address fields', () => {
    const req = ok(
      base({
        origin: { ...O, id: S, city: S, token: S },
        destination: { ...D, city: 'Ignored', street: S },
        items: [el({ unitCostCents: 1, secret: S })],
        parcels: [bx({ reference: S })],
      }),
    );
    expect(JSON.stringify(req)).not.toContain(S);
    expect(JSON.stringify(req)).not.toContain('Ignored');
    expect(req.destination.municipality).toBe('U');
  });
  it('reads each declared field once', () => {
    const logs: Rec[] = [];
    const spy = (obj: Rec): Rec => {
      const log: Rec = {};
      logs.push(log);
      return staged(obj, '', log);
    };
    const source = spy({
      origin: spy({ ...O }),
      destination: spy({ ...D }),
      items: [spy({ productId: 'p', quantity: 1, measurement: spy({ ...M }) })],
      parcels: [spy({ ...B })],
    });
    ok(source);
    expect(logs.every((l) => Object.values(l).every((v) => v === 1))).toBe(
      true,
    );
  });
  it('resists source and post-return mutation', () => {
    const source = base();
    const req = ok(source);
    const before = JSON.stringify(req);
    (source.origin as Rec).postalCode = '9';
    (source.parcels as Rec[])[0].weightGrams = 1;
    expect(Reflect.set(req, 'origin', null)).toBe(false);
    expect(Reflect.set(req.parcels[0], 'weightGrams', 1)).toBe(false);
    expect(JSON.stringify(req)).toBe(before);
  });
});
