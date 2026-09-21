/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- tests reject with non-Error abort/hostile shapes */
import axios, { type AxiosRequestConfig } from 'axios';
import type { ShippingQuoteError } from '../domain/shipping-quote.error';
import {
  SKYDROPX_QUOTATION_MAX_RATES,
  SKYDROPX_QUOTATION_POLL_INTERVAL_MS,
  SKYDROPX_QUOTATION_POLL_MAX_ATTEMPTS,
  SkydropxQuotationClient,
  type SkydropxQuotationClientConfig,
  type SkydropxQuotationPayload,
  type SkydropxQuotationPollResult,
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
  sleep: (milliseconds: number) => Promise<void> = jest.fn(() =>
    Promise.resolve(),
  ),
  config: SkydropxQuotationClientConfig = CONFIG,
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
  const client = new SkydropxQuotationClient(config, tokens, http, sleep);
  return { client, calls, getToken, invalidate, sleep };
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
const GID = 'q-1';
const g = (data: unknown): SkydropxHttpResponse => ({ status: 200, data });
const inc = (id = GID): SkydropxHttpResponse => g({ id, is_completed: false });
const comp = (rates: unknown, id = GID): SkydropxHttpResponse =>
  g({ id, is_completed: true, rates });
// prettier-ignore
const completed = (providerRates: readonly unknown[], quotationId = GID): SkydropxQuotationPollResult => ({ kind: 'completed', quotationId, providerRates });
// prettier-ignore
const pollErr = (error: ShippingQuoteError): SkydropxQuotationPollResult => ({ kind: 'error', error });
// prettier-ignore
const nameAbort = (): Error => Object.assign(new Error(BODY), { name: 'AbortError' });
// prettier-ignore
const throwSleep = (thrown: Error): jest.Mock => jest.fn((): Promise<void> => { throw thrown; });
// prettier-ignore
const rejectSleep = (thrown: Error): jest.Mock => jest.fn(() => Promise.reject(thrown));
// prettier-ignore
const noSeams = (h: ReturnType<typeof make>) => { expect(h.getToken).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0); expect(h.sleep).not.toHaveBeenCalled(); };
// prettier-ignore
const terminalOnce = (result: unknown, expected: unknown, h: ReturnType<typeof make>) => { expect(result).toEqual(expected); expect(h.calls).toHaveLength(1); expect(h.getToken).toHaveBeenCalledTimes(1); expect(h.invalidate).not.toHaveBeenCalled(); expect(h.sleep).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(BODY); };
// prettier-ignore
const failedOnce = (result: unknown, expected: unknown, h: ReturnType<typeof make>, sleep: jest.Mock) => { expect(result).toEqual(expected); expect(h.calls).toHaveLength(1); expect(sleep).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain(BODY); };
it('rejects invalid poll ids without a token, GET, or sleep', async () => {
  // prettier-ignore
  const bad: unknown[] = [
    '', '   ', ' q-1', 'q-1 ', 'q 1', 'a/b', 'a?b', 'a#b', '../x', '..',
    'a.b', 'a\r\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'aé', 'q'.repeat(129),
    1, null, undefined, {}, ['q-1'],
  ];
  for (const id of bad) {
    const h = make([comp([])]);
    // prettier-ignore
    await expect(h.client.poll(id as string)).resolves.toEqual(pollErr({ kind: 'invalid_request', field: 'unknown' }));
    noSeams(h);
  }
});
it('always performs at least one GET and returns a bounded shallow rate snapshot', async () => {
  const rates = [{ service: 'fedex' }, { service: 'dhl' }];
  const body = { id: GID, is_completed: true, rates, address_to: BODY };
  const h = make([g(body)]);
  const result = await h.client.poll(GID);
  expect(result).toEqual(completed(rates));
  expect(h.getToken).toHaveBeenCalledTimes(1);
  expect(h.calls).toHaveLength(1);
  // prettier-ignore
  expect(h.calls[0]).toMatchObject({ method: 'GET', url: 'https://api-pro.skydropx.com/api/v1/quotations/q-1', timeout: 5_000, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
  expect(h.calls[0].data).toBeUndefined();
  expect(h.sleep).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(BODY);
  // prettier-ignore
  if (result.kind === 'completed') { expect(result.providerRates).not.toBe(rates); expect(result.providerRates[0]).toBe(rates[0]); }
});
it('sleeps once between incomplete attempts until the response completes', async () => {
  const h = make([inc(), inc(), comp([{ a: 1 }])]);
  await expect(h.client.poll(GID)).resolves.toEqual(completed([{ a: 1 }]));
  expect(h.calls).toHaveLength(3);
  // prettier-ignore
  expect((h.sleep as jest.Mock).mock.calls).toEqual([[SKYDROPX_QUOTATION_POLL_INTERVAL_MS], [SKYDROPX_QUOTATION_POLL_INTERVAL_MS]]);
});
it('times out after the bounded attempts without a final sleep', async () => {
  const h = make([inc()]);
  // prettier-ignore
  await expect(h.client.poll(GID)).resolves.toEqual(pollErr({ kind: 'timeout' }));
  expect(h.calls).toHaveLength(SKYDROPX_QUOTATION_POLL_MAX_ATTEMPTS);
  // prettier-ignore
  expect(h.sleep).toHaveBeenCalledTimes(SKYDROPX_QUOTATION_POLL_MAX_ATTEMPTS - 1);
});
it('fails closed immediately when the sleep seam throws or rejects', async () => {
  // prettier-ignore
  const cases: Array<[jest.Mock, unknown]> = [
    [throwSleep(new Error(BODY)), up(null)], [throwSleep(nameAbort()), timeout],
    [throwSleep(fail('ECONNABORTED')), timeout], [rejectSleep(new Error(BODY)), up(null)],
    [rejectSleep(nameAbort()), timeout], [rejectSleep(fail('ETIMEDOUT')), timeout],
  ];
  for (const [sleep, expected] of cases) {
    const h = make([inc(), comp([])], undefined, undefined, sleep);
    const result = await h.client.poll(GID);
    failedOnce(result, expected, h, sleep);
  }
});
it('maps every terminal GET status, abort, and network outcome to one no-sleep error', async () => {
  // prettier-ignore
  const cases: Array<[Script, unknown]> = [
    [[r(400)], ireq], [[r(404)], ireq], [[r(422)], ireq], [[r(401)], auth], [[r(403)], auth],
    [[r(429, { 'retry-after': '30' })], rate(30)], [[r(429, { 'Retry-After': '7' })], rate(7)],
    [[r(429, { 'retry-after': 'soon' })], rate(null)], [[r(429)], rate(null)],
    [[r(500)], up(500)], [[r(503)], up(503)],
    [[r(201)], mal], [[r(204)], mal], [[r(300)], mal], [[r(0)], mal], [[r(600)], mal],
    [[r(Number.NaN)], mal], [[r('200')], mal], [[hostile(r(200, undefined, {}), 'status')], mal],
    [[fail('ECONNREFUSED')], up(null)], [[fail('ECONNABORTED')], timeout],
    [[fail('ETIMEDOUT')], timeout], [[fail('ERR_CANCELED')], timeout], [[{ name: 'AbortError' }], timeout],
  ];
  for (const [script, expected] of cases) {
    const h = make(script);
    const result = await h.client.poll(GID);
    terminalOnce(result, expected, h);
  }
});
it('rejects malformed, mismatched, hostile, sparse, and oversized poll bodies', async () => {
  // prettier-ignore
  const proxy = new Proxy([{ a: 1 }], { get: (target: unknown[], key: string | symbol): unknown => (key === 'length' ? SKYDROPX_QUOTATION_MAX_RATES + 1 : Reflect.get(target, key)) });
  // prettier-ignore
  const bad: unknown[] = [
    'nope', [], null, {}, { id: GID }, { is_completed: true, rates: [] },
    { id: '', is_completed: true, rates: [] }, { id: 'q-2', is_completed: true, rates: [] },
    { id: 'q'.repeat(129), is_completed: true, rates: [] }, { id: GID, is_completed: 'true', rates: [] },
    { id: GID, is_completed: true }, { id: GID, is_completed: true, rates: 'nope' },
    { id: GID, is_completed: true, rates: Object.assign(new Array(3), { 0: { x: 1 } }) }, { id: GID, is_completed: true, rates: new Array(1) },
    { id: GID, is_completed: true, rates: proxy },
    { id: GID, is_completed: true, rates: new Array(SKYDROPX_QUOTATION_MAX_RATES + 1).fill({ a: 1 }) },
    hostile({ id: GID, is_completed: true, rates: [] }, 'id'),
    hostile({ id: GID, is_completed: true, rates: [] }, 'is_completed'),
    hostile({ id: GID, is_completed: true, rates: [] }, 'rates'),
    Object.create({ id: GID, is_completed: true, rates: [] }),
  ];
  for (const data of bad) {
    const h = make([g(data)]);
    await expect(h.client.poll(GID)).resolves.toEqual(mal);
    expect(h.calls).toHaveLength(1);
    expect(h.sleep).not.toHaveBeenCalled();
  }
  // prettier-ignore
  const dense = new Array(SKYDROPX_QUOTATION_MAX_RATES).fill(0).map((_, i) => ({ i }));
  // prettier-ignore
  for (const r of [dense, []]) await expect(make([comp(r)]).client.poll(GID)).resolves.toEqual(completed(r));
});
it('snapshots each rate element exactly once', async () => {
  let reads = 0;
  const rates: unknown[] = [{}];
  // prettier-ignore
  Object.defineProperty(rates, 0, { configurable: true, get: () => { reads += 1; if (reads > 1) throw new Error(BODY); return { once: true }; } });
  const result = await make([comp(rates)]).client.poll(GID);
  expect(reads).toBe(1);
  expect(result).toEqual(completed([{ once: true }]));
});
it('returns token errors unchanged and fails closed on hostile tokens with zero GET', async () => {
  // prettier-ignore
  const errs: ShippingQuoteError[] = [{ kind: 'provider_disabled' }, { kind: 'rate_limited', retryAfterSeconds: 7 }, { kind: 'auth_failed' }];
  for (const error of errs) {
    const h = make([comp([])], [{ kind: 'error', error }]);
    await expect(h.client.poll(GID)).resolves.toEqual(pollErr(error));
    expect(h.calls).toHaveLength(0);
    expect(h.sleep).not.toHaveBeenCalled();
  }
  // prettier-ignore
  const boom = (): never => { throw new Error(BODY); };
  // prettier-ignore
  const rejects = (): Promise<SkydropxTokenResult> => Promise.reject(new Error(BODY));
  // prettier-ignore
  const overrides: SkydropxQuotationTokenSource[] = [
    { getToken: boom, invalidate: () => undefined }, { getToken: rejects, invalidate: () => undefined },
    { getToken: () => Promise.resolve(hostileToken('kind')), invalidate: () => undefined },
    { getToken: () => Promise.resolve(hostileToken('accessToken')), invalidate: () => undefined },
    { getToken: () => Promise.resolve(hostileErr()), invalidate: () => undefined },
  ];
  // prettier-ignore
  const tokens: unknown[] = [
    'nope', null, {}, { kind: 'token' }, { kind: 'token', accessToken: 1 },
    { kind: 'token', accessToken: '' }, { kind: 'token', accessToken: 'x'.repeat(4097) },
    { kind: 'token', accessToken: ' tok' }, { kind: 'token', accessToken: 'tok\u0000' },
    { kind: 'token', accessToken: 'toké' }, { kind: 'bogus' },
  ];
  const results: unknown[] = [];
  for (const o of overrides) {
    const h = make([comp([])], undefined, o);
    results.push(await h.client.poll(GID));
    expect(h.calls).toHaveLength(0);
  }
  for (const value of tokens) {
    const h = make([comp([])], [value as SkydropxTokenResult]);
    results.push(await h.client.poll(GID));
    expect(h.calls).toHaveLength(0);
  }
  for (const result of results) {
    expect(JSON.stringify(result)).toBe(JSON.stringify(mal));
  }
});
it('never leaks tokens, payload, addresses, provider, or thrown text through poll results', async () => {
  const leaked = { kind: 'auth_failed', token: SECRET };
  // prettier-ignore
  const results: unknown[] = [
    await make([g({ id: GID, is_completed: true, rates: [{ service: 'x' }], address_to: BODY })]).client.poll(GID),
    await make([inc(), g({ id: GID, is_completed: true, rates: [] })]).client.poll(GID),
    await make([r(500, {}, { body: BODY })]).client.poll(GID),
    await make([fail('ECONNREFUSED')]).client.poll(GID),
    await make([comp([])], [{ kind: 'error', error: leaked as ShippingQuoteError }]).client.poll(GID),
  ];
  for (const result of results) {
    const text = JSON.stringify(result);
    expect(text.includes(SECRET) || text.includes(BODY)).toBe(false);
  }
});
// prettier-ignore
const mk = (timeoutMs: unknown) => make([comp([])], undefined, undefined, undefined, { baseUrl: CONFIG.baseUrl, timeoutMs: timeoutMs as number });
it('validates the runtime poll timeout before any seam and forwards the exact boundaries', async () => {
  // prettier-ignore
  const bad: unknown[] = [
    0, -1, -0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, 60_001, 60_000.5, '5000', null, undefined, true, {}, [],
    new Number(5_000), { valueOf: () => 5_000 }, { valueOf: () => { throw new Error(BODY); } },
  ];
  for (const timeoutMs of bad) {
    const h = mk(timeoutMs);
    // prettier-ignore
    await expect(h.client.poll(GID)).resolves.toEqual(pollErr({ kind: 'provider_disabled' }));
    noSeams(h);
  }
  // prettier-ignore
  const hostile: SkydropxQuotationClientConfig = Object.defineProperty({ baseUrl: CONFIG.baseUrl }, 'timeoutMs', { get: () => { throw new Error(BODY); } }) as SkydropxQuotationClientConfig;
  const h = make([comp([])], undefined, undefined, undefined, hostile);
  // prettier-ignore
  await expect(h.client.poll(GID)).resolves.toEqual(pollErr({ kind: 'provider_disabled' }));
  noSeams(h);
  for (const timeoutMs of [1, 60_000]) {
    const h = mk(timeoutMs);
    await expect(h.client.poll(GID)).resolves.toEqual(completed([]));
    expect(h.calls.map((c) => c.timeout)).toEqual([timeoutMs]);
  }
});
