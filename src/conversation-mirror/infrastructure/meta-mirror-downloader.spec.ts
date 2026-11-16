import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { Agent } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { AxiosRequestConfig } from 'axios';
import configuration from '../../config/configuration';
import { MetaMediaError } from '../../receipt-media/domain/meta-media.port';
import { createMetaMediaClient } from '../../receipt-media/infrastructure/meta-media-client.factory';
import {
  MetaMediaClient,
  type MetaHttp,
} from '../../receipt-media/infrastructure/meta-media.client';
import { MetaMirrorDownloader } from './meta-mirror-downloader';
import { MIRROR_MEDIA_PROFILE } from './mirror-media-profile';

const PROVIDER_ID = 'meta-media-123';
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)]);
const signal = new AbortController().signal;

const fakeClient = (impl: () => Promise<unknown>) => {
  const downloadWithProfile = jest.fn(impl);
  return {
    downloadWithProfile,
    downloader: new MetaMirrorDownloader({
      downloadWithProfile:
        downloadWithProfile as unknown as MetaMediaClient['downloadWithProfile'],
    }),
  };
};

describe('MetaMirrorDownloader', () => {
  it('downloads with the wider mirror profile and projects the file with a hex sha256', async () => {
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const sha256 = createHash('sha256').update(OGG).digest();
    const { downloader, downloadWithProfile } = fakeClient(() =>
      Promise.resolve({
        filePath: '/tmp/m',
        mimeType: 'audio/ogg',
        byteCount: OGG.length,
        providerDeclaredBytes: 70,
        sha256,
        cleanup,
      }),
    );
    const result = await downloader.download({
      providerMediaId: PROVIDER_ID,
      signal,
    });
    expect(downloadWithProfile).toHaveBeenCalledWith(
      { providerMediaId: PROVIDER_ID, signal },
      MIRROR_MEDIA_PROFILE,
    );
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value).toEqual({
      filePath: '/tmp/m',
      mimeType: 'audio/ogg',
      byteCount: OGG.length,
      sha256Hex: sha256.toString('hex'),
      cleanup: expect.any(Function) as unknown,
    });
    await result.value.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['UNSUPPORTED_MIME', 'MEDIA_VALIDATION', { reason: 'type_not_allowed' }],
    ['MIME_MISMATCH', 'MEDIA_VALIDATION', { reason: 'type_not_allowed' }],
    ['INVALID_MEDIA_SIZE', 'MEDIA_VALIDATION', { reason: 'too_large' }],
  ] as const)('maps %s to unsupported', async (code, category, expected) => {
    const { downloader } = fakeClient(() =>
      Promise.reject(new MetaMediaError(category, code)),
    );
    await expect(
      downloader.download({ providerMediaId: PROVIDER_ID, signal }),
    ).resolves.toEqual({ kind: 'unsupported', ...expected });
  });

  it.each([
    ['HTTP_RETRYABLE', { kind: 'retry', cause: 'source_transient' }],
    ['NETWORK_FAILURE', { kind: 'retry', cause: 'source_transient' }],
    ['TIMEOUT', { kind: 'retry', cause: 'source_transient' }],
    ['FILE_IO_FAILURE', { kind: 'retry', cause: 'local_io' }],
    ['ABORTED', { kind: 'retry', cause: 'aborted' }],
    ['HTTP_PERMANENT', { kind: 'unsupported', reason: 'media_unavailable' }],
  ] as const)('maps transport %s', async (code, expected) => {
    const { downloader } = fakeClient(() =>
      Promise.reject(new MetaMediaError('META_TRANSPORT', code)),
    );
    await expect(
      downloader.download({ providerMediaId: PROVIDER_ID, signal }),
    ).resolves.toEqual(expected);
  });

  it('parks an unknown (non-Meta) error instead of looping on it', async () => {
    const { downloader } = fakeClient(() =>
      Promise.reject(new Error(`boom for ${PROVIDER_ID}`)),
    );
    const result = await downloader.download({
      providerMediaId: PROVIDER_ID,
      signal,
    });
    expect(result).toEqual({ kind: 'park', reason: 'unexpected_response' });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_ID);
  });

  describe('against the real client (HTTP status decides the permanent case)', () => {
    const real = (status: number) => {
      const http: MetaHttp = (config: AxiosRequestConfig) =>
        Promise.resolve({
          status,
          data: config.responseType === 'stream' ? Readable.from([OGG]) : {},
        });
      const client = new MetaMediaClient(
        {
          graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
          allowedHosts: ['graph.facebook.com'],
          metadataTimeoutMs: 1000,
          downloadTimeoutMs: 1000,
        },
        () => 'token',
        {
          http,
          resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
          createAgent: () => ({ destroy: jest.fn() }) as unknown as Agent,
        },
      );
      return new MetaMirrorDownloader(client);
    };

    it.each([400, 404, 410])(
      'metadata %i (expired or unknown media) is unsupported media_unavailable',
      async (status) => {
        await expect(
          real(status).download({ providerMediaId: PROVIDER_ID, signal }),
        ).resolves.toEqual({
          kind: 'unsupported',
          reason: 'media_unavailable',
        });
      },
    );

    it.each([401, 403])(
      'metadata %i (expired Meta token) is a stop, never a silent UNSUPPORTED',
      async (status) => {
        await expect(
          real(status).download({ providerMediaId: PROVIDER_ID, signal }),
        ).resolves.toEqual({ kind: 'stop', reason: 'source_unauthorized' });
      },
    );

    it.each([429, 500, 503])('metadata %i is retryable', async (status) => {
      await expect(
        real(status).download({ providerMediaId: PROVIDER_ID, signal }),
      ).resolves.toEqual({ kind: 'retry', cause: 'source_transient' });
    });
  });
});

