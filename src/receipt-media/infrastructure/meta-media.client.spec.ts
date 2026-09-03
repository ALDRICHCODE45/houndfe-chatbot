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

const LEAKY = /facebook|8\.8\.8\.8|media-123|sentinel/i;

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
