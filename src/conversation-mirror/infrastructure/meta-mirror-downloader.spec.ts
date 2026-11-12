import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Agent } from 'node:https';
import type { AxiosRequestConfig } from 'axios';
import { MetaMediaError } from '../../receipt-media/domain/meta-media.port';
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
