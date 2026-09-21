import {
  SHIPPING_QUOTE_PROVIDER,
  normalizeShippingQuoteProviderResult as normalize,
  type ShippingQuoteProviderPort,
  type ShippingQuoteProviderResult,
} from './shipping-quote.port';
import type { ShippingQuoteError } from './shipping-quote.error';
import type { ShippingQuoteRequest } from './shipping-quote.request';
import type { ShippingQuoteRate } from './shipping-quote.result';

type Rec = Record<string, unknown>;
const SECRET = 'svc_super_secret_token_value';
const ISO = '2026-01-02T03:04:05.000Z';
const keys = (value: object): string => Object.keys(value).sort().join();
const malformed: ShippingQuoteProviderResult = {
  kind: 'error',
  error: { kind: 'malformed_response' },
};
const err = (error: unknown): Rec => ({ kind: 'error', error });
const errorEnvelope = (
  error: ShippingQuoteError,
): ShippingQuoteProviderResult => ({ kind: 'error', error });
const boom = (): never => {
  throw new Error('boom');
};
const getter = (base: Rec, field: string, get: () => unknown): Rec => {
  const value: Rec = { ...base };
  Object.defineProperty(value, field, { get });
  return value;
};
const validRate = {
  rateId: 'rate-1',
  carrierName: 'Estafeta',
  serviceName: 'Dia Siguiente',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 1,
  validUntil: ISO,
} satisfies ShippingQuoteRate;
const validQuoted = {
  kind: 'quoted',
  quoteId: 'quote-1',
  rates: [validRate],
  expiresAt: ISO,
} satisfies ShippingQuoteProviderResult;
const quoted = (over: Rec = {}): Rec => ({ ...validQuoted, ...over });
const validErrors = [
  { kind: 'auth_failed' },
  { kind: 'invalid_request', field: 'origin' },
  { kind: 'rate_limited', retryAfterSeconds: 30 },
  { kind: 'upstream_unavailable', httpStatus: 429 },
  { kind: 'timeout' },
  { kind: 'malformed_response' },
  { kind: 'no_rates' },
  { kind: 'provider_disabled' },
] satisfies ShippingQuoteError[];
const address = (postalCode: string): ShippingQuoteRequest['origin'] => ({
  countryCode: 'MX',
  postalCode,
  state: 'Estado',
  municipality: 'Municipio',
  neighborhood: 'Colonia',
});
const validRequest: ShippingQuoteRequest = {
  origin: address('06600'),
  destination: address('64000'),
  parcels: [{ lengthCm: 20, widthCm: 15, heightCm: 10, weightGrams: 1_200 }],
};

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${String(value)}`);
}
const label = (result: ShippingQuoteProviderResult): string => {
  if (result.kind === 'quoted') return `quoted:${result.rates[0].rateId}`;
  if (result.kind === 'error') return `error:${result.error.kind}`;
  return assertNever(result);
};

describe('normalizeShippingQuoteProviderResult', () => {
  it('exposes a unique, non-registered provider token', () => {
    expect(typeof SHIPPING_QUOTE_PROVIDER).toBe('symbol');
    expect(SHIPPING_QUOTE_PROVIDER.description).toBe('SHIPPING_QUOTE_PROVIDER');
    expect(Symbol.keyFor(SHIPPING_QUOTE_PROVIDER)).toBeUndefined();
    expect(SHIPPING_QUOTE_PROVIDER).not.toBe(Symbol('SHIPPING_QUOTE_PROVIDER'));
  });

  it('delegates valid quoted results, canonicalizing timestamps and cloning', () => {
    const out = normalize(
      quoted({ expiresAt: '2026-01-02T08:34:05+05:30', token: SECRET }),
    );
    expect(out).toEqual(validQuoted);
    expect(out).not.toBe(validQuoted);
    if (out.kind !== 'quoted') throw new Error('expected quoted');
    expect(out.rates).not.toBe(validQuoted.rates);
    expect(out.rates[0]).not.toBe(validRate);
    expect(keys(out)).toBe('expiresAt,kind,quoteId,rates');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('fails every malformed envelope closed as malformed_response', () => {
    class Envelope {
      kind = 'error';
      error = { kind: 'auth_failed' };
    }
    const bad: unknown[] = [
      { kind: 'quoted' },
      quoted({ quoteId: '' }),
      quoted({ rates: [] }),
      quoted({ expiresAt: 'nope' }),
      quoted({ rates: [{ ...validRate, priceCents: -1 }] }),
      err(undefined),
      err(42),
      err(null),
      err({}),
      err({ kind: 'invalid_request' }),
      err({ kind: 'rate_limited', retryAfterSeconds: -1 }),
      err({ kind: 'upstream_unavailable', httpStatus: 600 }),
      err({ kind: SECRET, token: SECRET }),
      null,
      undefined,
      42,
      'value',
      true,
      [],
      () => 'value',
      new Date(),
      {},
      { kind: 'rejected' },
      { kind: 42 },
      { kind: null },
      Object.create({ kind: 'quoted' }),
      new Envelope(),
      getter({}, 'kind', boom),
      getter({ kind: 'error' }, 'error', boom),
      new Proxy({}, { get: boom, getPrototypeOf: boom }),
    ];
    for (const value of bad) expect(normalize(value)).toEqual(malformed);
  });

  it.each(validErrors)(
    'reconstructs a fresh exact envelope for valid nested error %#',
    (error) => {
      const out = normalize({ ...errorEnvelope(error), token: SECRET });
      expect(out).toEqual(errorEnvelope(error));
      expect(keys(out)).toBe('error,kind');
      if (out.kind !== 'error') throw new Error('expected error');
      expect(keys(out.error)).toBe(keys(error));
      expect(JSON.stringify(out)).not.toContain(SECRET);
    },
  );

  it('strips envelope extras and sentinel keys at both levels', () => {
    const out = normalize({
      ...err({ kind: 'auth_failed', token: SECRET, body: SECRET }),
      payload: SECRET,
      authorization: SECRET,
      shippingAddress: 'Calle Secreta 123',
      message: SECRET,
    });
    expect(out).toEqual(errorEnvelope({ kind: 'auth_failed' }));
    expect(keys(out)).toBe('error,kind');
    if (out.kind !== 'error') throw new Error('expected error');
    expect(keys(out.error)).toBe('kind');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('snapshots the top-level kind and nested error exactly once', () => {
    const reads = { kind: 0, error: 0, inner: 0 };
    const inner = getter({}, 'kind', () =>
      ++reads.inner === 1 ? 'rate_limited' : SECRET,
    );
    Object.defineProperty(inner, 'retryAfterSeconds', { value: 30 });
    const input: Rec = {};
    Object.defineProperty(input, 'kind', {
      get: () => (++reads.kind === 1 ? 'error' : SECRET),
    });
    Object.defineProperty(input, 'error', {
      get: () => (++reads.error === 1 ? inner : SECRET),
    });
    const out = normalize(input);
    expect(out).toEqual(
      errorEnvelope({ kind: 'rate_limited', retryAfterSeconds: 30 }),
    );
    expect(reads).toEqual({ kind: 1, error: 1, inner: 1 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('fails closed when a quoted kind changes on re-read', () => {
    const reads = { kind: 0 };
    const input = getter(
      { quoteId: 'quote-1', rates: [validRate], expiresAt: null },
      'kind',
      () => (++reads.kind === 1 ? 'quoted' : SECRET),
    );
    const out = normalize(input);
    expect(out).toEqual(malformed);
    expect(reads.kind).toBe(2);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('returns fresh envelopes without mutating a frozen input', () => {
    const frozen = Object.freeze({
      ...err(Object.freeze({ kind: 'rate_limited', retryAfterSeconds: 30 })),
      token: SECRET,
    });
    const before = JSON.stringify(frozen);
    const out = normalize(frozen);
    expect(out).toEqual(
      errorEnvelope({ kind: 'rate_limited', retryAfterSeconds: 30 }),
    );
    expect(out).not.toBe(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(normalize(null)).not.toBe(normalize(null));
  });

  it('exhaustively maps the provider result union with normal fixtures', () => {
    const failure: ShippingQuoteProviderResult = errorEnvelope({
      kind: 'timeout',
    });
    expect([label(validQuoted), label(failure)]).toEqual([
      'quoted:rate-1',
      'error:timeout',
    ]);
    expect([label(normalize(validQuoted)), label(normalize(failure))]).toEqual([
      'quoted:rate-1',
      'error:timeout',
    ]);
  });

  it('supports an offline fake provider with a valid request', async () => {
    const provider: ShippingQuoteProviderPort = {
      quote(
        request: ShippingQuoteRequest,
      ): Promise<ShippingQuoteProviderResult> {
        return Promise.resolve({
          kind: 'quoted',
          quoteId: request.destination.postalCode,
          rates: [validRate],
          expiresAt: null,
        });
      },
    };
    expect(normalize(await provider.quote(validRequest))).toEqual({
      kind: 'quoted',
      quoteId: '64000',
      rates: [validRate],
      expiresAt: null,
    });
  });
});
