/** WU4B1B spec: metadata request composition proofs over the WU4B1A policy. */
import type { Agent } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { AxiosRequestConfig } from 'axios';
import {
  MetaMediaError,
  type MetaMediaRequest,
} from '../domain/meta-media.port';
import { pinnedLookup } from './meta-media-origin.policy';
import {
  MetaMediaClient,
  defaultAgentFactory,
  type MetaHttp,
} from './meta-media.client';

const BASE = 'https://graph.facebook.com/v23.0';
const HOST = 'graph.facebook.com';
const TOKEN = 'bearer-sentinel-7f3a9c';
const DOWNLOAD_URL = 'https://lookaside.fbsbx.com/dl';
const PINNED = [{ address: '8.8.8.8', family: 4 as const }];
const publicDns = () => Promise.resolve(PINNED);

function makeClient(options: {
  status?: number;
  data?: unknown;
  httpError?: unknown;
  resolve?: () => Promise<LookupAddress[]>;
}) {
  const calls: AxiosRequestConfig[] = [];
  const http: MetaHttp = (config) => {
    calls.push(config);
    if (options.httpError !== undefined)
      // Intentional: the client must also map non-Error rejections safely.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.httpError);
    const body =
      options.data === undefined ? { url: DOWNLOAD_URL } : options.data;
    return Promise.resolve({ status: options.status ?? 200, data: body });
  };
  const token = jest.fn(() => TOKEN);
  const destroy = jest.fn();
  const agent = { destroy } as unknown as Agent;
  const createAgent = jest.fn<Agent, [LookupFunction]>(() => agent);
  const client = new MetaMediaClient(
    {
      graphApiBaseUrl: BASE,
      allowedHosts: [HOST],
      metadataTimeoutMs: 5000,
      downloadTimeoutMs: 20000,
    },
    token,
    { http, resolve: options.resolve ?? publicDns, createAgent },
  );
  return { client, calls, token, destroy, agent, createAgent };
}

const req = (providerMediaId = 'media-123'): MetaMediaRequest => ({
  providerMediaId,
  declaredMimeType: 'image/jpeg',
  signal: new AbortController().signal,
});

const LEAKY = /facebook|8\.8\.8\.8|media-123|sentinel|attacker/i;

const safeError = async (promise: Promise<unknown>, code: string) => {
  const err: unknown = await promise.catch((error: unknown) => error);
  expect(err).toBeInstanceOf(MetaMediaError);
  expect(err).toMatchObject({
    category: 'META_TRANSPORT',
    code,
    message: `receipt-media:META_TRANSPORT/${code}`,
  });
  expect(JSON.stringify(err)).not.toMatch(LEAKY);
};

/** Shared rejection proof: one composed hop, the fixed safe error, and agent
 *  teardown on every non-success disposition. */
const expectRejection = async (status: number, code: string, data: unknown) => {
  const { client, calls, destroy, token } = makeClient({ status, data });
  await safeError(client.resolveDownloadUrl(req()), code);
  expect(calls).toHaveLength(1);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(token).toHaveBeenCalledTimes(1);
};

