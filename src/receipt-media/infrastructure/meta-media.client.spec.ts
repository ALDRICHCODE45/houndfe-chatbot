/** WU4B1B/WU4B2/WU4B3B1b spec: metadata composition, manual-redirect download
 *  transport, and the successful bounded stream/temp-file pipeline proofs. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
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
  defaultTempFileFactory,
  type MetaHttp,
  type MetaTempFileFactory,
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

const req = (
  providerMediaId = 'media-123',
  declaredMimeType = 'image/jpeg', // runtime-invalid values must reject
): MetaMediaRequest => ({
  providerMediaId,
  declaredMimeType: declaredMimeType as MetaMediaRequest['declaredMimeType'],
  signal: new AbortController().signal,
});

const LEAKY = /facebook|8\.8\.8\.8|media-123|sentinel|attacker/i;

const safeError = async (
  promise: Promise<unknown>,
  code: string,
  category = 'META_TRANSPORT',
): Promise<MetaMediaError> => {
  const err: unknown = await promise.catch((error: unknown) => error);
  expect(err).toBeInstanceOf(MetaMediaError);
  expect(err).toMatchObject({
    category,
    code,
    message: `receipt-media:${category}/${code}`,
  });
  expect(JSON.stringify(err)).not.toMatch(LEAKY);
  return err as MetaMediaError;
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

/** WU4B3B1a projection proofs: the infrastructure-local metadata contract
 *  (download URL + canonical MIME + provider-declared bytes) validated on
 *  the metadata body before any download request exists. */
