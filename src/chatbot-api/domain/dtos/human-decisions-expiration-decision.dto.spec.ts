import { normalizeExpirationDecision } from './human-decisions-expiration-decision.dto';

type Rec = Record<string, unknown>;
const U = {
  id: 'a1bc2def-1111-4111-8111-111111111111',
  source: 'b2cd3ef0-2222-4222-8222-222222222222',
  product: 'c3de4f01-3333-4333-8333-333333333333',
  variant: 'd4ef5012-4444-4444-8444-444444444444',
};
const AT = '2026-06-23T08:00:00.000Z';
const BEFORE = '2026-06-24T08:00:00.000Z';
const NIL = '00000000-0000-0000-0000-000000000000';
const V0 = 'c3de4f01-3333-0333-8333-333333333333';
const VB = 'c3de4f01-3333-4333-0333-333333333333';

const omit = (o: Rec, k: string): Rec => {
  const c = { ...o };
  delete c[k];
  return c;
};
const boom = (): never => {
  throw new Error('boom');
};
const snap = (variant: boolean, extra: Rec = {}): Rec => ({
  branchId: 'sucursal-centro',
  branchName: 'Centro',
  productId: U.product,
  productName: 'Croquetas',
  unit: 'PZA',
  variantId: variant ? U.variant : null,
  variantName: variant ? 'Senior' : null,
  variantOption: variant ? 'Tamaño' : null,
  variantValue: variant ? '15 kg' : null,
  ...extra,
});
const decision = (s: Rec = snap(false), extra: Rec = {}): Rec => ({
  id: U.id,
  sourceRequestId: U.source,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-06-22T10:30:00.000Z',
  snapshot: s,
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...extra,
});
const provided = (extra: Rec = {}): Rec => ({
  action: 'PROVIDE_EXPIRATION_TEXT',
  expirationText: 'Vence 03/2027',
  resolvedAt: AT,
  ...extra,
});
const unavailable = (extra: Rec = {}): Rec => ({
  action: 'REPORT_EXPIRATION_UNAVAILABLE',
  resolvedAt: AT,
  ...extra,
});
const resolved = (r: unknown, s: Rec = snap(false), extra: Rec = {}): Rec => ({
  ...decision(s),
  status: 'RESOLVED',
  version: 2,
  resolution: r,
  applyBefore: BEFORE,
  ...extra,
});
const over = (extra: Rec): Rec => decision(undefined, extra);
const overRes = (extra: Rec, r: unknown = provided()): Rec =>
  resolved(r, undefined, extra);
const overSnap = (extra: Rec, variant = false): Rec =>
  decision(snap(variant, extra));
const norm = (v: unknown) => normalizeExpirationDecision(v);
const missing = (o: Rec, wrap: (o: Rec) => unknown): void =>
  Object.keys(o).forEach((k) => expect(norm(wrap(omit(o, k)))).toBeNull());

