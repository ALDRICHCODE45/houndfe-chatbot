import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Agent } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { AxiosRequestConfig } from 'axios';
import {
  defaultTempFileFactory,
  type MetaHttp,
} from '../../receipt-media/infrastructure/meta-media.client';
import type { MirrorSourceResult } from '../domain/mirror-media';
import type { OpenedMirrorLink } from '../domain/mirror-media';
import { LinkMirrorFetcher } from './link-mirror-fetcher';

const URL_OK = 'https://cdn.example.com/photos/croquetas.jpg?v=3';
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(200, 7),
]);
const PUBLIC = [{ address: '8.8.8.8', family: 4 as const }];
const signal = new AbortController().signal;

type Hop = {
  status?: number;
  headers?: Record<string, string>;
  data?: Readable;
  error?: unknown;
};

function harness(
  hops: Hop[],
  options: {
    allowedHosts?: string[];
    resolve?: (host: string) => Promise<LookupAddress[]>;
    maxBytes?: number;
  } = {},
) {
  const calls: AxiosRequestConfig[] = [];
  const created: string[] = [];
  const destroys: jest.Mock[] = [];
  let index = 0;
  const http: MetaHttp = (config) => {
    calls.push(config);
    const hop = hops[index++];
    if (hop === undefined) return Promise.reject(new Error('extra hop'));
    if (hop.error !== undefined)
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(hop.error);
    return Promise.resolve({
      status: hop.status ?? 200,
      headers: hop.headers ?? {},
      data: hop.data ?? Readable.from([JPEG]),
    });
  };
  const fetcher = new LinkMirrorFetcher(
    {
      allowedHosts: options.allowedHosts,
      timeoutMs: 15000,
    },
    {
      http,
      resolve: options.resolve ?? (() => Promise.resolve(PUBLIC)),
      createAgent: () => {
        const destroy = jest.fn();
        destroys.push(destroy);
        return { destroy } as unknown as Agent;
      },
      createTempFile: async (dir) => {
        const file = await defaultTempFileFactory(dir);
        created.push(file.filePath);
        return file;
      },
    },
  );
  return { fetcher, calls, created, destroys };
}

const exists = (path: string) =>
  fs.promises.stat(path).then(
    () => true,
    () => false,
  );

const opened = (result: MirrorSourceResult<OpenedMirrorLink>) => {
  if (result.kind !== 'ok') throw new Error(`not ok: ${result.kind}`);
  return result.value;
};

