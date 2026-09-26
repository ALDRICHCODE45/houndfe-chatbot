// prettier-ignore
import { ShippingQuoteOrchestrator as Orchestrator, type ShippingQuoteOrchestrationResult, type ShippingQuoteOrchestratorProvider } from './shipping-quote-orchestrator';
import type { ShippingQuoteTelemetryPort } from '../domain/shipping-telemetry.port';

type Rec = Record<string, unknown>;
const SECRET = 'svc_super_secret_token_value';
const M = { weightGrams: 500, lengthCm: 1, widthCm: 1, heightCm: 1 };
const O = { postalCode: '1', state: 'S', municipality: 'M', neighborhood: 'N' };
const D = { zipCode: '2', state: 'T', municipality: 'U', neighborhood: 'V' };
const B = { lengthCm: 1, widthCm: 1, heightCm: 1, weightGrams: 500 };
const BIG = Math.floor(Number.MAX_SAFE_INTEGER / 500) + 1;
// prettier-ignore
const el = (x: Rec = {}): Rec => ({ productId: 'p', quantity: 1, measurement: M, unitPriceCents: 1, ...x });
const bx = (x: Rec = {}): Rec => ({ ...B, ...x });
// prettier-ignore
const reqInput = (x: Rec = {}): Rec => ({ origin: { ...O }, destination: { ...D }, items: [el()], parcels: [bx()], ...x });
// prettier-ignore
const line = (unitPriceCents: unknown, quantity: unknown): Rec => ({ unitPriceCents, quantity });
// prettier-ignore
const cart = (creditLines: unknown, x: Rec = {}): Rec => ({ requestInput: reqInput(x), creditLines });
const ready = (over: Rec = {}): Rec => cart([line(1, 1)], over);
// prettier-ignore
const rate = (x: Rec = {}): Rec => ({ rateId: 'rate-1', carrierName: 'Estafeta', serviceName: 'Dia Siguiente', priceCents: 12_900, currency: 'MXN', estimatedDeliveryDays: 2, validUntil: null, ...x });
// prettier-ignore
const quoted = (x: Rec = {}): Rec => ({ kind: 'quoted', quoteId: 'quote-1', rates: [rate()], expiresAt: null, ...x });
const err = (error: unknown): Rec => ({ kind: 'error', error });
// prettier-ignore
const go = (value: unknown, provider: unknown): Promise<ShippingQuoteOrchestrationResult> => new Orchestrator(provider as ShippingQuoteOrchestratorProvider).quote(value);
// prettier-ignore
const goT = (value: unknown, provider: unknown, port: unknown): Promise<ShippingQuoteOrchestrationResult> => new Orchestrator(provider as ShippingQuoteOrchestratorProvider, port as ShippingQuoteTelemetryPort).quote(value);
const ok = (): Promise<Rec> => Promise.resolve(quoted());
// prettier-ignore
const boom = (): never => { throw new Error('x'); };
const host: object = new Proxy({}, { get: boom });
const hostileArray: object = new Proxy([line(1, 1)], { get: boom });
// prettier-ignore
const badLength: object = new Proxy([line(1, 1)], { get: (_t, k) => (k === 'length' ? '2' : undefined) });
// prettier-ignore
const revoked: object = (() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })();
// prettier-ignore
const exotic = (element: unknown): unknown => { const a: unknown[] = []; Object.setPrototypeOf(a, [element]); a.length = 1; return a; };
// prettier-ignore
const observe = (v: Rec, log: string[]): Rec => new Proxy(v, { get: (t, k) => { log.push(String(k)); return t[String(k)]; } });
// prettier-ignore
const calls: unknown[] = [];
// prettier-ignore
const record = (request: unknown): Promise<Rec> => { calls.push(request); return ok(); };
const spy = (): Rec => ({ quote: record });
// prettier-ignore
const withProvider = (raw: unknown): Rec => ({ quote: () => Promise.resolve(raw) });

