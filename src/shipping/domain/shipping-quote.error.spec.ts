import {
  normalizeShippingQuoteError as normalizeError,
  type ShippingQuoteError,
} from './shipping-quote.error';

type Rec = Record<string, unknown>;
const MAX = Number.MAX_SAFE_INTEGER;
const SECRET = 'svc_super_secret_token_value';

const keys = (value: object): string => Object.keys(value).sort().join();
const boom = (): never => {
  throw new Error('boom');
};
const withGetters = (fields: string[], base: Rec = {}): Rec => {
  const value: Rec = { ...base };
  for (const field of fields) {
    Object.defineProperty(value, field, { get: boom });
  }
  return value;
};
function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${String(value)}`);
}
const errorLabel = (error: ShippingQuoteError): string => {
  switch (error.kind) {
    case 'invalid_request':
      return `invalid_request:${error.field}`;
    case 'rate_limited':
      return `rate_limited:${String(error.retryAfterSeconds)}`;
    case 'upstream_unavailable':
      return `upstream_unavailable:${String(error.httpStatus)}`;
    case 'auth_failed':
    case 'timeout':
    case 'malformed_response':
    case 'no_rates':
    case 'provider_disabled':
      return error.kind;
    default:
      return assertNever(error);
  }
};
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

describe('normalizeShippingQuoteError', () => {
  it('reconstructs every kind exactly, stripping extras and sentinel secrets', () => {
    const cases: Array<[Rec, ShippingQuoteError]> = [
      [{ kind: 'auth_failed', token: SECRET }, { kind: 'auth_failed' }],
      [{ kind: 'timeout', message: SECRET }, { kind: 'timeout' }],
      [
        { kind: 'malformed_response', body: { authorization: SECRET } },
        { kind: 'malformed_response' },
      ],
      [{ kind: 'no_rates', token: SECRET }, { kind: 'no_rates' }],
      [
        { kind: 'provider_disabled', providerCode: SECRET },
        { kind: 'provider_disabled' },
      ],
      [
        { kind: 'invalid_request', field: 'origin', payload: SECRET },
        { kind: 'invalid_request', field: 'origin' },
      ],
      [
        { kind: 'rate_limited', retryAfterSeconds: null, address: SECRET },
        { kind: 'rate_limited', retryAfterSeconds: null },
      ],
      [
        { kind: 'upstream_unavailable', httpStatus: 503, providerCode: SECRET },
        { kind: 'upstream_unavailable', httpStatus: 503 },
      ],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeError(input);
      expect(out).toEqual(expected);
      expect(out).not.toBe(input);
      expect(keys(out)).toBe(keys(expected));
      expect(JSON.stringify(out)).not.toContain(SECRET);
      for (const forbidden of [
        'body',
        'token',
        'payload',
        'address',
        'message',
        'providerCode',
      ]) {
        expect(Object.keys(out)).not.toContain(forbidden);
      }
    }
  });

  it.each(['origin', 'destination', 'parcels', 'unknown'])(
    'keeps the explicit invalid_request field %p',
    (field) => {
      expect(normalizeError({ kind: 'invalid_request', field })).toEqual({
        kind: 'invalid_request',
        field,
      });
    },
  );

  it.each(['postal_code', '', 'Origin', 42, null, undefined, {}, SECRET])(
    'maps an invalid invalid_request field %p to malformed_response',
    (field) => {
      const out = normalizeError({ kind: 'invalid_request', field });
      expect(out).toEqual({ kind: 'malformed_response' });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    },
  );

  it.each([null, 0, 30, MAX])(
    'keeps valid retryAfterSeconds %p',
    (retryAfterSeconds) => {
      expect(
        normalizeError({ kind: 'rate_limited', retryAfterSeconds }),
      ).toEqual({ kind: 'rate_limited', retryAfterSeconds });
    },
  );

  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    MAX + 1,
    '30',
    true,
    {},
    [],
    undefined,
  ])('maps invalid retryAfterSeconds %p to malformed_response', (value) => {
    expect(
      normalizeError({ kind: 'rate_limited', retryAfterSeconds: value }),
    ).toEqual({ kind: 'malformed_response' });
  });

  it.each([null, 100, 200, 429, 599])(
    'keeps valid httpStatus %p',
    (httpStatus) => {
      expect(
        normalizeError({ kind: 'upstream_unavailable', httpStatus }),
      ).toEqual({ kind: 'upstream_unavailable', httpStatus });
    },
  );

  it.each([
    -1,
    99,
    600,
    1.5,
    100.5,
    NaN,
    Infinity,
    MAX + 1,
    '200',
    {},
    undefined,
  ])('maps invalid httpStatus %p to malformed_response', (value) => {
    expect(
      normalizeError({ kind: 'upstream_unavailable', httpStatus: value }),
    ).toEqual({ kind: 'malformed_response' });
  });

  it('normalizes malformed, missing-subfield, class, and proxy inputs', () => {
    const values: unknown[] = [
      null,
      undefined,
      42,
      'value',
      true,
      [],
      () => 'value',
      new Date(),
      {},
      { kind: 'boom' },
      { kind: SECRET },
      { kind: 42 },
      { kind: null },
      { kind: 'invalid_request' },
      { kind: 'rate_limited' },
      { kind: 'upstream_unavailable' },
    ];
    for (const value of values) {
      expect(normalizeError(value)).toEqual({ kind: 'malformed_response' });
    }
    expect(normalizeError(Object.create({ kind: 'auth_failed' }))).toEqual({
      kind: 'malformed_response',
    });
    expect(
      normalizeError(new Proxy({}, { get: boom, getPrototypeOf: boom })),
    ).toEqual({ kind: 'malformed_response' });
  });

  it('never mutates a frozen input and returns fresh objects', () => {
    const frozen = Object.freeze({
      kind: 'rate_limited',
      retryAfterSeconds: 30,
      token: SECRET,
    });
    const before = JSON.stringify(frozen);
    const out = normalizeError(frozen);
    expect(out).toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect(out).not.toBe(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(normalizeError(null)).not.toBe(normalizeError(null));
  });

  it('never throws for throwing getters and snapshots stateful getters once', () => {
    const throwers = [
      withGetters(['kind']),
      withGetters(['retryAfterSeconds'], { kind: 'rate_limited' }),
      withGetters(['field'], { kind: 'invalid_request' }),
    ];
    for (const input of throwers) {
      expect(normalizeError(input)).toEqual({ kind: 'malformed_response' });
    }
    const reads = { kind: 0, retry: 0 };
    const input: Rec = {};
    Object.defineProperty(input, 'kind', {
      get: () => (++reads.kind === 1 ? 'rate_limited' : SECRET),
    });
    Object.defineProperty(input, 'retryAfterSeconds', {
      get: () => (++reads.retry === 1 ? 30 : SECRET),
    });
    const out = normalizeError(input);
    expect(out).toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect(reads).toEqual({ kind: 1, retry: 1 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('exhaustively maps the error union with normal fixtures', () => {
    expect(validErrors.map(errorLabel)).toEqual([
      'auth_failed',
      'invalid_request:origin',
      'rate_limited:30',
      'upstream_unavailable:429',
      'timeout',
      'malformed_response',
      'no_rates',
      'provider_disabled',
    ]);
  });
});