describe('LinkMirrorFetcher.open', () => {
  it('opens a public https link, sends no credentials, and reports the ETag as the version', async () => {
    const { fetcher, calls } = harness([
      { headers: { etag: '"abc123"', 'last-modified': 'Tue, 10 Nov 2026' } },
    ]);
    const link = opened(await fetcher.open({ url: URL_OK, signal }));
    expect(link.version).toBe('"abc123"');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: URL_OK,
      responseType: 'stream',
      maxRedirects: 0,
      proxy: false,
      timeout: 15000,
      signal,
    });
    expect(JSON.stringify(calls[0].headers ?? {})).not.toMatch(
      /authorization|bearer|cookie/i,
    );
    link.discard();
  });

  it.each([
    [
      { 'last-modified': 'Tue, 10 Nov 2026 10:00:00 GMT' },
      'Tue, 10 Nov 2026 10:00:00 GMT',
    ],
    [{}, null],
    [{ etag: '' }, null],
  ])('version from %j is %j', async (headers, version) => {
    const { fetcher } = harness([{ headers }]);
    const link = opened(await fetcher.open({ url: URL_OK, signal }));
    expect(link.version).toBe(version);
    link.discard();
  });

  it.each([
    ['plain http', 'http://cdn.example.com/a.jpg'],
    ['userinfo', 'https://user:pw@cdn.example.com/a.jpg'],
    ['fragment', 'https://cdn.example.com/a.jpg#frag'],
    ['odd port', 'https://cdn.example.com:8443/a.jpg'],
    ['not a url', 'cdn.example.com/a.jpg'],
    ['file scheme', 'file:///etc/passwd'],
    ['empty', ''],
  ])('refuses %s without any request', async (_name, url) => {
    const { fetcher, calls } = harness([{}]);
    await expect(fetcher.open({ url, signal })).resolves.toEqual({
      kind: 'unsupported',
      reason: 'media_unavailable',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['loopback', '127.0.0.1', 4],
    ['private 10/8', '10.0.0.5', 4],
    ['private 192.168/16', '192.168.1.10', 4],
    ['link-local metadata', '169.254.169.254', 4],
    ['ipv6 loopback', '::1', 6],
    ['ipv4-mapped private', '::ffff:10.0.0.1', 6],
  ])(
    'refuses a host resolving to %s (SSRF)',
    async (_name, address, family) => {
      const { fetcher, calls } = harness([{}], {
        resolve: () => Promise.resolve([{ address, family }]),
      });
      await expect(fetcher.open({ url: URL_OK, signal })).resolves.toEqual({
        kind: 'unsupported',
        reason: 'media_unavailable',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses when any resolved address is non-public, and when resolution fails', async () => {
    const mixed = harness([{}], {
      resolve: () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '10.1.1.1', family: 4 },
        ]),
    });
    await expect(
      mixed.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });
    const failing = harness([{}], {
      resolve: () => Promise.reject(new Error('ENOTFOUND')),
    });
    await expect(
      failing.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });
  });

  it('enforces an allowlist when one is configured (exact or label-boundary suffix)', async () => {
    const allowed = harness([{}], { allowedHosts: ['example.com'] });
    opened(await allowed.fetcher.open({ url: URL_OK, signal })).discard();
    const blocked = harness([{}], { allowedHosts: ['other.org'] });
    await expect(
      blocked.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });
    const lookalike = harness([{}], { allowedHosts: ['ample.com'] });
    await expect(
      lookalike.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });
  });

  it('follows at most 3 redirects, revalidating every hop (a redirect to a private host is refused)', async () => {
    const resolve = jest.fn((host: string) =>
      Promise.resolve(
        host === 'internal.example.com'
          ? [{ address: '10.0.0.9', family: 4 as const }]
          : PUBLIC,
      ),
    );
    const ok = harness(
      [
        { status: 302, headers: { location: '/b.jpg' } },
        { status: 301, headers: { location: 'https://img.example.com/c.jpg' } },
        { headers: { etag: 'W/"x"' } },
      ],
      { resolve },
    );
    const link = opened(await ok.fetcher.open({ url: URL_OK, signal }));
    expect(link.version).toBe('W/"x"');
    expect(ok.calls.map((c) => c.url)).toEqual([
      URL_OK,
      'https://cdn.example.com/b.jpg',
      'https://img.example.com/c.jpg',
    ]);
    expect(resolve).toHaveBeenCalledWith('img.example.com');
    link.discard();

    const evil = harness(
      [
        {
          status: 302,
          headers: { location: 'https://internal.example.com/secret' },
        },
        {},
      ],
      { resolve },
    );
    await expect(
      evil.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });
    expect(evil.calls).toHaveLength(1);

    const downgrade = harness([
      { status: 302, headers: { location: 'http://cdn.example.com/a.jpg' } },
      {},
    ]);
    await expect(
      downgrade.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });

    const loop = harness(
      Array.from({ length: 5 }, () => ({
        status: 302,
        headers: { location: URL_OK },
      })),
    );
    await expect(
      loop.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toMatchObject({ kind: 'unsupported' });
    expect(loop.calls).toHaveLength(4);
  });

  it.each([
    [404, { kind: 'unsupported', reason: 'media_unavailable' }],
    [410, { kind: 'unsupported', reason: 'media_unavailable' }],
    [403, { kind: 'unsupported', reason: 'media_unavailable' }],
    [401, { kind: 'unsupported', reason: 'media_unavailable' }],
    [408, { kind: 'retry', cause: 'source_transient' }],
    [429, { kind: 'retry', cause: 'source_transient' }],
    [500, { kind: 'retry', cause: 'source_transient' }],
    [503, { kind: 'retry', cause: 'source_transient' }],
  ])('maps HTTP %i', async (status, expected) => {
    const h = harness([{ status }]);
    await expect(h.fetcher.open({ url: URL_OK, signal })).resolves.toEqual(
      expected,
    );
    expect(h.destroys.every((d) => d.mock.calls.length === 1)).toBe(true);
  });

  it('maps transport failures: timeout/network retry, abort is aborted', async () => {
    const timeout = harness([
      { error: Object.assign(new Error('t'), { code: 'ECONNABORTED' }) },
    ]);
    await expect(
      timeout.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toEqual({ kind: 'retry', cause: 'source_transient' });
    const aborted = harness([
      { error: Object.assign(new Error('c'), { code: 'ERR_CANCELED' }) },
    ]);
    await expect(
      aborted.fetcher.open({ url: URL_OK, signal }),
    ).resolves.toEqual({ kind: 'retry', cause: 'aborted' });
  });

  it('discard drops the unread body and releases the pinned agent exactly once', async () => {
    const data = Readable.from([JPEG]);
    const h = harness([{ data }]);
    const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
    link.discard();
    link.discard();
    expect(data.destroyed).toBe(true);
    expect(h.destroys.map((d) => d.mock.calls.length)).toEqual([1]);
    expect(h.created).toHaveLength(0);
  });
});