describe('SQ-4C assembly gating', () => {
  // prettier-ignore
  const table: Array<[string, Rec]> = [
    ['invalid_input', { requestInput: undefined, creditLines: [line(1, 1)] }],
    ['invalid_origin', cart([line(1, 1)], { origin: {} })],
    ['invalid_destination', cart([line(1, 1)], { destination: {} })],
    ['invalid_items', cart([line(1, 1)], { items: 'x' })],
    ['missing_measurements', cart([line(1, 1)], { items: [el({ measurement: { ...M, weightGrams: null } })] })],
    ['packing_required', cart([line(1, 1)], { parcels: [] })],
    ['parcel_limit_exceeded', cart([line(1, 1)], { parcels: Array.from({ length: 21 }) })],
    ['overflow', cart([line(1, 1)], { items: [el({ quantity: BIG })] })],
  ];
  // prettier-ignore
  it.each(table)('maps assembly %s with zero credit or provider observation', async (reason, value) => {
    calls.length = 0;
    const log: string[] = [];
    const out = await go(observe(value, log), spy());
    expect(out).toEqual({ kind: 'unavailable', reason });
    expect(log).toContain('requestInput');
    expect(log).not.toContain('creditLines');
    expect(calls).toEqual([]);
  });
  // prettier-ignore
  it('preserves the manual packing count with no credit or provider read', async () => {
    calls.length = 0;
    const log: string[] = [];
    const value = cart([line(1, 1)], { items: [el({ quantity: 6, measurement: { ...M, weightGrams: 5000 } })] });
    const out = await go(observe(value, log), spy());
    expect(out).toEqual({ kind: 'handoff', reason: 'manual_packing_required', minimumPackageCount: 2 });
    expect(Object.isFrozen(out)).toBe(true);
    expect(log).not.toContain('creditLines');
    expect(calls).toEqual([]);
  });
});

describe('SQ-4C invalid item collections', () => {
  // prettier-ignore
  const bad: Array<[string, unknown]> = [
    ['empty', []], ['over bound', Array.from({ length: 101 }, () => line(1, 1))],
    ['sparse', Object.assign([line(1, 1)], { 2: line(1, 1) })], ['inherited index', exotic(line(1, 1))],
    ['non-array object', {}], ['non-array null', null], ['non-array string', 'x'], ['non-array number', 7],
    ['empty element', [{}]], ['missing cents', [{ quantity: 1 }]], ['missing quantity', [{ unitPriceCents: 1 }]],
    ['object cents', [line({}, 1)]], ['object quantity', [line(1, {})]],
    ['negative cents', [line(-1, 1)]], ['fractional cents', [line(1.5, 1)]], ['unsafe cents', [line(Number.MAX_SAFE_INTEGER + 1, 1)]],
    ['zero quantity', [line(1, 0)]], ['negative quantity', [line(1, -1)]], ['fractional quantity', [line(1, 1.5)]],
    ['throwing element', [host]], ['throwing array', hostileArray], ['non-numeric length', badLength], ['revoked array', revoked],
  ];
  // prettier-ignore
  it.each(bad)('maps malformed items %s to invalid_items with no provider call', async (_n, items) => {
    calls.length = 0;
    expect(await go(ready({ items }), spy())).toEqual({ kind: 'unavailable', reason: 'invalid_items' });
    expect(calls).toEqual([]);
  });
  // prettier-ignore
  it.each([undefined, -1, 1.5, {}, Number.MAX_SAFE_INTEGER + 1, 'absent'])('maps item price %# to invalid_cart', async (unitPriceCents) => {
    calls.length = 0;
    const raw = unitPriceCents === 'absent' ? { productId: 'p', quantity: 1, measurement: M } : el({ unitPriceCents });
    expect(await go(ready({ items: [raw] }), spy())).toEqual({ kind: 'unavailable', reason: 'invalid_cart' });
    expect(calls).toEqual([]);
  });
});