describe('MetaMirrorDownloader on the shipped default config (S7)', () => {
  const REAL_URL =
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=meta-media-123&ext=1763300000&hash=ATh';
  const ENV = [
    'META_MEDIA_ALLOWED_HOSTS',
    'META_GRAPH_API_BASE_URL',
    'META_MEDIA_METADATA_TIMEOUT_MS',
    'META_MEDIA_DOWNLOAD_TIMEOUT_MS',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('downloads media from a real-shaped lookaside URL with a query, over the validated IPv4', async () => {
    const urls: Array<string | undefined> = [];
    const lookups: LookupFunction[] = [];
    const http: MetaHttp = (config: AxiosRequestConfig) => {
      urls.push(config.url);
      return Promise.resolve(
        config.responseType === 'stream'
          ? { status: 200, data: Readable.from([OGG]), headers: {} }
          : {
              status: 200,
              data: {
                url: REAL_URL,
                mime_type: 'audio/ogg',
                file_size: OGG.length,
              },
            },
      );
    };
    const client = createMetaMediaClient(new ConfigService(configuration()), {
      http,
      resolve: () =>
        Promise.resolve([
          { address: '2a03:2880:f343:80:face:b00c:0:3', family: 6 },
          { address: '57.144.134.128', family: 4 },
        ]),
      createAgent: (lookup) => {
        lookups.push(lookup);
        return { destroy: jest.fn() } as unknown as Agent;
      },
    });
    const result = await new MetaMirrorDownloader(client).download({
      providerMediaId: PROVIDER_ID,
      signal,
    });
    if (result.kind !== 'ok') throw new Error(result.kind);
    try {
      expect(result.value.mimeType).toBe('audio/ogg');
      expect(urls).toEqual([
        `https://graph.facebook.com/v23.0/${PROVIDER_ID}`,
        REAL_URL,
      ]);
      const handed: string[] = [];
      lookups[1]('lookaside.fbsbx.com', {}, (_e, address) =>
        handed.push(address as string),
      );
      expect(handed).toEqual(['57.144.134.128']);
    } finally {
      await result.value.cleanup();
    }
  });
});