describe('normalizeExpirationDecision', () => {
  it('normalizes PENDING/resolved states and canonical values', () => {
    const far = resolved(
      provided({ resolvedAt: '+010000-01-01T00:00:00.000Z' }),
      undefined,
      {
        createdAt: '-000001-12-31T00:00:00.000Z',
        applyBefore: '+010000-01-02T00:00:00.000Z',
      },
    );
    for (const v of [
      decision(),
      decision(snap(true)),
      resolved(provided()),
      resolved(unavailable()),
      resolved(provided({ expirationText: 'Vence\u200b03/2027' })),
      resolved(provided({ expirationText: 'x'.repeat(500) })),
      far,
    ]) {
      expect(norm(v)).toEqual(v);
    }
  });

  it('preserves historical labels and accepts non-UUID branch/empty name', () => {
    const s = snap(true, {
      branchId: ' centro ',
      branchName: '',
      productName: 'a\u0000b',
      unit: '\t',
      variantName: '\u009f',
      variantOption: '  ',
    });
    expect(norm(decision(s))?.snapshot).toMatchObject(s);
    expect(norm(overSnap({ branchId: 'Sucursal 9' }))?.snapshot.branchId).toBe(
      'Sucursal 9',
    );
    const named = overSnap({ variantName: '' }, true);
    expect(norm(named)?.snapshot.variantName).toBe('');
  });

  it('rejects noncanonical text', () => {
    for (const t of [
      ' a',
      'a\tb',
      'a\u0085b',
      'a\u00a0b',
      'e\u0301',
      '',
      'x'.repeat(501),
      7,
    ]) {
      expect(norm(resolved(provided({ expirationText: t })))).toBeNull();
    }
  });

  it('requires every declared key at each level', () => {
    missing(decision(), (o) => o);
    missing(snap(false), (o) => decision(o));
    missing(provided(), (o) => resolved(o));
    missing(unavailable(), (o) => resolved(o));
  });

  it.each<[string, unknown]>([
    // extras, symbols and explicit undefined
    ['extra tenantId', over({ tenantId: U.source })],
    ['extra sku', overSnap({ sku: 'SKU-9' })],
    ['extra resolvedBy', resolved(provided({ resolvedBy: U.source }))],
    ['symbol key', { ...decision(), [Symbol('x')]: 1 }],
    ['symbol resolution', resolved(provided({ [Symbol('x')]: 1 }))],
    ['symbol negative', resolved(unavailable({ [Symbol('x')]: 1 }))],
    ['neg undefined', resolved(unavailable({ expirationText: undefined }))],
    ['undefined resolution', over({ resolution: undefined })],
    ['undefined unit', overSnap({ unit: undefined })],
    // wrong state / version / null combinations
    ['pending v2', over({ version: 2 })],
    ['pending resolution', over({ resolution: provided() })],
    ['pending applyBefore', over({ applyBefore: BEFORE })],
    ['resolved v1', overRes({ version: 1 })],
    ['resolved as pending', overRes({ status: 'PENDING' })],
    ['resolved null resolution', resolved(null)],
    ['resolved null applyBefore', overRes({ applyBefore: null })],
    ['unknown status', over({ status: 'CANCELLED' })],
    ['wrong type', over({ type: 'RESTOCK' })],
    ['supersedes set', over({ supersedesDecisionId: U.source })],
    ['bad action', resolved({ action: 'X', resolvedAt: AT })],
    // UUID identity, branch and variant labels
    ['upper id', over({ id: U.id.toUpperCase() })],
    ['upper product', overSnap({ productId: U.product.toUpperCase() })],
    ['nil product', overSnap({ productId: NIL })],
    ['v0 product', overSnap({ productId: V0 })],
    ['bad variant bits', overSnap({ productId: VB })],
    ['bad variantId', overSnap({ variantId: 'x' }, true)],
    ['blank branch', overSnap({ branchId: '  ' })],
    ['numeric branch', overSnap({ branchId: 7 })],
    ['simple name', overSnap({ variantName: 'X' })],
    ['simple option', overSnap({ variantOption: 'X' })],
    ['simple value', overSnap({ variantValue: 'X' })],
    ['nameless variant', overSnap({ variantName: null }, true)],
    // negative outcome carrying expirationText
    ['negative text', resolved(unavailable({ expirationText: 'x' }))],
    ['negative null text', resolved(unavailable({ expirationText: null }))],
    // canonical timestamps and the exact 24h deadline
    ['invalid createdAt', over({ createdAt: 'not-a-date' })],
    ['offset createdAt', over({ createdAt: '2026-06-22T12:30:00+02:00' })],
    ['invalid resolvedAt', resolved(provided({ resolvedAt: 'x' }))],
    [
      'offset resolvedAt',
      resolved(provided({ resolvedAt: '2026-06-23T10:00:00+02:00' })),
    ],
    ['+1h deadline', overRes({ applyBefore: '2026-06-24T09:00:00.000Z' })],
    ['-1ms deadline', overRes({ applyBefore: '2026-06-24T07:59:59.999Z' })],
    ['date-only deadline', overRes({ applyBefore: '2026-06-24' })],
  ])('rejects malformed or noncanonical input (%s)', (_l, v) => {
    expect(norm(v)).toBeNull();
  });

  it('fails closed on hostile getters, proxies and non-objects', () => {
    const getter = decision();
    Object.defineProperty(getter, 'createdAt', { enumerable: true, get: boom });
    expect(norm(getter)).toBeNull();
    expect(norm(new Proxy(decision(), { ownKeys: boom }))).toBeNull();
    expect(norm(new Proxy(decision(), { get: boom }))).toBeNull();
    for (const v of [null, 'nope', 7, []]) expect(norm(v)).toBeNull();
  });
});