describe('MetaMediaClient.resolveDownloadUrl', () => {
  it('issues one composed metadata GET hop per call with pinned transport defaults', async () => {
    const { client, calls, destroy } = makeClient({});
    const request = req();
    await expect(client.resolveDownloadUrl(request)).resolves.toBe(
      DOWNLOAD_URL,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/media-123`,
      proxy: false,
      maxRedirects: 0,
      timeout: 5000,
      signal: request.signal,
    });
    expect(destroy).toHaveBeenCalledTimes(1);

    await client.resolveDownloadUrl(req('a b/c?d#e'));
    expect(calls[1].url).toBe(`${BASE}/a%20b%2Fc%3Fd%23e`);
  });

  it('creates no bearer header before origin and address policy pass', async () => {
    const blank = makeClient({});
    await safeError(
      blank.client.resolveDownloadUrl(req('  ')),
      'NETWORK_FAILURE',
    );
    expect(blank.token).not.toHaveBeenCalled();
    expect(blank.calls).toHaveLength(0);
    for (const resolve of [
      () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
      () => Promise.reject(new Error('resolver down')),
    ] as const) {
      const { client, calls, token } = makeClient({ resolve });
      await safeError(client.resolveDownloadUrl(req()), 'NETWORK_FAILURE');
      expect(token).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    }
  });

  it('pins the hop agent to the validated addresses and passes it to Axios', async () => {
    const { client, calls, agent, createAgent } = makeClient({});
    await client.resolveDownloadUrl(req());
    const lookup = createAgent.mock.calls[0][0];
    lookup(HOST, {}, (err, address) => {
      expect(err).toBeNull();
      expect(address).toBe('8.8.8.8');
    });
    lookup('rebind.attacker.example', {}, (err) => {
      expect(err).not.toBeNull();
    });
    expect(calls[0].httpsAgent).toBe(agent);
  });

  it.each([302, 304, 307, 308, 400, 401, 403, 404, 409, 428, 499])(
    'rejects permanent unfollowed status %i with the fixed safe error',
    (status) => expectRejection(status, 'HTTP_PERMANENT', { error: 'nope' }),
  );

  it.each([408, 429, 500, 502, 503, 504])(
    'rejects retryable HTTP status %i with the fixed safe error',
    (status) => expectRejection(status, 'HTTP_RETRYABLE', { error: 'nope' }),
  );

  it.each([null, 'plain', 42, {}, { url: '' }, { url: 5 }, { other: 'x' }])(
    'rejects malformed metadata body %j with the permanent safe error',
    (data) => expectRejection(200, 'HTTP_PERMANENT', data),
  );

  it.each([
    ['ERR_CANCELED', 'ABORTED'],
    ['ECONNABORTED', 'TIMEOUT'],
    ['ECONNREFUSED', 'NETWORK_FAILURE'],
    ['ETIMEDOUT', 'NETWORK_FAILURE'],
    ['socket went away', 'NETWORK_FAILURE'],
  ])(
    'maps transport failure %s to the fixed safe %s error',
    async (code, expected) => {
      const rejections = [code, Object.assign(new Error('boom'), { code })];
      for (const httpError of rejections) {
        const { client, destroy } = makeClient({ httpError });
        await safeError(client.resolveDownloadUrl(req()), expected);
        expect(destroy).toHaveBeenCalledTimes(1);
      }
    },
  );
});

describe('defaultAgentFactory', () => {
  it('customizes only the pinned lookup, preserving ordinary TLS hostname verification', () => {
    const lookup = pinnedLookup(HOST, PINNED);
    const agent = defaultAgentFactory(lookup);
    expect(agent.options.lookup).toBe(lookup);
    expect('servername' in agent.options).toBe(false);
    expect('checkServerIdentity' in agent.options).toBe(false);
    agent.destroy();
  });
});

/** WU4B2 download-phase proofs: bounded manual redirects over per-hop
 *  revalidated, repinned, bearer-after-policy transport with a narrow
 *  response/release handoff for the final streaming response. */
describe('MetaMediaClient.downloadStream', () => {
  const LOOKASIDE_HOST = 'lookaside.fbsbx.com';
  // Sentinel final body: B2 passes it through untouched (B3 reads/validates it).
  const STREAM = { piped: false };

  type FakeHop =
    | { status: number; headers?: unknown; data?: unknown }
    | { httpError: unknown };

  interface Handle {
    response: { status: number; data: unknown };
    release: () => void;
  }
  type DownloadStream = (
    request: MetaMediaRequest,
    downloadUrl: string,
  ) => Promise<Handle>;

  const downloadStream = (client: MetaMediaClient): DownloadStream =>
    client.downloadStream.bind(client);

  const redirect = (location: string, status = 302) => ({
    status,
    headers: { location },
  });

  const expectHopDefaults = (call: AxiosRequestConfig, signal: AbortSignal) => {
    expect(call).toMatchObject({
      method: 'GET',
      responseType: 'stream',
      proxy: false,
      maxRedirects: 0,
      timeout: 20000,
      signal,
    });
  };

  function makeDownloadClient(hops: FakeHop[], resolve = publicDns) {
    const calls: AxiosRequestConfig[] = [];
    const http: MetaHttp = (config) => {
      calls.push(config);
      const hop = hops[calls.length - 1];
      if (hop === undefined)
        return Promise.reject(new Error('unexpected additional hop'));
      if ('httpError' in hop) {
        // Intentional: transport rejections need not be Error instances.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(hop.httpError);
      }
      return Promise.resolve({
        status: hop.status,
        headers: hop.headers,
        data: hop.data === undefined ? STREAM : hop.data,
      });
    };
    const token = jest.fn(() => TOKEN);
    const destroyFns: Array<jest.Mock> = [];
    const createAgent = jest.fn<Agent, [LookupFunction]>(() => {
      const destroy = jest.fn();
      destroyFns.push(destroy);
      return { destroy } as unknown as Agent;
    });
    const client = new MetaMediaClient(
      {
        graphApiBaseUrl: BASE,
        allowedHosts: [HOST, LOOKASIDE_HOST],
        metadataTimeoutMs: 5000,
        downloadTimeoutMs: 20000,
      },
      token,
      { http, resolve, createAgent },
    );
    return { client, calls, token, destroyFns, createAgent };
  }

  /** Shared rejection proof: fixed safe error, no follow-up hop, no extra
   *  bearer, and every issued hop's agent destroyed exactly once. */
  const expectRejected = async (
    hops: FakeHop[],
    code: string,
    hopCount = 1,
  ) => {
    const { client, calls, token, destroyFns } = makeDownloadClient(hops);
    await safeError(downloadStream(client)(req(), DOWNLOAD_URL), code);
    expect(calls).toHaveLength(hopCount);
    expect(token).toHaveBeenCalledTimes(hopCount);
    expect(
      destroyFns.slice(0, hopCount).map((destroy) => destroy.mock.calls.length),
    ).toEqual(Array<number>(hopCount).fill(1));
  };

  it('returns the final streaming response on direct 2xx and keeps the agent until an idempotent release', async () => {
    const request = req();
    const { client, calls, token, destroyFns, createAgent } =
      makeDownloadClient([{ status: 200 }]);
    const handle = await downloadStream(client)(request, DOWNLOAD_URL);
    expect(handle.response).toEqual({ status: 200, data: STREAM });
    expect(calls).toHaveLength(1);
    expectHopDefaults(calls[0], request.signal);
    expect(calls[0].url).toBe(DOWNLOAD_URL);
    expect(calls[0].headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(calls[0].httpsAgent).toBe(createAgent.mock.results[0].value);
    expect(token).toHaveBeenCalledTimes(1);
    // The final agent must outlive this call while the stream is consumable.
    expect(destroyFns[0]).not.toHaveBeenCalled();
    handle.release();
    expect(destroyFns[0]).toHaveBeenCalledTimes(1);
    handle.release();
    expect(destroyFns[0]).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Location against the current hop onto a fresh pinned agent', async () => {
    const request = req();
    const { client, calls, destroyFns, createAgent } = makeDownloadClient([
      redirect('/files/abc'),
      { status: 200 },
    ]);
    const handle = await downloadStream(client)(request, DOWNLOAD_URL);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://lookaside.fbsbx.com/files/abc');
    expectHopDefaults(calls[1], request.signal);
    expect(calls[1].httpsAgent).toBe(createAgent.mock.results[1].value);
    expect(calls[1].httpsAgent).not.toBe(calls[0].httpsAgent);
    expect(destroyFns[0]).toHaveBeenCalledTimes(1);
    expect(destroyFns[1]).not.toHaveBeenCalled();
    handle.release();
    expect(destroyFns[1]).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])(
    'manually follows redirect status %i as a new revalidated hop',
    async (status) => {
      const { client, calls } = makeDownloadClient([
        { status, headers: { location: '/next' } },
        { status: 200 },
      ]);
      const handle = await downloadStream(client)(req(), DOWNLOAD_URL);
      expect(handle.response.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe('https://lookaside.fbsbx.com/next');
    },
  );

  it.each([300, 304, 305, 306, 309])(
    'never follows non-manual status %i: one hop, safe permanent rejection',
    (status) => expectRejected([redirect('/next', status)], 'HTTP_PERMANENT'),
  );

  it('follows three redirects (four requests) and rejects a fourth redirect', async () => {
    const three = makeDownloadClient([
      redirect('https://lookaside.fbsbx.com/a'),
      redirect('https://lookaside.fbsbx.com/b'),
      redirect('/c'),
      { status: 200 },
    ]);
    const handle = await downloadStream(three.client)(req(), DOWNLOAD_URL);
    expect(handle.response.status).toBe(200);
    expect(three.calls.map((call) => call.url)).toEqual([
      DOWNLOAD_URL,
      'https://lookaside.fbsbx.com/a',
      'https://lookaside.fbsbx.com/b',
      'https://lookaside.fbsbx.com/c',
    ]);
    expect(
      three.destroyFns.slice(0, 3).map((destroy) => destroy.mock.calls.length),
    ).toEqual([1, 1, 1]);
    expect(three.destroyFns[3]).not.toHaveBeenCalled();
    handle.release();
    expect(three.destroyFns[3]).toHaveBeenCalledTimes(1);

    // A fourth redirect is rejected instead of followed (still four requests).
    await expectRejected(
      [redirect('/a'), redirect('/b'), redirect('/c'), redirect('/d')],
      'HTTP_PERMANENT',
      4,
    );
  });

  it.each([
    ['no headers', { status: 302 }],
    ['empty location', { status: 302, headers: { location: '' } }],
    ['non-string location', { status: 302, headers: { location: 42 } }],
    ['unparseable location', { status: 302, headers: { location: 'http://' } }],
  ])('rejects redirect with %s: no follow, no leak', (_label, hop) =>
    expectRejected([hop], 'HTTP_PERMANENT'),
  );

  it('gives a disallowed absolute redirect target no bearer and no request', () =>
    expectRejected(
      [redirect('https://rebind.attacker.example/x')],
      'NETWORK_FAILURE',
    ));

  it('re-resolves the redirect target per hop before its request and bearer', async () => {
    const resolve = jest
      .fn(() => Promise.resolve(PINNED))
      .mockResolvedValueOnce(PINNED)
      .mockRejectedValueOnce(new Error('resolver down'));
    const { client, calls, token } = makeDownloadClient(
      [redirect('/again'), { status: 200 }],
      resolve,
    );
    await safeError(
      downloadStream(client)(req(), DOWNLOAD_URL),
      'NETWORK_FAILURE',
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(token).toHaveBeenCalledTimes(1);
  });

  it('pins every hop lookup to its validated addresses without touching TLS naming', async () => {
    const { client, createAgent } = makeDownloadClient([
      redirect('/pinned'),
      { status: 200 },
    ]);
    await downloadStream(client)(req(), DOWNLOAD_URL);
    expect(createAgent).toHaveBeenCalledTimes(2);
    for (const [lookup] of createAgent.mock.calls) {
      lookup(LOOKASIDE_HOST, {}, (err, address) => {
        expect(err).toBeNull();
        expect(address).toBe('8.8.8.8');
      });
      lookup('rebind.attacker.example', {}, (err) => {
        expect(err).not.toBeNull();
      });
    }
  });

  it.each([
    ['ERR_CANCELED', 'ABORTED'],
    ['ECONNABORTED', 'TIMEOUT'],
    ['ECONNREFUSED', 'NETWORK_FAILURE'],
  ])(
    'maps download transport failure %s to safe %s and tears down',
    (code, expected) =>
      expectRejected(
        [{ httpError: Object.assign(new Error('boom'), { code }) }],
        expected,
      ),
  );

  it('destroys every hop agent when a followed redirect later fails', async () => {
    await expectRejected(
      [redirect('/next'), { httpError: 'ERR_CANCELED' }],
      'ABORTED',
      2,
    );
    await expectRejected(
      [redirect('/next'), { status: 503 }],
      'HTTP_RETRYABLE',
      2,
    );
  });

  it.each([
    [400, 'HTTP_PERMANENT'],
    [404, 'HTTP_PERMANENT'],
    [408, 'HTTP_RETRYABLE'],
    [429, 'HTTP_RETRYABLE'],
    [500, 'HTTP_RETRYABLE'],
  ])('maps non-redirect download status %i to safe %s', (status, expected) =>
    expectRejected([{ status }], expected),
  );
});
