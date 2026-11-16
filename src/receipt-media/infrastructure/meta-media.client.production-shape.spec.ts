/** Production-shape proofs for the Meta media client (S2-S6): built from the
 *  SHIPPED default configuration (no allowedHosts override), real-shaped
 *  Meta URLs with a query string, network faked only at the http / resolver /
 *  agent seams. */
import type { LookupAddress } from 'node:dns';
import type { Agent } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig } from 'axios';
import configuration from '../../config/configuration';
import { MetaMediaError } from '../domain/meta-media.port';
import { metaFailureReasonOf } from './meta-media-failure-reason';
import { createMetaMediaClient } from './meta-media-client.factory';
import {
  MetaMediaClient,
  metaHttpStatusOf,
  type MetaHttp,
} from './meta-media.client';

const GRAPH_HOST = 'graph.facebook.com';
const LOOKASIDE = 'lookaside.fbsbx.com';
const MEDIA_ID = 'wamid-media-id-98765';
const TOKEN = 'EAAG-secret-token-sentinel';
const REAL_URL = `https://${LOOKASIDE}/whatsapp_business/attachments/?mid=${MEDIA_ID}&ext=1763300000&hash=ATsecretHash`;
const MIN_JPEG = Buffer.from(
  'ffd8ffc0000b080001000101011100ffda000801010000000012ffd9',
  'hex',
);
const V4: LookupAddress = { address: '57.144.134.128', family: 4 };
const V6: LookupAddress = {
  address: '2a03:2880:f343:80:face:b00c:0:3',
  family: 6,
};

const ENV_KEYS = [
  'META_MEDIA_ALLOWED_HOSTS',
  'META_GRAPH_API_BASE_URL',
  'META_MEDIA_METADATA_TIMEOUT_MS',
  'META_MEDIA_DOWNLOAD_TIMEOUT_MS',
  'META_ACCESS_TOKEN',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.META_ACCESS_TOKEN = TOKEN;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

interface Harness {
  client: MetaMediaClient;
  calls: AxiosRequestConfig[];
  resolved: string[];
  lookups: LookupFunction[];
}

/** The client exactly as the modules build it from the shipped defaults. */
function shipped(
  options: {
    addresses?: Record<string, LookupAddress[]>;
    metadataUrl?: string;
    hops?: Array<{ status: number; headers?: Record<string, string> }>;
    httpError?: unknown;
  } = {},
): Harness {
  const calls: AxiosRequestConfig[] = [];
  const resolved: string[] = [];
  const lookups: LookupFunction[] = [];
  let hop = 0;
  const http: MetaHttp = (config) => {
    calls.push(config);
    if (options.httpError !== undefined)
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.httpError);
    if (config.responseType !== 'stream')
      return Promise.resolve({
        status: 200,
        data: {
          url: options.metadataUrl ?? REAL_URL,
          mime_type: 'image/jpeg',
          file_size: MIN_JPEG.length,
        },
      });
    const spec = options.hops?.[hop++] ?? { status: 200 };
    return Promise.resolve({
      status: spec.status,
      headers: { 'content-type': 'image/jpeg', ...spec.headers },
      data: Readable.from([MIN_JPEG]),
    });
  };
  const client = createMetaMediaClient(new ConfigService(configuration()), {
    http,
    resolve: (hostname) => {
      resolved.push(hostname);
      return Promise.resolve(options.addresses?.[hostname] ?? [V4]);
    },
    createAgent: (lookup) => {
      lookups.push(lookup);
      return { destroy: jest.fn() } as unknown as Agent;
    },
  });
  return { client, calls, resolved, lookups };
}

const request = (): Parameters<MetaMediaClient['resolveAndDownload']>[0] => ({
  providerMediaId: MEDIA_ID,
  declaredMimeType: 'image/jpeg',
  signal: new AbortController().signal,
});

const failure = async (promise: Promise<unknown>): Promise<MetaMediaError> => {
  const err: unknown = await promise.catch((error: unknown) => error);
  expect(err).toBeInstanceOf(MetaMediaError);
  return err as MetaMediaError;
};

const SENSITIVE = new RegExp(
  [MEDIA_ID, TOKEN, 'ATsecretHash', 'mid=', LOOKASIDE, GRAPH_HOST, 'https?:']
    .map((part) => part.replace(/[.?]/g, '\\$&'))
    .join('|'),
  'i',
);