describe('SQ-4C credit from item snapshots', () => {
  // prettier-ignore
  it('ignores an unread legacy creditLines field and charges for one real unit', async () => {
    const log: string[] = [];
    const value = observe(cart([line(60_000, 2)], { items: [el({ unitPriceCents: 60_000 })] }), log);
    const out = await go(value, spy());
    expect([log.filter((k) => k === 'requestInput').length, log.includes('creditLines')]).toEqual([1, false]);
    if (out.kind !== 'draft') throw new Error('expected draft');
    expect([out.draft.totalCreditCents, out.draft.qualifyingUnitCount, out.draft.customerPaysCents]).toEqual([12_000, 1, 900]);
  });
  // prettier-ignore
  it('derives readiness weight and credit units from the same quantity', async () => {
    const out = await go(ready({ items: [el({ quantity: 2, unitPriceCents: 60_000 })], parcels: [bx({ weightGrams: 1_000 })] }), spy());
    if (out.kind !== 'draft') throw new Error('expected draft');
    expect([out.draft.qualifyingUnitCount, out.draft.totalCreditCents]).toEqual([2, 24_000]);
  });
  // prettier-ignore
  it('reads a stateful raw item quantity exactly once for logistics and credit', async () => {
    const reads: Rec = {};
    const priced = new Proxy(el({ quantity: 2, unitPriceCents: 60_000 }), { get: (t, k) => { const key = String(k); const n = ((reads[key] as number) ?? 0) + 1; reads[key] = n; return n === 1 ? t[key] : SECRET; } });
    const out = await go(ready({ items: [priced], parcels: [bx({ weightGrams: 1_000 })] }), spy());
    expect(reads.quantity).toBe(1);
    if (out.kind !== 'draft') throw new Error('expected draft');
    expect(out.draft.qualifyingUnitCount).toBe(2);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe('SQ-4C ready draft', () => {
  // prettier-ignore
  it('passes the exact assembled frozen request once and returns the draft', async () => {
    calls.length = 0;
    const out = await go(ready({ items: [el({ quantity: 2, unitPriceCents: 60_000 })], parcels: [bx({ weightGrams: 1_000 })] }), spy());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ origin: { ...O, countryCode: 'MX' }, destination: { countryCode: 'MX', postalCode: '2', state: 'T', municipality: 'U', neighborhood: 'V' }, parcels: [{ ...B, weightGrams: 1_000 }] });
    expect(Object.isFrozen(calls[0])).toBe(true);
    expect(out).toEqual({ kind: 'draft', draft: { quoteId: 'quote-1', selectedRate: rate(), providerExpiresAt: null, bestRateCents: 12_900, totalCreditCents: 24_000, appliedCreditCents: 12_900, unusedCreditCents: 11_100, qualifyingUnitCount: 2, customerPaysCents: 0 } });
    if (out.kind !== 'draft') throw new Error('expected draft');
    expect([out, out.draft, out.draft.selectedRate].every(Object.isFrozen)).toBe(true);
  });
});

describe('SQ-4C provider error mapping', () => {
  // prettier-ignore
  const table: Array<[Rec, Rec]> = [
    [{ kind: 'unavailable', reason: 'provider_disabled' }, err({ kind: 'provider_disabled' })],
    [{ kind: 'handoff', reason: 'no_rates' }, err({ kind: 'no_rates' })],
    [{ kind: 'handoff', reason: 'provider_rejected_request' }, err({ kind: 'invalid_request', field: 'destination' })],
    [{ kind: 'handoff', reason: 'provider_failure' }, err({ kind: 'auth_failed' })],
    [{ kind: 'handoff', reason: 'provider_failure' }, err({ kind: 'rate_limited', retryAfterSeconds: 5 })],
    [{ kind: 'handoff', reason: 'provider_failure' }, err({ kind: 'upstream_unavailable', httpStatus: 503 })],
    [{ kind: 'handoff', reason: 'provider_failure' }, err({ kind: 'timeout' })],
    [{ kind: 'handoff', reason: 'provider_failure' }, err({ kind: 'malformed_response' })],
    [{ kind: 'handoff', reason: 'provider_failure' }, err({ kind: 'mystery', token: SECRET })],
  ];
  // prettier-ignore
  it.each(table)('maps provider envelope %# to a finite result', async (expected, raw) => {
    const out = await go(ready(), withProvider(raw));
    expect(out).toEqual(expected);
    expect(Object.isFrozen(out)).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  // prettier-ignore
  it('strips provider extras, field detail, and secrets', async () => {
    const raw = { kind: 'error', error: { kind: 'upstream_unavailable', httpStatus: 503, message: SECRET, token: SECRET, body: { address: SECRET } }, extra: SECRET };
    const out = await go(ready(), withProvider(raw));
    expect(out).toEqual({ kind: 'handoff', reason: 'provider_failure' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const rejected = await go(ready(), withProvider(err({ kind: 'invalid_request', field: 'destination' })));
    expect(JSON.stringify(rejected)).not.toContain('destination');
  });
});

describe('SQ-4C hostile provider responses', () => {
  // prettier-ignore
  const hostile: Array<[unknown]> = [[undefined], [null], [42], ['x'], [[]], [{}], [{ kind: 'quoted' }], [quoted({ rates: [] })], [quoted({ rates: [rate({ priceCents: -1 })] })], [host], [revoked]];
  // prettier-ignore
  it.each(hostile)('maps malformed or hostile response %# to provider_failure', async (raw) => {
    expect(await go(ready(), withProvider(raw))).toEqual({ kind: 'handoff', reason: 'provider_failure' });
  });
  // prettier-ignore
  it('reads a stateful raw kind exactly once and keeps a valid draft', async () => {
    const reads: Rec = {};
    const raw = new Proxy(quoted(), { get: (t, k) => { const key = String(k); const n = ((reads[key] as number) ?? 0) + 1; reads[key] = n; return n === 1 ? t[key] : SECRET; } });
    const out = await go(ready(), withProvider(raw));
    expect([reads.kind, reads.quoteId, reads.rates, reads.expiresAt]).toEqual([1, 1, 1, 1]);
    if (out.kind !== 'draft') throw new Error('expected draft');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  // prettier-ignore
  it('reads a stateful raw error field exactly once', async () => {
    const reads: Rec = {};
    const raw = new Proxy({ kind: 'error', error: { kind: 'no_rates' } }, { get: (t, k) => { const key = String(k); const n = ((reads[key] as number) ?? 0) + 1; reads[key] = n; return n === 1 ? (t as Rec)[key] : SECRET; } });
    const out = await go(ready(), withProvider(raw));
    expect([reads.kind, reads.error]).toEqual([1, 1]);
    expect(out).toEqual({ kind: 'handoff', reason: 'no_rates' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  // prettier-ignore
  it.each([['sync throw', (): unknown => boom()], ['rejection', (): unknown => Promise.reject(new Error(SECRET))]])(
    'maps provider %s to provider_failure exactly once without leaking', async (_n, thrower) => {
      let count = 0;
      const out = await go(ready(), { quote: () => { count += 1; return thrower(); } });
      expect(out).toEqual({ kind: 'handoff', reason: 'provider_failure' });
      expect(count).toBe(1);
      expect(JSON.stringify(out)).not.toContain(SECRET);
    },
  );
  // prettier-ignore
  it('maps a hostile provider surface to provider_failure', async () => {
    expect(await go(ready(), host)).toEqual({ kind: 'handoff', reason: 'provider_failure' });
  });
});

describe('SQ-4C isolation and output safety', () => {
  // prettier-ignore
  it('isolates concurrent calls, items, and results', async () => {
    const provider = { quote: (request: unknown): Promise<Rec> => { const postal = ((request as Rec).destination as Rec).postalCode as string; return Promise.resolve(quoted({ quoteId: `q-${postal}`, rates: [rate({ rateId: `r-${postal}` })] })); } };
    const a = ready({ items: [el({ quantity: 2, unitPriceCents: 60_000 })], parcels: [bx({ weightGrams: 1_000 })] });
    const b = cart([line(1, 1)], { destination: { ...D, zipCode: '9' } });
    const [ra, rb] = await Promise.all([go(a, provider), go(b, provider)]);
    expect(ra).toMatchObject({ kind: 'draft', draft: { quoteId: 'q-2', customerPaysCents: 0 } });
    expect(rb).toMatchObject({ kind: 'draft', draft: { quoteId: 'q-9', customerPaysCents: 12_900 } });
    expect(ra).not.toBe(rb);
  });
  // prettier-ignore
  it('returns exact, fresh, frozen wrappers and ignores post-return mutation', async () => {
    const source = ready({ items: [el({ unitPriceCents: 60_000 })] });
    const raw = quoted();
    const out = await go(source, withProvider(raw));
    if (out.kind !== 'draft') throw new Error('expected draft');
    expect(Object.keys(out).sort()).toEqual(['draft', 'kind']);
    const before = JSON.stringify(out);
    ((source.requestInput as Rec).items as Rec[])[0].unitPriceCents = 1;
    (raw.rates as Rec[])[0].priceCents = 999_999;
    expect(JSON.stringify(out)).toBe(before);
  });
  // prettier-ignore
  it('emits fresh exact-key wrappers per call', async () => {
    const a = await go(ready({ items: [] }), withProvider(quoted()));
    const b = await go(ready({ items: [] }), withProvider(quoted()));
    const c = await go(ready(), withProvider(err({ kind: 'no_rates' })));
    expect(a).toEqual({ kind: 'unavailable', reason: 'invalid_items' });
    expect(a).not.toBe(b);
    expect(Object.keys(a).sort()).toEqual(['kind', 'reason']);
    expect(c).toEqual({ kind: 'handoff', reason: 'no_rates' });
    expect(Object.keys(c).sort()).toEqual(['kind', 'reason']);
  });
});

describe('SQ-6C redacted outcome telemetry', () => {
  // prettier-ignore
  const table: Array<[string, unknown, Rec, Rec]> = [
    ['draft', ready(), withProvider(quoted()), { kind: 'draft' }],
    ['unavailable/invalid_input', { requestInput: undefined, creditLines: [line(1, 1)] }, spy(), { kind: 'unavailable', reason: 'invalid_input' }],
    ['unavailable/invalid_cart', ready({ items: [el({ unitPriceCents: -1 })] }), spy(), { kind: 'unavailable', reason: 'invalid_cart' }],
    ['unavailable/provider_disabled', ready(), withProvider(err({ kind: 'provider_disabled' })), { kind: 'unavailable', reason: 'provider_disabled' }],
    ['handoff/manual_packing_required', cart([line(1, 1)], { items: [el({ quantity: 6, measurement: { ...M, weightGrams: 5000 } })] }), spy(), { kind: 'handoff', reason: 'manual_packing_required' }],
    ['handoff/no_rates', ready(), withProvider(err({ kind: 'no_rates' })), { kind: 'handoff', reason: 'no_rates' }],
    ['handoff/provider_rejected_request', ready(), withProvider(err({ kind: 'invalid_request', field: 'destination' })), { kind: 'handoff', reason: 'provider_rejected_request' }],
    ['handoff/provider_failure', ready(), withProvider(err({ kind: 'mystery' })), { kind: 'handoff', reason: 'provider_failure' }],
  ];
  // prettier-ignore
  it.each(table)('records exactly one finite label for %s', async (_n, value, provider, expected) => {
    calls.length = 0;
    const seen: unknown[][] = [];
    const out = await goT(value, provider, { record: (kind: unknown, reason?: unknown) => { seen.push([kind, reason]); } });
    expect(out).toMatchObject(expected);
    expect(seen).toEqual([[out.kind, 'reason' in out ? out.reason : undefined]]);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });
  // prettier-ignore
  it('swallows a hostile logger and returns the unchanged frozen result', async () => {
    const expected = await go(ready(), withProvider(quoted()));
    let attempts = 0;
    const out = await goT(ready(), withProvider(quoted()), { record: () => { attempts += 1; throw new Error(SECRET); } });
    expect(out).toEqual(expected);
    expect(Object.isFrozen(out)).toBe(true);
    expect(attempts).toBe(1);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  // prettier-ignore
  it('tolerates a hostile record getter without changing the result', async () => {
    const expected = await go(ready(), withProvider(err({ kind: 'no_rates' })));
    const hostile = new Proxy({}, { get: () => { throw new Error(SECRET); } });
    const out = await goT(ready(), withProvider(err({ kind: 'no_rates' })), hostile);
    expect(out).toEqual(expected);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  // prettier-ignore
  it('passes only labels, never payload or secret, to the sink', async () => {
    const seen: unknown[][] = [];
    await goT(ready({ items: [el({ unitPriceCents: 60_000 })] }), withProvider(quoted()), { record: (kind: unknown, reason?: unknown) => { seen.push([kind, reason]); } });
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(seen.every((entry) => entry.length <= 2)).toBe(true);
    expect(seen).toEqual([['draft', undefined]]);
  });
});
