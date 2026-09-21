/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- tests reject with non-Error abort/hostile shapes */
import axios, { type AxiosRequestConfig } from 'axios';
import type { ShippingQuoteError } from '../domain/shipping-quote.error';
import {
  SkydropxQuotationClient,
  type SkydropxQuotationPayload,
  type SkydropxQuotationTokenSource,
} from './skydropx-quotation.client';
import type {
  SkydropxHttp,
  SkydropxHttpResponse,
  SkydropxTokenResult,
} from './skydropx-token.client';
const SECRET = 'SECRET_SENTINEL_9f';
const BODY = 'BODY_SENTINEL_7a';
const TOKEN = `tok-${SECRET}`;
const CONFIG = {
  baseUrl: 'https://api-pro.skydropx.com/',
  timeoutMs: 5_000,
} as const;
// prettier-ignore
const A = (t: string): SkydropxTokenResult => ({ kind: 'token', accessToken: t });
// prettier-ignore
const e = (kind: string, extra: Record<string, unknown> = {}) => ({ kind: 'error', error: { kind, ...extra } });
const mal = e('malformed_response');
const ireq = e('invalid_request', { field: 'unknown' });
const auth = e('auth_failed');
const up = (s: number | null) => e('upstream_unavailable', { httpStatus: s });
const rate = (s: number | null) => e('rate_limited', { retryAfterSeconds: s });
const timeout = e('timeout');
const created = (quotationId = 'q-1') => ({ kind: 'created', quotationId });
// prettier-ignore
const ok = (data: unknown = { id: 'q-1', is_completed: false }): SkydropxHttpResponse => ({ status: 201, data });
// prettier-ignore
const r = (status: unknown, headers?: unknown, data: unknown = {}): SkydropxHttpResponse => ({ status: status as number, data, headers });
const fail = (code: string): Error => Object.assign(new Error(BODY), { code });
// prettier-ignore
const hostile = <T extends object>(base: T, key: string): T => Object.defineProperty(base, key, { get: () => { throw new Error(BODY); } });
const hostileToken = (key: string): SkydropxTokenResult =>
  hostile({ kind: 'token', accessToken: 'tok-1' }, key);
const hostileErr = (): SkydropxTokenResult =>
  hostile({ kind: 'error', error: { kind: 'auth_failed' } }, 'error');
// prettier-ignore
const PAYLOAD: SkydropxQuotationPayload = {
  quotation: {
    address_from: { country_code: 'MX', postal_code: '01000', area_level1: 'CDMX', area_level2: 'AO', area_level3: BODY },
    address_to: { country_code: 'MX', postal_code: '06700', area_level1: 'CDMX', area_level2: 'AO', area_level3: 'Roma' },
    parcels: [{ length: 10, width: 10, height: 10, weight: 1_000 }],
  },
};
type Script = Array<SkydropxHttpResponse | Error | { name: string }>;
const make = (
  script: Script,
  tokenResults: SkydropxTokenResult[] = [A(TOKEN)],
  override?: SkydropxQuotationTokenSource,
) => {
  const calls: AxiosRequestConfig[] = [];
  let i = 0;
  const http: SkydropxHttp = (config) => {
    calls.push(config);
    const next = script[Math.min(i++, script.length - 1)];
    const rejected =
      next instanceof Error ||
      (next as { name?: unknown }).name === 'AbortError';
    return rejected
      ? Promise.reject(next)
      : Promise.resolve(next as SkydropxHttpResponse);
  };
  let t = 0;
  const getToken = jest.fn(
    (): Promise<SkydropxTokenResult> =>
      Promise.resolve(tokenResults[Math.min(t++, tokenResults.length - 1)]),
  );
  const invalidate = jest.fn();
  const defaults = { getToken, invalidate };
  const tokens: SkydropxQuotationTokenSource = override ?? defaults;
  const client = new SkydropxQuotationClient(CONFIG, tokens, http);
  return { client, calls, getToken, invalidate };
};
const run = (script: Script, tokens?: SkydropxTokenResult[]) =>
  make(script, tokens).client.create(PAYLOAD);