describe('shipped default config → Meta media download (S2, S3, S6)', () => {
  it('downloads through the Graph metadata hop and a real-shaped lookaside URL with a query', async () => {
    const { client, calls, resolved } = shipped();
    const file = await client.resolveAndDownload(request());
    try {
      expect(file.byteCount).toBe(MIN_JPEG.length);
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe(`https://${GRAPH_HOST}/v23.0/${MEDIA_ID}`);
      expect(calls[1].url).toBe(REAL_URL);
      expect(resolved).toEqual([GRAPH_HOST, LOOKASIDE]);
      expect(calls[1].headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    } finally {
      await file.cleanup();
    }
  });

  it('follows a redirect whose target also carries a query on the allowlisted host', async () => {
    const { client, calls } = shipped({
      hops: [
        {
          status: 302,
          headers: { location: `https://${LOOKASIDE}/next?mid=1&hash=h` },
        },
        { status: 200 },
      ],
    });
    const file = await client.resolveAndDownload(request());
    await file.cleanup();
    expect(calls.map((call) => call.url)).toEqual([
      `https://${GRAPH_HOST}/v23.0/${MEDIA_ID}`,
      REAL_URL,
      `https://${LOOKASIDE}/next?mid=1&hash=h`,
    ]);
  });

  it('S2: the Graph URL itself stays query-free and the Graph host does not widen the download allowlist', async () => {
    process.env.META_GRAPH_API_BASE_URL = `https://${GRAPH_HOST}/v23.0?x=1`;
    const withQuery = shipped();
    await failure(withQuery.client.resolveAndDownload(request()));
    expect(withQuery.calls).toHaveLength(0);

    delete process.env.META_GRAPH_API_BASE_URL;
    // A download hop pointed at the Graph host is not on the download allowlist.
    const metadataOnly = shipped({
      metadataUrl: `https://${GRAPH_HOST}/v23.0/other?mid=1`,
    });
    const err = await failure(
      metadataOnly.client.resolveAndDownload(request()),
    );
    expect(metaFailureReasonOf(err)).toBe('HOST_NOT_ALLOWED');
    expect(metadataOnly.calls).toHaveLength(1); // metadata only, no download
  });

  it('S2: the metadata host is derived from the configured Graph base URL only', async () => {
    process.env.META_GRAPH_API_BASE_URL = 'https://graph.example-meta.test/v9';
    const custom = shipped();
    const file = await custom.client.resolveAndDownload(request());
    await file.cleanup();
    expect(custom.calls[0].url).toBe(
      `https://graph.example-meta.test/v9/${MEDIA_ID}`,
    );

    // A non-HTTPS or userinfo Graph base is never accepted for the metadata hop.
    for (const base of [
      `http://${GRAPH_HOST}/v23.0`,
      `https://user:pw@${GRAPH_HOST}/v23.0`,
      `https://${GRAPH_HOST}:8443/v23.0`,
      `https://${GRAPH_HOST}/v23.0#f`,
    ]) {
      process.env.META_GRAPH_API_BASE_URL = base;
      const bad = shipped();
      await failure(bad.client.resolveAndDownload(request()));
      expect(bad.calls).toHaveLength(0);
    }
  });

  it('S3: a redirect to a non-allowlisted host (even with a query) is rejected before any request or bearer', async () => {
    const { client, calls } = shipped({
      hops: [
        {
          status: 302,
          headers: { location: 'https://evil.example/x?mid=1' },
        },
      ],
    });
    const err = await failure(client.resolveAndDownload(request()));
    expect(metaFailureReasonOf(err)).toBe('HOST_NOT_ALLOWED');
    expect(calls).toHaveLength(2); // metadata + first download hop only
  });

  it.each([
    ['http://lookaside.fbsbx.com/x?mid=1', 'SCHEME_NOT_HTTPS'],
    ['https://u:p@lookaside.fbsbx.com/x?mid=1', 'USERINFO_NOT_ALLOWED'],
    ['https://lookaside.fbsbx.com/x?mid=1#f', 'FRAGMENT_NOT_ALLOWED'],
    ['https://lookaside.fbsbx.com:8443/x?mid=1', 'PORT_NOT_ALLOWED'],
    ['https://lookaside.fbsbx.com.evil.example/x?mid=1', 'HOST_NOT_ALLOWED'],
  ])('S3: download URL %s stays rejected (%s)', async (url, reason) => {
    const { client, calls } = shipped({ metadataUrl: url });
    const err = await failure(client.resolveAndDownload(request()));
    expect(metaFailureReasonOf(err)).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('S3: any non-public resolved address (incl. IPv4-mapped IPv6) rejects a query download', async () => {
    for (const bad of [
      { address: '10.0.0.5', family: 4 as const },
      { address: '::ffff:10.0.0.5', family: 6 as const },
    ]) {
      const { client, calls } = shipped({
        addresses: { [LOOKASIDE]: [V4, bad] },
      });
      const err = await failure(client.resolveAndDownload(request()));
      expect(metaFailureReasonOf(err)).toBe('NON_PUBLIC_ADDRESS');
      expect(calls).toHaveLength(1);
    }
  });
});

describe('IPv4 preference through the client agent seam (S4)', () => {
  it('pins the lookaside agent to the validated IPv4 even when AAAA is listed (first)', async () => {
    const { client, lookups } = shipped({
      addresses: { [LOOKASIDE]: [V6, V4] }, // production record set, verbatim
    });
    const file = await client.resolveAndDownload(request());
    await file.cleanup();
    expect(lookups).toHaveLength(2); // metadata agent + download agent
    const handed: string[] = [];
    lookups[1](LOOKASIDE, {}, (_err, address) =>
      handed.push(address as string),
    );
    lookups[1](LOOKASIDE, { all: true }, (_err, list) =>
      (list as LookupAddress[]).forEach((entry) => handed.push(entry.address)),
    );
    expect(handed).toEqual([V4.address, V4.address]);
  });

  it('still connects to a public IPv6-only host and rejects a non-public AAAA beside a public A', async () => {
    const only6 = shipped({ addresses: { [LOOKASIDE]: [V6] } });
    const file = await only6.client.resolveAndDownload(request());
    await file.cleanup();
    const handed: string[] = [];
    only6.lookups[1](LOOKASIDE, {}, (_e, address) =>
      handed.push(address as string),
    );
    expect(handed).toEqual([V6.address]);

    const mixed = shipped({
      addresses: { [LOOKASIDE]: [V4, { address: 'fc00::1', family: 6 }] },
    });
    const err = await failure(mixed.client.resolveAndDownload(request()));
    expect(metaFailureReasonOf(err)).toBe('NON_PUBLIC_ADDRESS');
  });
});

describe('safe failure reasons (S5)', () => {
  it('records a raw errno on the side-channel while the error stays clean', async () => {
    const { client } = shipped({
      httpError: Object.assign(
        new Error(`connect ENETUNREACH 2a03::3:443 ${REAL_URL}`),
        { code: 'ENETUNREACH' },
      ),
    });
    const err = await failure(client.resolveAndDownload(request()));
    expect(err).toMatchObject({
      category: 'META_TRANSPORT',
      code: 'NETWORK_FAILURE',
      message: 'receipt-media:META_TRANSPORT/NETWORK_FAILURE',
    });
    expect(metaFailureReasonOf(err)).toBe('ENETUNREACH');
    expect(JSON.stringify(err)).not.toMatch(SENSITIVE);
    expect(Object.keys(err)).toEqual(['category', 'code']);
  });

  it('never records a free-text or URL-bearing code as a reason', async () => {
    const { client } = shipped({
      httpError: Object.assign(new Error('x'), {
        code: `bad code ${REAL_URL}`,
      }),
    });
    const err = await failure(client.resolveAndDownload(request()));
    expect(metaFailureReasonOf(err)).toBeUndefined();
  });

  it.each([
    ['DNS_FAILED', () => Promise.reject(new Error(`lookup ${LOOKASIDE}`))],
    ['DNS_FAILED', () => Promise.resolve([])],
  ])('records %s for a resolver failure', async (reason, resolve) => {
    const calls: AxiosRequestConfig[] = [];
    const client = createMetaMediaClient(new ConfigService(configuration()), {
      http: (config) => {
        calls.push(config);
        return Promise.reject(new Error('unreachable'));
      },
      resolve,
    });
    const err = await failure(client.resolveAndDownload(request()));
    expect(metaFailureReasonOf(err)).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  it('keeps the HTTP status on its own side-channel, not the error', async () => {
    const { client } = shipped({ hops: [{ status: 503 }] });
    // The metadata hop succeeds; the 503 download is HTTP_RETRYABLE.
    const err = await failure(client.resolveAndDownload(request()));
    expect(err).toMatchObject({ code: 'HTTP_RETRYABLE' });
    expect(metaHttpStatusOf(err)).toBe(503);
    expect(JSON.stringify(err)).not.toContain('503');
  });
});