describe('LinkMirrorFetcher download', () => {
  it('streams to a mode-0600 temp file, sniffs, hashes, and cleans up idempotently', async () => {
    const h = harness([{ headers: { 'content-length': String(JPEG.length) } }]);
    const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
    const result = await link.download();
    if (result.kind !== 'ok') throw new Error(result.kind);
    const file = result.value;
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.byteCount).toBe(JPEG.length);
    expect(file.sha256Hex).toBe(
      createHash('sha256').update(JPEG).digest('hex'),
    );
    expect((await fs.promises.stat(file.filePath)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file.filePath).equals(JPEG)).toBe(true);
    expect(h.destroys.map((d) => d.mock.calls.length)).toEqual([1]);
    await file.cleanup();
    await file.cleanup();
    expect(await exists(file.filePath)).toBe(false);
  });

  it('refuses an oversize Content-Length before reading a byte', async () => {
    const data = Readable.from([JPEG]);
    const h = harness([
      { headers: { 'content-length': String(10 * 1024 * 1024 + 1) }, data },
    ]);
    const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
    await expect(link.download()).resolves.toEqual({
      kind: 'unsupported',
      reason: 'too_large',
    });
    expect(data.destroyed).toBe(true);
    expect(h.created).toHaveLength(0);
    expect(h.destroys.map((d) => d.mock.calls.length)).toEqual([1]);
  });

  it('stops a stream that overruns 10 MiB without Content-Length and unlinks the partial file', async () => {
    const chunk = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(1024 * 1024 - 3, 1),
    ]);
    let pulled = 0;
    const endless = new Readable({
      read() {
        pulled += 1;
        this.push(chunk);
      },
    });
    const h = harness([{ data: endless }]);
    const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
    await expect(link.download()).resolves.toEqual({
      kind: 'unsupported',
      reason: 'too_large',
    });
    expect(pulled).toBeLessThan(10 + 8);
    expect(h.created).toHaveLength(1);
    expect(await exists(h.created[0])).toBe(false);
    expect(h.destroys.map((d) => d.mock.calls.length)).toEqual([1]);
  });

  it.each([
    ['html', Buffer.from('<!doctype html><html>nope</html>')],
    ['gif', Buffer.from('GIF89a\u0001\u0000\u0001\u0000')],
    [
      'mp4 video',
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x20]),
        Buffer.from('ftypisom'),
        Buffer.alloc(32),
      ]),
    ],
    ['empty body', Buffer.alloc(0)],
  ])(
    'refuses %s bytes as not allowed and removes the temp file',
    async (_n, body) => {
      const h = harness([{ data: Readable.from(body.length ? [body] : []) }]);
      const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
      await expect(link.download()).resolves.toEqual({
        kind: 'unsupported',
        reason: 'type_not_allowed',
      });
      for (const path of h.created) expect(await exists(path)).toBe(false);
    },
  );

  it('a Content-Length that disagrees with the bytes read is a transient failure and unlinks', async () => {
    const h = harness([{ headers: { 'content-length': '999' } }]);
    const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
    await expect(link.download()).resolves.toEqual({
      kind: 'retry',
      cause: 'source_transient',
    });
    for (const path of h.created) expect(await exists(path)).toBe(false);
  });

  it('a mid-stream error is retryable and unlinks the partial file', async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
        this.destroy(new Error('socket reset'));
      },
    });
    const h = harness([{ data: broken }]);
    const link = opened(await h.fetcher.open({ url: URL_OK, signal }));
    await expect(link.download()).resolves.toEqual({
      kind: 'retry',
      cause: 'source_transient',
    });
    for (const path of h.created) expect(await exists(path)).toBe(false);
    expect(h.destroys.map((d) => d.mock.calls.length)).toEqual([1]);
  });

  it('a temp-file I/O failure is retryable local_io', async () => {
    const calls: AxiosRequestConfig[] = [];
    const fetcher = new LinkMirrorFetcher(
      { timeoutMs: 1000 },
      {
        http: (config) => {
          calls.push(config);
          return Promise.resolve({
            status: 200,
            headers: {},
            data: Readable.from([JPEG]),
          });
        },
        resolve: () => Promise.resolve(PUBLIC),
        createAgent: () => ({ destroy: jest.fn() }) as unknown as Agent,
        createTempFile: () => Promise.reject(new Error('EACCES /tmp')),
      },
    );
    const link = opened(await fetcher.open({ url: URL_OK, signal }));
    await expect(link.download()).resolves.toEqual({
      kind: 'retry',
      cause: 'local_io',
    });
  });

  it('an abort during the download is aborted and leaves no file', async () => {
    const controller = new AbortController();
    const slow = new Readable({
      read() {
        controller.abort();
        this.push(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      },
    });
    const h = harness([{ data: slow }]);
    const link = opened(
      await h.fetcher.open({ url: URL_OK, signal: controller.signal }),
    );
    await expect(link.download()).resolves.toEqual({
      kind: 'retry',
      cause: 'aborted',
    });
    for (const path of h.created) expect(await exists(path)).toBe(false);
  });
});