describe('MetaMediaClient.resolveMetadata (WU4B3B1a metadata projection)', () => {
  const bodyWith = (fields: Record<string, unknown>) => {
    const body: Record<string, unknown> = {
      url: DOWNLOAD_URL,
      mime_type: 'image/jpeg',
      file_size: 1234,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete body[key];
      else body[key] = value;
    }
    return body;
  };

  /** Shared projection rejection proof: the fixed safe error, exactly the
   *  expected call/bearer/teardown counts (default: one metadata call and
   *  never a download request), and no detail leakage. The declared MIME
   *  parameter accepts runtime-invalid values on purpose. */
  const expectMetadataRejection = async (
    data: unknown,
    category: 'MEDIA_VALIDATION' | 'META_TRANSPORT',
    code: string,
    declared = 'image/jpeg',
    expectedCalls = 1,
  ) => {
    const { client, calls, destroy, token } = makeClient({ data });
    const err: unknown = await client
      .resolveMetadata(req('media-123', declared))
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(MetaMediaError);
    expect(err).toMatchObject({
      category,
      code,
      message: `receipt-media:${category}/${code}`,
    });
    expect(JSON.stringify(err)).not.toMatch(LEAKY);
    expect(calls).toHaveLength(expectedCalls);
    expect(destroy).toHaveBeenCalledTimes(expectedCalls);
    expect(token).toHaveBeenCalledTimes(expectedCalls);
  };

  it.each([
    ['image/jpeg', 1234],
    ['image/png', 1234],
    ['image/jpeg', 1],
    ['image/png', 10_485_760],
  ])(
    'projects valid %s metadata with providerDeclaredBytes %i',
    async (mime, file_size) => {
      const { client, calls } = makeClient({
        data: bodyWith({ mime_type: mime, file_size }),
      });
      await expect(
        client.resolveMetadata(req('media-123', mime)),
      ).resolves.toEqual({
        downloadUrl: DOWNLOAD_URL,
        mimeType: mime,
        providerDeclaredBytes: file_size,
      });
      expect(calls).toHaveLength(1);
    },
  );

  it('rejects runtime-invalid declared MIME before any bearer or request', () =>
    expectMetadataRejection(
      {},
      'MEDIA_VALIDATION',
      'UNSUPPORTED_MIME',
      'image/webp',
      0,
    ));

  it.each([
    ['missing', { mime_type: undefined }],
    ['unsupported', { mime_type: 'image/webp' }],
    ['non-string', { mime_type: 42 }],
  ])('rejects %s metadata mime_type with UNSUPPORTED_MIME', (_label, fields) =>
    expectMetadataRejection(
      bodyWith(fields),
      'MEDIA_VALIDATION',
      'UNSUPPORTED_MIME',
    ),
  );

  it('rejects declared-vs-provider MIME disagreement with MIME_MISMATCH', () =>
    expectMetadataRejection(
      bodyWith({ mime_type: 'image/png' }),
      'MEDIA_VALIDATION',
      'MIME_MISMATCH',
    ));

  it.each([
    ['missing', { file_size: undefined }],
    ['wrong type', { file_size: '1234' }],
    ['non-integer', { file_size: 1.5 }],
    ['non-safe', { file_size: Number.MAX_SAFE_INTEGER + 1 }],
    ['zero', { file_size: 0 }],
    ['negative', { file_size: -1 }],
    ['one over the limit', { file_size: 10_485_761 }],
  ])(
    'rejects %s provider file_size with INVALID_MEDIA_SIZE',
    (_label, fields) =>
      expectMetadataRejection(
        bodyWith(fields),
        'MEDIA_VALIDATION',
        'INVALID_MEDIA_SIZE',
      ),
  );

  it.each([
    ['missing', { url: undefined }],
    ['empty', { url: '' }],
    ['non-string', { url: 5 }],
  ])(
    'rejects %s download URL with the permanent safe error',
    (_label, fields) =>
      expectMetadataRejection(
        bodyWith(fields),
        'META_TRANSPORT',
        'HTTP_PERMANENT',
      ),
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

/** WU4B3B1b pipeline fixtures: structurally valid minimal images (the PNG is
 *  a precomputed minimal signature/IHDR/IDAT/IEND image). */
const MIN_JPEG = Buffer.from(
  'ffd8ffc0000b080001000101011100ffda000801010000000012ffd9',
  'hex',
);
const MIN_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010800000000' +
    '3a7e9b5500000001494441540028387de80000000049454e44ae426082',
  'hex',
);

const sha256Matches = (file: { sha256: Buffer }, bytes: Buffer) =>
  file.sha256.equals(createHash('sha256').update(bytes).digest());

const META_OK = {
  url: DOWNLOAD_URL,
  mime_type: 'image/jpeg',
  file_size: 4321,
};

const streamOf = (chunks: Buffer[]): Readable => Readable.from(chunks);

const LOOKASIDE_HOST = 'lookaside.fbsbx.com';

type Hop = { data?: unknown; headers?: Record<string, unknown> };

/** Every real temp path created through the pipeline harness across the whole
 *  suite; the describe-level residue guard proves each one is unlinked. */
const CREATED: string[] = [];

/** Pipeline harness: the first call is the single metadata hop, later calls
 *  are stream download hops on the allowed lookaside host. */
function makePipeline(
  options: {
    metadata?: unknown;
    hops?: Hop[];
    createTempFile?: MetaTempFileFactory;
  } = {},
) {
  const calls: AxiosRequestConfig[] = [];
  const created: string[] = [];
  let hopIndex = 0;
  const http: MetaHttp = (config) => {
    calls.push(config);
    // Real Axios behavior mirrored: a pre-aborted signal rejects the hop.
    if (config.signal?.aborted)
      return Promise.reject(
        Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' }),
      );
    if (config.responseType !== 'stream')
      return Promise.resolve({
        status: 200,
        data: options.metadata ?? META_OK,
      });
    const hop = options.hops ? options.hops[hopIndex++] : {};
    if (hop === undefined)
      return Promise.reject(new Error('unexpected additional hop'));
    return Promise.resolve({
      status: 200,
      // Default agreed Content-Type; explicit hop headers may override.
      headers: { 'content-type': 'image/jpeg', ...hop.headers },
      data: hop.data === undefined ? streamOf([MIN_JPEG]) : hop.data,
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
    {
      http,
      resolve: publicDns,
      createAgent,
      createTempFile: async (dir: string) => {
        const file = await (options.createTempFile ?? defaultTempFileFactory)(
          dir,
        );
        created.push(file.filePath);
        CREATED.push(file.filePath);
        return file;
      },
    },
  );
  return { client, calls, token, destroyFns, created };
}

const expectUnlinked = (filePath: string) =>
  expect(fs.promises.stat(filePath)).rejects.toMatchObject({
    code: 'ENOENT',
  });

/** Shared pipeline rejection proof: fixed safe error, final agent released
 *  exactly once, and every created temp file unlinked. */
const expectRejectedFile = async (
  options: Partial<Parameters<typeof makePipeline>[0]>,
  code: string,
  category: 'MEDIA_VALIDATION' | 'META_TRANSPORT' = 'MEDIA_VALIDATION',
): Promise<{ created: string[]; err: MetaMediaError }> => {
  const { client, destroyFns, created } = makePipeline(options);
  const err = await safeError(
    resolveAndDownload(client)(req()),
    code,
    category,
  );
  expect(destroyFns.at(-1)?.mock.calls.length).toBe(1);
  for (const filePath of created) await expectUnlinked(filePath);
  return { created, err };
};

const resolveAndDownload = (client: MetaMediaClient) =>
  client.resolveAndDownload.bind(client);

describe('MetaMediaClient.resolveAndDownload (WU4B3B1b stream pipeline)', () => {
  it('performs exactly one metadata resolution then the verified download chain and returns the validated file', async () => {
    // Declared file_size differs from the real byte count on purpose: the
    // contract reports both independently; B3B2 owns response-header guards.
    const { client, calls, token, destroyFns } = makePipeline();
    const result = await resolveAndDownload(client)(req());
    try {
      expect(calls).toHaveLength(2);
      // method/timeout defaults are proven verbatim in the B1/B2 describes.
      expect(calls[0].url).toBe(`${BASE}/media-123`);
      expect(calls[1].url).toBe(DOWNLOAD_URL);
      expect(calls[1].responseType).toBe('stream');
      expect(token).toHaveBeenCalledTimes(2);
      expect(destroyFns.map((d) => d.mock.calls.length)).toEqual([1, 1]);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.byteCount).toBe(MIN_JPEG.length);
      expect(result.providerDeclaredBytes).toBe(4321);
      expect(sha256Matches(result, MIN_JPEG)).toBe(true);
    } finally {
      await result.cleanup();
    }
  });

  it('streams into a real random mode-0600 exclusive temp file under the OS tmpdir and cleans up idempotently', async () => {
    const { client } = makePipeline();
    const first = await resolveAndDownload(client)(req());
    const second = await resolveAndDownload(client)(req());
    try {
      expect(first.filePath).not.toBe(second.filePath);
      for (const file of [first, second]) {
        expect(file.filePath.startsWith(`${os.tmpdir()}/`)).toBe(true);
        const stats = await fs.promises.stat(file.filePath);
        expect(stats.mode & 0o777).toBe(0o600);
      }
    } finally {
      for (const file of [first, second]) await file.cleanup();
      // Repeated and concurrent cleanup calls stay idempotent.
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
    for (const file of [first, second])
      await expect(fs.promises.stat(file.filePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
  });

  it('accepts a minimal PNG stream and succeeds with counted bytes alone', async () => {
    // No response header is asserted: B3B2 owns canonical response-header guards.
    const { client } = makePipeline({
      metadata: { ...META_OK, mime_type: 'image/png' },
      hops: [
        { data: streamOf([MIN_PNG]), headers: { 'content-type': 'image/png' } },
      ],
    });
    const result = await resolveAndDownload(client)(
      req('media-123', 'image/png'),
    );
    try {
      expect(result.byteCount).toBe(MIN_PNG.length);
      expect(sha256Matches(result, MIN_PNG)).toBe(true);
    } finally {
      await result.cleanup();
    }
  });

  /** Progress seam: every write persists at most 5 bytes and reports what
   *  the fake disk accepted; a fixed override simulates a stuck/lying disk
   *  that reports progress without persisting anything. */
  const progressFactory =
    (override?: number): MetaTempFileFactory =>
    async (dir) => {
      const real = await defaultTempFileFactory(dir);
      const handle = await fs.promises.open(real.filePath, 'r+');
      return {
        filePath: real.filePath,
        write: async (chunk: Buffer) =>
          override ?? (await handle.write(chunk.subarray(0, 5))).bytesWritten,
        close: async () => {
          await handle.close();
          await real.close();
        },
      };
    };

  it('repeats partial writes until every chunk byte is persisted', async () => {
    const { client } = makePipeline({ createTempFile: progressFactory() });
    const result = await resolveAndDownload(client)(req());
    try {
      expect(result.byteCount).toBe(MIN_JPEG.length);
      expect(await fs.promises.readFile(result.filePath)).toEqual(MIN_JPEG);
    } finally {
      await result.cleanup();
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 29] as const)(
    'fails closed on %j write progress without looping',
    (reported) =>
      expectRejectedFile(
        { createTempFile: progressFactory(reported) },
        'FILE_IO_FAILURE',
        'META_TRANSPORT',
      ),
  );

  /** Genuine void progress: reports undefined without ever touching the real
   *  write path, so the regression cannot pass through a helper default
   *  parameter that falls back to a real write. */
  const voidProgressFactory: MetaTempFileFactory = async (dir) => ({
    ...(await defaultTempFileFactory(dir)),
    write: () => Promise.resolve(undefined),
  });

  it('fails closed on a genuine void write progress without looping', () =>
    expectRejectedFile(
      { createTempFile: voidProgressFactory },
      'FILE_IO_FAILURE',
      'META_TRANSPORT',
    ));

  it('rejects a detected MIME mismatch with source stop, partial unlink, and single release', async () => {
    // Declared JPEG metadata but PNG bytes: the magic disagrees.
    const data = streamOf([MIN_PNG]);
    await expectRejectedFile({ hops: [{ data }] }, 'MIME_MISMATCH');
    expect(data.destroyed).toBe(true);
  });

  it('rejects a stream overflowing the 10 MiB bound before writing the excess byte', async () => {
    const data = streamOf([Buffer.alloc(10_485_760, 1), Buffer.alloc(1, 2)]);
    await expectRejectedFile({ hops: [{ data }] }, 'INVALID_MEDIA_SIZE');
    expect(data.destroyed).toBe(true);
  });

  afterAll(async () => {
    // Residue guard: every real temp path this suite created is unlinked.
    for (const filePath of CREATED) await expectUnlinked(filePath);
  });
});

/** WU4B3B2 failure matrix: response-header agreement, structure rejections,
 *  abort/error stream stops, deterministic real-I/O failure mapping, and
 *  every-path technical cleanup. Cases the 418829f baseline already satisfies
 *  are kept alongside the RED gaps as regression proof of the full matrix. */
describe('MetaMediaClient.resolveAndDownload (WU4B3B2 failure matrix and cleanup)', () => {
  it.each([
    ['missing', { 'content-type': undefined }],
    ['unsupported', { 'content-type': 'image/webp' }],
    ['declared-mismatching', { 'content-type': 'image/png' }],
  ])(
    'rejects a %s response Content-Type with MIME_MISMATCH',
    (_label, headers) =>
      expectRejectedFile({ hops: [{ headers }] }, 'MIME_MISMATCH'),
  );

  it.each(['image/jpeg; charset=binary', 'image/jpeg ;charset=binary'])(
    'accepts the parameterized matching response Content-Type %j',
    async (value) => {
      const { client } = makePipeline({
        hops: [{ headers: { 'content-type': value } }],
      });
      const result = await resolveAndDownload(client)(req());
      try {
        expect(result.mimeType).toBe('image/jpeg');
        expect(result.byteCount).toBe(MIN_JPEG.length);
      } finally {
        await result.cleanup();
      }
    },
  );

  it.each([
    ['malformed', 'abc'],
    ['empty', ''],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['non-string', 27],
    ['unsafe', '9007199254740993'],
    ['over the limit', '10485761'],
    ['final-count mismatching', '26'],
  ])(
    'rejects a %s response Content-Length with INVALID_MEDIA_SIZE',
    (_label, value: unknown) =>
      expectRejectedFile(
        { hops: [{ headers: { 'content-length': value } }] },
        'INVALID_MEDIA_SIZE',
      ),
  );

  it('accepts a present matching and an absent Content-Length independently of providerDeclaredBytes', async () => {
    const matched = makePipeline({
      hops: [{ headers: { 'content-length': String(MIN_JPEG.length) } }],
    });
    const present = await resolveAndDownload(matched.client)(req());
    try {
      expect(present.byteCount).toBe(MIN_JPEG.length);
      expect(present.providerDeclaredBytes).toBe(4321);
    } finally {
      await present.cleanup();
    }
    const absent = await resolveAndDownload(makePipeline().client)(req());
    try {
      expect(absent.byteCount).toBe(MIN_JPEG.length);
    } finally {
      await absent.cleanup();
    }
  });

  // Truncated SOI-only JPEG (no SOF/SOS/EOI) and a truncated PNG IHDR chunk.
  const MALFORMED_JPEG = Buffer.from(
    'ffd8000000000000000000000000000000000000000000',
    'hex',
  );
  const MALFORMED_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010800',
    'hex',
  );

  it('rejects a malformed JPEG body with JPEG_STRUCTURE_INVALID', () =>
    expectRejectedFile(
      { hops: [{ data: streamOf([MALFORMED_JPEG]) }] },
      'JPEG_STRUCTURE_INVALID',
    ));

  it('rejects a malformed PNG body with PNG_STRUCTURE_INVALID', async () => {
    // Declared PNG throughout: the rejection must come from the structure
    // validator, not from the metadata/magic agreement guards.
    const { client, destroyFns, created } = makePipeline({
      metadata: { ...META_OK, mime_type: 'image/png' },
      hops: [
        {
          data: streamOf([MALFORMED_PNG]),
          headers: { 'content-type': 'image/png' },
        },
      ],
    });
    await safeError(
      resolveAndDownload(client)(req('media-123', 'image/png')),
      'PNG_STRUCTURE_INVALID',
      'MEDIA_VALIDATION',
    );
    expect(destroyFns.at(-1)?.mock.calls.length).toBe(1);
    for (const filePath of created) await expectUnlinked(filePath);
  });

  /** Real mid-stream stop: one chunk is delivered, then the source fails. */
  const erroredStream = (error: Error): Readable =>
    new Readable({
      read() {
        setImmediate(() => this.destroy(error));
        this.push(MIN_JPEG);
      },
    });

  it('stops reading on a mid-stream error: source destroyed, agent released once, temp removed', async () => {
    const data = erroredStream(new Error('stream failed'));
    await expectRejectedFile(
      { hops: [{ data }] },
      'NETWORK_FAILURE',
      'META_TRANSPORT',
    );
    expect(data.destroyed).toBe(true);
  });

  it('maps a mid-stream abort to ABORTED with the same stop and cleanup guarantees', async () => {
    const data = erroredStream(
      Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }),
    );
    await expectRejectedFile({ hops: [{ data }] }, 'ABORTED', 'META_TRANSPORT');
    expect(data.destroyed).toBe(true);
  });

  it('rejects an already-active abort signal with no download request and no temp', async () => {
    const { client, calls, destroyFns, created } = makePipeline();
    const controller = new AbortController();
    controller.abort();
    await safeError(
      resolveAndDownload(client)({ ...req(), signal: controller.signal }),
      'ABORTED',
    );
    expect(calls).toHaveLength(1); // metadata hop only, no download request
    expect(destroyFns[0]).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  /** Real-fs failure seams: every simulated I/O failure below is produced by
   *  a genuine fs rejection, never a stubbed throw. */
  const openMissingDirFactory: MetaTempFileFactory = async (dir) => {
    await fs.promises.open(
      path.join(dir, 'receipt-media-no-such-dir', 'x'),
      'wx',
      0o600,
    );
    throw new Error('unreachable');
  };

  const readOnlyFactory: MetaTempFileFactory = async (dir) => {
    const file = await defaultTempFileFactory(dir);
    const handle = await fs.promises.open(file.filePath, 'r');
    return {
      filePath: file.filePath,
      write: async (chunk: Buffer) => (await handle.write(chunk)).bytesWritten, // real EBADF on 'r' fd
      close: async () => {
        await handle.close();
        await file.close();
      },
    };
  };

  const closedFdFactory: MetaTempFileFactory = async (dir) => {
    const file = await defaultTempFileFactory(dir);
    const handle = await fs.promises.open(file.filePath, 'r+');
    return {
      ...file,
      close: async () => {
        // Every real FileHandle is explicitly closed before the real
        // EBADF, so no descriptor is ever left to the garbage collector.
        await file.close();
        const fd = handle.fd;
        await handle.close();
        fs.closeSync(fd); // real EBADF: the fd was already closed
      },
    };
  };

  const selfDeletingFactory: MetaTempFileFactory = async (dir) => {
    const file = await defaultTempFileFactory(dir);
    return {
      ...file,
      close: async () => {
        await file.close();
        await fs.promises.rm(file.filePath, { force: true });
      },
    };
  };

  it.each([
    ['open', openMissingDirFactory],
    ['write', readOnlyFactory],
    ['close', closedFdFactory],
    ['read-back', selfDeletingFactory],
  ] as const)(
    'maps a real temp-%s failure to FILE_IO_FAILURE with zero residue',
    (_label, factory) =>
      expectRejectedFile(
        { createTempFile: factory },
        'FILE_IO_FAILURE',
        'META_TRANSPORT',
      ),
  );

  /** Overflow primary: a clean domain rejection (INVALID_MEDIA_SIZE) raised
   *  while a real populated temp file already exists, so the failure-path
   *  close and unlink steps of the cleanup-projection tests are genuine. */
  const OVERFLOW = [Buffer.alloc(10_485_760, 1), Buffer.alloc(1, 2)];

  /** Real unlink-failure seam: the failure-path close closes the real file,
   *  then replaces it with a non-empty directory at the same path, so the
   *  pipeline's own rm fails for real instead of via a stubbed rejection. */
  const dirSwapFactory: MetaTempFileFactory = async (dir) => {
    const file = await defaultTempFileFactory(dir);
    return {
      filePath: file.filePath,
      write: (chunk: Buffer) => file.write(chunk),
      close: async () => {
        await file.close();
        await fs.promises.rm(file.filePath, { force: true });
        await fs.promises.mkdir(file.filePath);
        await fs.promises.writeFile(path.join(file.filePath, 'inner'), 'x');
      },
    };
  };

  it('surfaces FILE_IO_FAILURE when failure-path close fails and still unlinks', () =>
    // The primary INVALID_MEDIA_SIZE must not mask the real cleanup close
    // failure; the unlink step still runs and removes the temp file.
    expectRejectedFile(
      {
        hops: [{ data: streamOf(OVERFLOW) }],
        createTempFile: closedFdFactory,
      },
      'FILE_IO_FAILURE',
      'META_TRANSPORT',
    ));

  it('surfaces FILE_IO_FAILURE when failure-path unlink fails and leaks no temp detail', async () => {
    const { client, destroyFns, created } = makePipeline({
      hops: [{ data: streamOf(OVERFLOW) }],
      createTempFile: dirSwapFactory,
    });
    try {
      const err = await safeError(
        resolveAndDownload(client)(req()),
        'FILE_IO_FAILURE',
        'META_TRANSPORT',
      );
      expect(destroyFns.at(-1)?.mock.calls.length).toBe(1);
      for (const filePath of created)
        expect(JSON.stringify(err)).not.toContain(filePath);
    } finally {
      // The failed real unlink leaves the swapped path: the test owns it.
      for (const filePath of created) {
        await fs.promises.rm(filePath, { recursive: true, force: true });
        await expectUnlinked(filePath);
      }
    }
  });

  /** WU4B3B2 remediation: real Readable.from source whose public destroy()
   *  is counted. Both Node's async-iterator completion (which destroys the
   *  source on abrupt loop failure, mid-stream error, and normal end) and
   *  the client's catch-path teardown are observable here, so exactly-once
   *  source destruction is provable instead of assumed. */
  const destroyCountingStream = (chunks: Buffer[]) => {
    const data = streamOf(chunks);
    const originalDestroy = data.destroy.bind(data);
    const destroyCalls: Array<Error | null> = [];
    data.destroy = (error?: Error) => {
      destroyCalls.push(error ?? null);
      return originalDestroy(error);
    };
    return { data, destroyCalls };
  };

  it('destroys the source exactly once when the stream loop fails abruptly on overflow', async () => {
    const { data, destroyCalls } = destroyCountingStream(OVERFLOW);
    await expectRejectedFile({ hops: [{ data }] }, 'INVALID_MEDIA_SIZE');
    // The async iterator already destroyed the source during the abrupt
    // loop exit; the catch path must not invoke destroy a second time.
    expect(destroyCalls).toHaveLength(1);
    expect(data.destroyed).toBe(true);
  });

  it('destroys the source exactly once when a post-loop validation fails', async () => {
    const { data, destroyCalls } = destroyCountingStream([MIN_JPEG]);
    await expectRejectedFile(
      { hops: [{ data, headers: { 'content-length': '26' } }] },
      'INVALID_MEDIA_SIZE',
    );
    // Normal loop completion also makes the async iterator destroy the
    // source; the later Content-Length rejection must not re-destroy.
    expect(destroyCalls).toHaveLength(1);
    expect(data.destroyed).toBe(true);
  });

  it('still explicitly destroys an undestroyed source on a pre-loop response-header failure', async () => {
    const { data, destroyCalls } = destroyCountingStream([MIN_JPEG]);
    await expectRejectedFile(
      { hops: [{ data, headers: { 'content-type': 'image/png' } }] },
      'MIME_MISMATCH',
    );
    // The loop never consumed a byte, so Node has not destroyed the
    // source: the catch-path teardown itself must destroy exactly once.
    expect(destroyCalls).toHaveLength(1);
    expect(data.destroyed).toBe(true);
  });

  it('projects a real cleanup unlink failure to the fixed safe FILE_IO_FAILURE projection', async () => {
    const { client } = makePipeline();
    const result = await resolveAndDownload(client)(req());
    // Swap the validated file for a non-empty directory at the same path so
    // the caller-owned cleanup rm fails for real instead of via a stub.
    await fs.promises.rm(result.filePath, { force: true });
    await fs.promises.mkdir(result.filePath);
    await fs.promises.writeFile(path.join(result.filePath, 'inner'), 'x');
    try {
      const err = await safeError(
        result.cleanup(),
        'FILE_IO_FAILURE',
        'META_TRANSPORT',
      );
      expect(JSON.stringify(err)).not.toContain(result.filePath);
    } finally {
      await fs.promises.rm(result.filePath, {
        recursive: true,
        force: true,
      });
      await expectUnlinked(result.filePath);
    }
  });

  afterAll(async () => {
    // Residue guard: every real temp path this describe created is unlinked.
    for (const filePath of CREATED) await expectUnlinked(filePath);
  });
});