it('creates over the default transport, returning only the id', async () => {
  const spy = jest.spyOn(axios, 'request').mockResolvedValueOnce({
    status: 201,
    data: { id: 'q-1', is_completed: false },
  });
  const tokens = {
    getToken: () => Promise.resolve(A(TOKEN)),
    invalidate: () => undefined,
  };
  const client = new SkydropxQuotationClient(CONFIG, tokens);
  await expect(client.create(PAYLOAD)).resolves.toEqual(created());
  const config = spy.mock.calls[0][0];
  expect(config).toMatchObject({
    method: 'POST',
    url: 'https://api-pro.skydropx.com/api/v1/quotations',
    timeout: 5_000,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    data: PAYLOAD,
  });
  expect(config.validateStatus?.(500)).toBe(true);
  spy.mockRestore();
});
it('fails closed on malformed or hostile 201 payloads and strips extras', async () => {
  // prettier-ignore
  const bad: unknown[] = [
    'nope', [], null, {}, { is_completed: false }, { id: '', is_completed: false },
    { id: '   ', is_completed: false }, { id: ' q ', is_completed: false },
    { id: 'q'.repeat(129), is_completed: false }, { id: 1, is_completed: false },
    { id: 'q', is_completed: 'true' }, { id: 'q' },
    hostile({ id: 'q', is_completed: false }, 'id'),
    hostile({ id: 'q', is_completed: false }, 'is_completed'),
    Object.create({ id: 'q', is_completed: false }),
  ];
  for (const data of bad) await expect(run([ok(data)])).resolves.toEqual(mal);
  const id = 'q'.repeat(128);
  const extra = { id, is_completed: true, quotation_scope: BODY };
  await expect(run([ok(extra)])).resolves.toEqual(created(id));
});
it('maps every status, abort, and ambiguous outcome without replaying', async () => {
  // prettier-ignore
  const cases: Array<[Script, unknown]> = [
    [[r(400)], ireq], [[r(422)], ireq], [[r(403)], auth], [[r(200)], mal],
    [[r(204)], mal], [[r(404)], mal], [[r(0)], mal], [[r(600)], mal], [[r(Number.NaN)], mal],
    [[r('201')], mal], [[hostile(r(201), 'status')], mal], [[hostile(r(201), 'data')], mal],
    [[r(500)], up(500)], [[r(503)], up(503)],
    [[r(429, { 'retry-after': '30' })], rate(30)], [[r(429, { 'Retry-After': '45' })], rate(45)],
    [[r(429, { 'retry-after': 'soon' })], rate(null)], [[r(429)], rate(null)],
    [[r(429, hostile({}, 'retry-after'))], rate(null)],
    [[fail('ECONNABORTED')], timeout], [[fail('ETIMEDOUT')], timeout],
    [[fail('ERR_CANCELED')], timeout], [[{ name: 'AbortError' }], timeout],
    [[fail('ECONNREFUSED')], up(null)],
  ];
  for (const [script, expected] of cases) {
    const h = make(script);
    await expect(h.client.create(PAYLOAD)).resolves.toEqual(expected);
    expect(h.calls).toHaveLength(1);
    expect(h.getToken).toHaveBeenCalledTimes(1);
    expect(h.invalidate).not.toHaveBeenCalled();
  }
});
it('recovers once from a first 401 and replays the exact payload', async () => {
  const h = make([r(401), ok()], [A(TOKEN), A('tok-2')]);
  await expect(h.client.create(PAYLOAD)).resolves.toEqual(created());
  expect(h.invalidate).toHaveBeenCalledTimes(1);
  expect(h.invalidate).toHaveBeenCalledWith(TOKEN);
  expect(h.getToken).toHaveBeenCalledTimes(2);
  expect(h.calls).toHaveLength(2);
  expect(h.calls[0].data).toBe(PAYLOAD);
  expect(h.calls[1].data).toBe(PAYLOAD);
  expect(h.calls[0].headers).toMatchObject({
    authorization: `Bearer ${TOKEN}`,
  });
  expect(h.calls[1].headers).toMatchObject({ authorization: 'Bearer tok-2' });
});
it('fails closed on a second 401 without a third acquisition or POST', async () => {
  const h = make([r(401), r(401)], [A(TOKEN), A('tok-2')]);
  await expect(h.client.create(PAYLOAD)).resolves.toEqual(auth);
  expect(h.invalidate).toHaveBeenCalledTimes(1);
  expect(h.invalidate).toHaveBeenCalledWith(TOKEN);
  expect(h.getToken).toHaveBeenCalledTimes(2);
  expect(h.calls).toHaveLength(2);
});
it('never refreshes or retries a 403', async () => {
  for (const script of [[r(403)], [r(401), r(403)]]) {
    const h = make(script);
    await expect(h.client.create(PAYLOAD)).resolves.toEqual(auth);
    expect(h.invalidate).toHaveBeenCalledTimes(script.length - 1);
    expect(h.getToken).toHaveBeenCalledTimes(script.length);
    expect(h.calls).toHaveLength(script.length);
  }
});
it('returns a finite refreshed-token error without a second POST', async () => {
  // prettier-ignore
  const errors: ShippingQuoteError[] = [
    { kind: 'rate_limited', retryAfterSeconds: 7 }, { kind: 'provider_disabled' },
    { kind: 'upstream_unavailable', httpStatus: 503 },
  ];
  for (const error of errors) {
    const h = make([r(401), ok()], [A(TOKEN), { kind: 'error', error }]);
    // prettier-ignore
    await expect(h.client.create(PAYLOAD)).resolves.toEqual(e(error.kind, error));
    expect(h.invalidate).toHaveBeenCalledWith(TOKEN);
    expect(h.getToken).toHaveBeenCalledTimes(2);
    expect(h.calls).toHaveLength(1);
  }
});
it('fails closed on a malformed refreshed token before the second POST', async () => {
  // prettier-ignore
  const bad = [
    { kind: 'token', accessToken: ' tok' }, { kind: 'token', accessToken: '' },
    { kind: 'token', accessToken: 1 }, { kind: 'bogus' },
  ];
  for (const value of bad) {
    const h = make([r(401), ok()], [A(TOKEN), value as SkydropxTokenResult]);
    await expect(h.client.create(PAYLOAD)).resolves.toEqual(mal);
    expect(h.invalidate).toHaveBeenCalledWith(TOKEN);
    expect(h.getToken).toHaveBeenCalledTimes(2);
    expect(h.calls).toHaveLength(1);
  }
});
it('fails closed without replaying when invalidate throws or is hostile', async () => {
  const boom = (): void => {
    throw new Error(BODY);
  };
  const thrower = {
    getToken: () => Promise.resolve(A(TOKEN)),
    invalidate: boom,
  };
  const h1 = make([r(401), ok()], undefined, thrower);
  await expect(h1.client.create(PAYLOAD)).resolves.toEqual(mal);
  expect(h1.calls).toHaveLength(1);
  const hostileInv = {
    getToken: () => Promise.resolve(A(TOKEN)),
    invalidate: (): void => undefined,
  };
  Object.defineProperty(hostileInv, 'invalidate', {
    get: () => {
      throw new Error(BODY);
    },
  });
  const h2 = make([r(401), ok()], undefined, hostileInv);
  await expect(h2.client.create(PAYLOAD)).resolves.toEqual(mal);
  expect(h2.calls).toHaveLength(1);
});
it('fails closed when the refreshed token acquisition throws', async () => {
  let n = 0;
  const source = {
    getToken: () => {
      n += 1;
      return n === 1
        ? Promise.resolve(A(TOKEN))
        : Promise.reject(new Error(BODY));
    },
    invalidate: () => undefined,
  };
  const h = make([r(401), ok()], undefined, source);
  const result = await h.client.create(PAYLOAD);
  expect(result).toEqual(mal);
  expect(h.calls).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(BODY);
});
it('fails closed when invalidate returns a rejected promise', async () => {
  const source = {
    getToken: jest.fn(() => Promise.resolve(A(TOKEN))),
    invalidate: jest.fn(() => Promise.reject(new Error(BODY))),
  };
  const h = make([r(401), ok()], undefined, source);
  const result = await h.client.create(PAYLOAD);
  expect(result).toEqual(mal);
  expect(source.getToken).toHaveBeenCalledTimes(1);
  expect(h.calls).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(BODY);
});
it('waits for a deferred invalidation before refreshing and replaying', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = {
    getToken: jest.fn(() => Promise.resolve(A(TOKEN))),
    invalidate: jest.fn(() => gate),
  };
  const h = make([r(401), ok()], undefined, source);
  const pending = h.client.create(PAYLOAD);
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
  expect(source.invalidate).toHaveBeenCalledWith(TOKEN);
  expect(source.getToken).toHaveBeenCalledTimes(1);
  expect(h.calls).toHaveLength(1);
  release();
  await expect(pending).resolves.toEqual(created());
  expect(source.getToken).toHaveBeenCalledTimes(2);
  expect(h.calls).toHaveLength(2);
  expect(h.calls[0].data).toBe(PAYLOAD);
  expect(h.calls[1].data).toBe(PAYLOAD);
});
it('returns token errors unchanged and fails closed on hostile tokens', async () => {
  // prettier-ignore
  const errs: ShippingQuoteError[] = [{ kind: 'provider_disabled' }, { kind: 'rate_limited', retryAfterSeconds: 7 }, { kind: 'auth_failed' }];
  for (const error of errs) {
    const h = make([ok()], [{ kind: 'error', error }]);
    // prettier-ignore
    await expect(h.client.create(PAYLOAD)).resolves.toEqual(e(error.kind, error));
    expect(h.calls).toHaveLength(0);
  }
  // prettier-ignore
  const boom = (): never => { throw new Error(BODY); };
  const rejects = (): Promise<SkydropxTokenResult> =>
    Promise.reject(new Error(BODY));
  // prettier-ignore
  const overrides: SkydropxQuotationTokenSource[] = [
    { getToken: boom, invalidate: () => undefined }, { getToken: rejects, invalidate: () => undefined }, { getToken: () => Promise.resolve(hostileToken('kind')), invalidate: () => undefined },
    { getToken: () => Promise.resolve(hostileToken('accessToken')), invalidate: () => undefined }, { getToken: () => Promise.resolve(hostileErr()), invalidate: () => undefined },
  ];
  // prettier-ignore
  const tokens: unknown[] = [
    'nope', null, {}, { kind: 'token' }, { kind: 'token', accessToken: 1 },
    { kind: 'token', accessToken: '' }, { kind: 'token', accessToken: 'x'.repeat(4097) },
    { kind: 'token', accessToken: ' tok' }, { kind: 'token', accessToken: 'tok ' },
    { kind: 'token', accessToken: 'to k' }, { kind: 'token', accessToken: 'tok\r\nX: y' },
    { kind: 'token', accessToken: 'tok\t' }, { kind: 'token', accessToken: 'tok\u0000' },
    { kind: 'token', accessToken: 'tok\u007f' }, { kind: 'token', accessToken: 'toké' },
    { kind: 'token', accessToken: 'tok=tok' }, { kind: 'token', accessToken: '=tok' },
    { kind: 'token', accessToken: 'tok,' }, { kind: 'bogus' },
  ];
  // prettier-ignore
  const good = ['abc', 'a-b.c_d~e+f/g==', 'A1==', 'z'.repeat(4096)];
  for (const accessToken of good) {
    const h = make([ok()], [A(accessToken)]);
    await expect(h.client.create(PAYLOAD)).resolves.toEqual(created());
    expect(h.calls).toHaveLength(1);
  }
  const results: unknown[] = [];
  for (const o of overrides)
    results.push(await make([ok()], undefined, o).client.create(PAYLOAD));
  for (const value of tokens) {
    const h = make([ok()], [value as SkydropxTokenResult]);
    results.push(await h.client.create(PAYLOAD));
    expect(h.calls).toHaveLength(0);
  }
  for (const result of results) {
    expect(result).toEqual(mal);
    expect(JSON.stringify(result)).not.toContain(BODY);
  }
});
it('never leaks tokens, payload values, provider text, or thrown text', async () => {
  // prettier-ignore
  const results: unknown[] = [
    await run([ok({ id: 'q-1', is_completed: true, extra: BODY })]), await run([ok(hostile({}, 'id'))]),
    await run([r(429, { 'retry-after': BODY })]), await run([r(500, {}, { body: BODY })]), await run([fail('ECONNREFUSED')]),
  ];
  expect(results[0]).toEqual(created());
  for (const result of results) {
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(BODY);
  }
});
