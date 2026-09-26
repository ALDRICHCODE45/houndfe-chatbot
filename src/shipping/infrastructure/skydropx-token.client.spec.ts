/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- tests deliberately reject with non-Error abort/hostile shapes */
import axios, { type AxiosRequestConfig } from 'axios';
import {
  defaultSkydropxHttp,
  SkydropxTokenClient,
  type SkydropxHttp,
  type SkydropxHttpResponse,
  type SkydropxTokenResult,
} from './skydropx-token.client';
const SECRET = 'SECRET_SENTINEL_9f';
const BODY = 'BODY_SENTINEL_7a';
const CONFIG = {
  baseUrl: 'https://api-pro.skydropx.com/',
  clientId: 'client-id',
  clientSecret: SECRET,
  timeoutMs: 5_000,
} as const;
const b = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'tok-1',
  token_type: 'Bearer',
  expires_in: 3_600,
  ...o,
});
const ok = (data: unknown = b()): SkydropxHttpResponse => ({
  status: 200,
  data,
});
const r = (s: unknown, headers?: unknown): SkydropxHttpResponse => ({
  status: s as number,
  data: {},
  headers,
});
const fail = (code: string): Error => Object.assign(new Error(BODY), { code });
const err = (e: unknown) => ({ kind: 'error', error: e });
const tok = { kind: 'token', accessToken: 'tok-1' };
const mal = err({ kind: 'malformed_response' });
const up = (s: number | null) =>
  err({ kind: 'upstream_unavailable', httpStatus: s });
const hostile = <T extends object>(base: T, field: string): T =>
  Object.defineProperty(base, field, {
    get: () => {
      throw new Error(BODY);
    },
  });
const exhaust429 = [
  r(429, { 'Retry-After': '45' }),
  r(429, { 'retry-after': '60' }),
];
const badAfter429 = [r(429, { 'retry-after': 'soon' }), r(429)];
type Script = Array<SkydropxHttpResponse | Error | { name: string }>;
const reject = (v: Script[number]): boolean =>
  v instanceof Error || (v as { name?: unknown }).name === 'AbortError';
const make = (script: Script) => {
  const calls: AxiosRequestConfig[] = [];
  let i = 0;
  const http: SkydropxHttp = (c: AxiosRequestConfig) => {
    calls.push(c);
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return reject(next)
      ? Promise.reject(next)
      : Promise.resolve(next as SkydropxHttpResponse);
  };
  const sleep = jest.fn(async () => undefined);
  const client = new SkydropxTokenClient(CONFIG, {
    http,
    now: () => 0,
    sleep,
  });
  return { client, calls, sleep };
};
const bad: unknown[] = [
  'nope',
  [],
  null,
  {},
  hostile({}, 'access_token'),
  b({ access_token: '   ' }),
  b({ access_token: ' t ' }),
  b({ access_token: 'x'.repeat(4097) }),
  b({ token_type: 'bearer' }),
  { access_token: 't', expires_in: 1 },
  { access_token: 't', token_type: 'Bearer' },
  b({ expires_in: 0 }),
  b({ expires_in: -1 }),
  b({ expires_in: 1.5 }),
  b({ expires_in: 9_007_199_254_741 }),
];
const cases: Array<[Script, unknown, number, number]> = [
  [[r(400)], err({ kind: 'auth_failed' }), 1, 0],
  [[r(401)], err({ kind: 'auth_failed' }), 1, 0],
  [[r(403)], err({ kind: 'auth_failed' }), 1, 0],
  [[r(404)], mal, 1, 0],
  [[r(0)], mal, 1, 0],
  [[r(1000)], mal, 1, 0],
  [[r(Number.NaN)], mal, 1, 0],
  [[r('200')], mal, 1, 0],
  [[r(1.5)], mal, 1, 0],
  [[r(Infinity)], mal, 1, 0],
  [[r(Number.MAX_SAFE_INTEGER)], mal, 1, 0],
  [[r(Symbol('s'))], mal, 1, 0],
  [[hostile({ status: 0, data: {} }, 'status')], mal, 1, 0],
  [[r(500)], up(500), 2, 1],
  [[r(502)], up(502), 2, 1],
  [[fail('ECONNABORTED')], err({ kind: 'timeout' }), 1, 0],
  [[fail('ERR_CANCELED')], err({ kind: 'timeout' }), 1, 0],
  [[{ name: 'AbortError' }], err({ kind: 'timeout' }), 1, 0],
  [[r(429, { 'retry-after': '30' }), ok()], tok, 2, 1],
  [exhaust429, err({ kind: 'rate_limited', retryAfterSeconds: 60 }), 2, 1],
  [badAfter429, err({ kind: 'rate_limited', retryAfterSeconds: null }), 2, 1],
  [[r(503), ok()], tok, 2, 1],
  [[fail('ECONNREFUSED'), ok()], tok, 2, 1],
  [[fail('ECONNREFUSED')], up(null), 2, 1],
  [[ok(b({ expires_in: 9_007_199_254_740 }))], tok, 1, 0],
];
it('posts the official client_credentials form with a bounded timeout', async () => {
  const h = make([ok()]);
  await h.client.getToken();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({
    method: 'POST',
    url: 'https://api-pro.skydropx.com/api/v1/oauth/token',
    timeout: 5_000,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(String(h.calls[0].data)).toBe(
    'client_id=client-id&client_secret=SECRET_SENTINEL_9f&grant_type=client_credentials',
  );
});
it('fails closed on every unknown payload', async () => {
  for (const data of bad) {
    const h = make([ok(data)]);
    await expect(h.client.getToken()).resolves.toEqual(mal);
    expect(h.calls).toHaveLength(1);
  }
});
it('maps every status, abort, and retry outcome', async () => {
  for (const [script, expected, calls, sleeps] of cases) {
    const h = make(script);
    await expect(h.client.getToken()).resolves.toEqual(expected);
    expect(h.calls).toHaveLength(calls);
    expect(h.sleep).toHaveBeenCalledTimes(sleeps);
  }
});
it('fails closed on hostile transport rejections without leaking', async () => {
  for (const field of ['code', 'name']) {
    const result = await new SkydropxTokenClient(CONFIG, {
      http: () => Promise.reject(hostile({}, field)),
    }).getToken();
    expect(result).toEqual(up(null));
    expect(JSON.stringify(result)).not.toContain(BODY);
  }
});
it('fails closed on a throwing or malformed clock instead of throwing', async () => {
  let nowMs = 0;
  let boom = false;
  const client = new SkydropxTokenClient(CONFIG, {
    http: () => Promise.resolve(ok()),
    now: () => {
      if (boom) throw new Error(BODY);
      return nowMs;
    },
  });
  await expect(client.getToken()).resolves.toEqual(tok);
  for (const value of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    nowMs = value;
    await expect(client.getToken()).resolves.toEqual(mal);
  }
  boom = true;
  const thrown = await client.getToken();
  expect(thrown).toEqual(mal);
  expect(JSON.stringify(thrown)).not.toContain(BODY);
});
it('tolerates a throwing sleep seam and still retries', async () => {
  const h = make([]);
  const client = new SkydropxTokenClient(CONFIG, {
    http: (c: AxiosRequestConfig) => {
      h.calls.push(c);
      return h.calls.length === 1
        ? Promise.reject(fail('ECONNREFUSED'))
        : Promise.resolve(ok());
    },
    sleep: () => {
      throw new Error(BODY);
    },
  });
  await expect(client.getToken()).resolves.toEqual(tok);
  expect(h.calls).toHaveLength(2);
});
it('never leaks credentials, provider text, thrown text, or config errors', async () => {
  const boom = (): never => {
    throw new Error(BODY);
  };
  const results = [
    await make([ok(b({ extra: BODY, client_secret: BODY }))]).client.getToken(),
    await make([ok({ [BODY]: BODY })]).client.getToken(),
    await make([fail('ECONNREFUSED')]).client.getToken(),
    await new SkydropxTokenClient(
      { ...CONFIG, clientSecret: '', baseUrl: '' },
      { http: boom },
    ).getToken(),
  ];
  expect(results[1]).toEqual(mal);
  expect(results[3]).toEqual(err({ kind: 'provider_disabled' }));
  for (const value of results) {
    const text = JSON.stringify(value);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(BODY);
  }
});
it('default transport resolves non-2xx via always-true validateStatus', async () => {
  const spy = jest.spyOn(axios, 'request');
  spy.mockResolvedValueOnce({ status: 500, data: {} });
  const res = await defaultSkydropxHttp({});
  const vs = spy.mock.calls[0][0].validateStatus;
  expect([vs?.(404), vs?.(500)]).toEqual([true, true]);
  expect(res.status).toBe(500);
  spy.mockRestore();
});
/* SQ-3A2 token cache, single-flight, and token-aware invalidation (mocked HTTP only). */
const at = (accessToken: string) => ({ kind: 'token', accessToken });
const cacheClient = (script: Script, now: () => number) => {
  const calls: AxiosRequestConfig[] = [];
  let i = 0;
  const http: SkydropxHttp = (c) => {
    calls.push(c);
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return reject(next)
      ? Promise.reject(next)
      : Promise.resolve(next as SkydropxHttpResponse);
  };
  const sleep = jest.fn(async () => undefined);
  const client = new SkydropxTokenClient(CONFIG, { http, now, sleep });
  return { client, calls, sleep };
};
const gate = () => {
  let settle!: (value: SkydropxHttpResponse) => void;
  const promise = new Promise<SkydropxHttpResponse>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};
it('reuses a cached token with zero HTTP calls and zero sleeps', async () => {
  const h = make([ok()]);
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  expect(h.calls).toHaveLength(1);
  expect(h.sleep).toHaveBeenCalledTimes(0);
});
it('reuses only strictly before expiry minus the 30s skew and refreshes at the boundary', async () => {
  let clock = 0;
  const h = cacheClient([ok(b({ expires_in: 31 }))], () => clock);
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  clock = 999;
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  expect(h.calls).toHaveLength(1);
  clock = 1_000;
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  expect(h.calls).toHaveLength(2);
  clock = 1_999;
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  expect(h.calls).toHaveLength(2);
  clock = 2_000;
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  expect(h.calls).toHaveLength(3);
});
it('never reuses a token whose lifetime does not exceed the skew', async () => {
  for (const expires of [1, 30]) {
    const h = cacheClient([ok(b({ expires_in: expires }))], () => 0);
    await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
    await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
    expect(h.calls).toHaveLength(2);
  }
});
it('fails closed without HTTP when the clock is invalid during a cache lookup', async () => {
  let clock = 0;
  let boom = false;
  const h = cacheClient([ok()], () => {
    if (boom) throw new Error(BODY);
    return clock;
  });
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  for (const value of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    clock = value;
    await expect(h.client.getToken()).resolves.toEqual(mal);
  }
  boom = true;
  const thrown = await h.client.getToken();
  expect(thrown).toEqual(mal);
  expect(JSON.stringify(thrown)).not.toContain(BODY);
  expect(h.calls).toHaveLength(1);
});
it('clears the cache only when the exact current token is invalidated', async () => {
  const h = make([
    ok(b({ access_token: 'tok-1' })),
    ok(b({ access_token: 'tok-2' })),
  ]);
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  h.client.invalidate('other');
  h.client.invalidate('tok-1');
  await expect(h.client.getToken()).resolves.toEqual(at('tok-2'));
  expect(h.calls).toHaveLength(2);
});
it('does not let an older token invalidate a newer cached token', async () => {
  let clock = 0;
  const h = cacheClient(
    [
      ok(b({ access_token: 'tok-1', expires_in: 31 })),
      ok(b({ access_token: 'tok-2', expires_in: 31 })),
    ],
    () => clock,
  );
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  clock = 1_000;
  await expect(h.client.getToken()).resolves.toEqual(at('tok-2'));
  expect(h.calls).toHaveLength(2);
  h.client.invalidate('tok-1');
  clock = 1_001;
  await expect(h.client.getToken()).resolves.toEqual(at('tok-2'));
  expect(h.calls).toHaveLength(2);
  h.client.invalidate('tok-2');
  await expect(h.client.getToken()).resolves.toEqual(at('tok-2'));
  expect(h.calls).toHaveLength(3);
});
it('does not cache errors and reacquires on the next call', async () => {
  const h = make([r(400), ok()]);
  await expect(h.client.getToken()).resolves.toEqual(
    err({ kind: 'auth_failed' }),
  );
  await expect(h.client.getToken()).resolves.toEqual(at('tok-1'));
  expect(h.calls).toHaveLength(2);
});
it('single-flight shares one acquisition across concurrent callers', async () => {
  const gates: Array<ReturnType<typeof gate>> = [];
  const sleep = jest.fn(async () => undefined);
  const client = new SkydropxTokenClient(CONFIG, {
    http: () => {
      const g = gate();
      gates.push(g);
      return g.promise;
    },
    now: () => 0,
    sleep,
  });
  const p1 = client.getToken();
  const p2 = client.getToken();
  const p3 = client.getToken();
  expect(gates).toHaveLength(1);
  gates[0].settle(ok());
  await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
    at('tok-1'),
    at('tok-1'),
    at('tok-1'),
  ]);
  expect(sleep).toHaveBeenCalledTimes(0);
});
it('single-flight shares the bounded retry sequence across concurrent callers', async () => {
  const gates: Array<ReturnType<typeof gate>> = [];
  const sleep = jest.fn(async () => undefined);
  const client = new SkydropxTokenClient(CONFIG, {
    http: () => {
      const g = gate();
      gates.push(g);
      return g.promise;
    },
    now: () => 0,
    sleep,
  });
  const p1 = client.getToken();
  const p2 = client.getToken();
  expect(gates).toHaveLength(1);
  gates[0].settle(r(500));
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
  expect(gates).toHaveLength(2);
  gates[1].settle(ok());
  await expect(Promise.all([p1, p2])).resolves.toEqual([
    at('tok-1'),
    at('tok-1'),
  ]);
  expect(sleep).toHaveBeenCalledTimes(1);
});
it('clears the in-flight slot on rejection without leaking the error', async () => {
  const calls: AxiosRequestConfig[] = [];
  const client = new SkydropxTokenClient(CONFIG, {
    http: (c) => {
      calls.push(c);
      return Promise.resolve(ok());
    },
    now: () => 0,
    sleep: jest.fn(async () => undefined),
  });
  const internal = client as unknown as {
    acquire: () => Promise<SkydropxTokenResult>;
  };
  jest.spyOn(internal, 'acquire').mockRejectedValueOnce(new Error(BODY));
  const first = await client.getToken();
  expect(first).toEqual(up(null));
  expect(JSON.stringify(first)).not.toContain(BODY);
  await expect(client.getToken()).resolves.toEqual(at('tok-1'));
  expect(calls).toHaveLength(1);
});
it('shares one acquisition when the transport synchronously re-enters getToken', async () => {
  const calls: AxiosRequestConfig[] = [];
  let reentered = false;
  let reentrant: Promise<SkydropxTokenResult> | null = null;
  const client: SkydropxTokenClient = new SkydropxTokenClient(CONFIG, {
    http: (c) => {
      calls.push(c);
      if (!reentered) {
        reentered = true;
        reentrant = client.getToken();
      }
      return Promise.resolve(ok());
    },
    now: () => 0,
    sleep: jest.fn(async () => undefined),
  });
  await expect(client.getToken()).resolves.toEqual(at('tok-1'));
  expect(calls).toHaveLength(1);
  await expect(reentrant).resolves.toEqual(at('tok-1'));
});
it('does not repopulate the cache when the current token is invalidated mid-refresh', async () => {
  const gates: Array<ReturnType<typeof gate>> = [];
  let clock = 0;
  const client = new SkydropxTokenClient(CONFIG, {
    http: () => {
      const g = gate();
      gates.push(g);
      return g.promise;
    },
    now: () => clock,
    sleep: jest.fn(async () => undefined),
  });
  const priming = client.getToken();
  expect(gates).toHaveLength(1);
  gates[0].settle(ok(b({ access_token: 'tok-1', expires_in: 31 })));
  await expect(priming).resolves.toEqual(at('tok-1'));
  clock = 1_000;
  const refresh = client.getToken();
  expect(gates).toHaveLength(2);
  client.invalidate('tok-1');
  gates[1].settle(ok(b({ access_token: 'tok-1', expires_in: 31 })));
  await expect(refresh).resolves.toEqual(at('tok-1'));
  clock = 1_001;
  const next = client.getToken();
  expect(gates).toHaveLength(3);
  gates[2].settle(ok(b({ access_token: 'tok-2', expires_in: 31 })));
  await expect(next).resolves.toEqual(at('tok-2'));
});
