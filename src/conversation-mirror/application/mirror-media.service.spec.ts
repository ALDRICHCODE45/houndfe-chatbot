import { mediaIdempotencyKey } from '../../chatbot-api/domain/uuid-v5';
import type { UploadMediaResult } from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import type {
  DownloadedMirrorFile,
  MirrorLinkFetcher,
  MirrorMediaContractType,
  MirrorMetaDownloader,
  MirrorSourceResult,
  OpenedMirrorLink,
} from '../domain/mirror-media';
import { InMemoryMirrorMediaCacheStore } from '../infrastructure/in-memory-mirror-media-cache.store';
import { MirrorMediaService } from './mirror-media.service';

const PROVIDER_ID = 'meta-media-777';
const URL_PHOTO = 'https://cdn.example.com/p/croquetas.jpg';
const MEDIA_ID = '0b3f1c1e-8a53-4d6f-9c1b-2a4e5f6a7b8c';
const MEDIA_ID_2 = '1c4a2d2f-9b64-4e70-8d2c-3b5f6a7b8c9d';
const SHA = 'ab'.repeat(32);
const DAY = 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const uploaded = (over: Record<string, unknown> = {}): UploadMediaResult => ({
  kind: 'ok',
  created: true,
  mediaId: MEDIA_ID,
  mimeType: 'image/jpeg',
  sizeBytes: 100,
  sha256: SHA,
  ...over,
});

const makeFile = (over: Partial<DownloadedMirrorFile> = {}) => {
  const file: DownloadedMirrorFile = {
    filePath: '/tmp/mirror-file',
    mimeType: 'image/jpeg',
    byteCount: 100,
    sha256Hex: SHA,
    cleanup: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
  return file;
};
const ok = <T>(value: T): MirrorSourceResult<T> => ({ kind: 'ok', value });

function setup(
  options: {
    clockStart?: Date;
    maxConcurrency?: number;
  } = {},
) {
  let now = options.clockStart ?? new Date('2026-11-12T10:00:00.000Z');
  const files: DownloadedMirrorFile[] = [];
  const nextFile = (over: Partial<DownloadedMirrorFile> = {}) => {
    const file = makeFile(over);
    files.push(file);
    return file;
  };
  const meta = {
    download: jest.fn<
      Promise<MirrorSourceResult<DownloadedMirrorFile>>,
      [{ providerMediaId: string; signal: AbortSignal }]
    >(() => Promise.resolve(ok(nextFile()))),
  } satisfies MirrorMetaDownloader;
  const links = {
    open: jest.fn<
      Promise<MirrorSourceResult<OpenedMirrorLink>>,
      [{ url: string; signal: AbortSignal }]
    >(),
  } satisfies MirrorLinkFetcher;
  const openLink = (version: string | null = '"v1"') => {
    const link = {
      version,
      discard: jest.fn(),
      download: jest.fn(() => Promise.resolve(ok(nextFile()))),
    } satisfies OpenedMirrorLink;
    return link;
  };
  const defaultLink = openLink();
  links.open.mockResolvedValue(ok(defaultLink as OpenedMirrorLink));
  const client = {
    uploadMedia: jest.fn<Promise<UploadMediaResult>, [unknown]>(() =>
      Promise.resolve(uploaded()),
    ),
  };
  const cache = new InMemoryMirrorMediaCacheStore(() => now);
  const service = new MirrorMediaService({
    client,
    meta,
    links,
    cache,
    clock: () => now,
    maxConcurrency: options.maxConcurrency,
  });
  return {
    service,
    meta,
    links,
    client,
    cache,
    files,
    nextFile,
    openLink,
    defaultLink,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

const inMedia = (over: Record<string, unknown> = {}) => ({
  providerMediaId: PROVIDER_ID,
  mimeType: 'image/jpeg',
  ...over,
});
const outMedia = { link: URL_PHOTO };

describe('MirrorMediaService.resolveMedia (IN: Meta media id)', () => {
  it('downloads, uploads with the media idempotency key and the sha256, and returns the mediaId', async () => {
    const t = setup();
    const outcome = await t.service.resolveMedia(
      inMedia({ filename: 'foto.jpg' }),
      'IMAGE',
    );
    expect(outcome).toEqual({
      kind: 'ok',
      mediaId: MEDIA_ID,
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      from: 'upload',
    });
    expect(t.meta.download).toHaveBeenCalledTimes(1);
    expect(t.meta.download.mock.calls[0][0].providerMediaId).toBe(PROVIDER_ID);
    expect(t.client.uploadMedia).toHaveBeenCalledTimes(1);
    expect(t.client.uploadMedia.mock.calls[0][0]).toMatchObject({
      filePath: '/tmp/mirror-file',
      sha256: SHA,
      filename: 'foto.jpg',
      idempotencyKey: mediaIdempotencyKey(PROVIDER_ID),
    });
    expect(t.files[0].cleanup).toHaveBeenCalledTimes(1);
  });

  it('caches the id: a second resolve neither downloads nor uploads (S1)', async () => {
    const t = setup();
    await t.service.resolveMedia(inMedia(), 'IMAGE');
    const second = await t.service.resolveMedia(inMedia(), 'IMAGE');
    expect(second).toEqual({
      kind: 'ok',
      mediaId: MEDIA_ID,
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      from: 'cache',
    });
    expect(t.meta.download).toHaveBeenCalledTimes(1);
    expect(t.client.uploadMedia).toHaveBeenCalledTimes(1);
    await expect(
      t.cache.get(mediaIdempotencyKey(PROVIDER_ID)),
    ).resolves.toMatchObject({ mediaId: MEDIA_ID, mimeType: 'image/jpeg' });
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an empty object', {}],
    ['a blank id', { providerMediaId: '  ' }],
    ['a numeric id', { providerMediaId: 12 }],
    ['a non-string link', { link: 5 }],
  ])('parks an invalid payload (%s) without any I/O', async (_n, media) => {
    const t = setup();
    await expect(t.service.resolveMedia(media, 'IMAGE')).resolves.toEqual({
      kind: 'park',
      reason: 'invalid_payload',
    });
    const badType = 'VIDEO' as unknown as MirrorMediaContractType;
    await expect(t.service.resolveMedia(inMedia(), badType)).resolves.toEqual({
      kind: 'park',
      reason: 'invalid_payload',
    });
    expect(t.meta.download).not.toHaveBeenCalled();
    expect(t.client.uploadMedia).not.toHaveBeenCalled();
  });

  it('answers unsupported without calling Meta when the declared mime is not storable (a video)', async () => {
    const t = setup();
    await expect(
      t.service.resolveMedia(inMedia({ mimeType: 'video/mp4' }), 'IMAGE'),
    ).resolves.toEqual({ kind: 'unsupported', reason: 'type_not_allowed' });
    expect(t.meta.download).not.toHaveBeenCalled();
  });

  it('accepts a declared mime with parameters and a missing declared mime', async () => {
    const t = setup();
    t.meta.download.mockImplementation(() =>
      Promise.resolve(ok(t.nextFile({ mimeType: 'audio/ogg' }))),
    );
    await expect(
      t.service.resolveMedia(
        inMedia({ mimeType: 'audio/ogg; codecs=opus' }),
        'AUDIO',
      ),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      t.service.resolveMedia(
        { providerMediaId: 'other-id', mimeType: undefined },
        'AUDIO',
      ),
    ).resolves.toMatchObject({ kind: 'ok' });
  });

  it.each([
    ['IMAGE', 'application/pdf'],
    ['DOCUMENT', 'image/jpeg'],
    ['AUDIO', 'image/webp'],
    ['IMAGE', 'audio/ogg'],
  ] as const)(
    'a %s whose bytes are %s is unsupported type_mismatch: no upload, temp file removed',
    async (type, mime) => {
      const t = setup();
      t.meta.download.mockImplementation(() =>
        Promise.resolve(ok(t.nextFile({ mimeType: mime }))),
      );
      await expect(
        t.service.resolveMedia({ providerMediaId: 'x-1' }, type),
      ).resolves.toEqual({ kind: 'unsupported', reason: 'type_mismatch' });
      expect(t.client.uploadMedia).not.toHaveBeenCalled();
      expect(t.files[0].cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it('a cached id whose type no longer fits the message is type_mismatch', async () => {
    const t = setup();
    await t.service.resolveMedia(inMedia(), 'IMAGE');
    await expect(
      t.service.resolveMedia(inMedia(), 'DOCUMENT'),
    ).resolves.toEqual({ kind: 'unsupported', reason: 'type_mismatch' });
  });

  describe('source failures pass through', () => {
    it.each([
      [
        { kind: 'unsupported', reason: 'media_unavailable' },
        { kind: 'unsupported', reason: 'media_unavailable' },
      ],
      [
        { kind: 'unsupported', reason: 'too_large' },
        { kind: 'unsupported', reason: 'too_large' },
      ],
      [
        { kind: 'retry', cause: 'source_transient' },
        { kind: 'retry', cause: 'source_transient', retryAfterSeconds: null },
      ],
      [
        { kind: 'retry', cause: 'local_io' },
        { kind: 'retry', cause: 'local_io', retryAfterSeconds: null },
      ],
      [
        { kind: 'stop', reason: 'source_unauthorized' },
        { kind: 'stop', reason: 'source_unauthorized' },
      ],
      [
        { kind: 'park', reason: 'unexpected_response' },
        { kind: 'park', reason: 'unexpected_response' },
      ],
    ] as const)('%j', async (failure, expected) => {
      const t = setup();
      t.meta.download.mockResolvedValue(failure);
      await expect(t.service.resolveMedia(inMedia(), 'IMAGE')).resolves.toEqual(
        expected,
      );
      expect(t.client.uploadMedia).not.toHaveBeenCalled();
    });

    it('does not cache a failure', async () => {
      const t = setup();
      t.meta.download.mockResolvedValueOnce({
        kind: 'retry',
        cause: 'source_transient',
      });
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      await expect(
        t.service.resolveMedia(inMedia(), 'IMAGE'),
      ).resolves.toMatchObject({ kind: 'ok', from: 'upload' });
    });
  });

  describe('upload reactions (S4)', () => {
    it.each<[string, UploadMediaResult, unknown]>([
      [
        '413 MEDIA_TOO_LARGE (remote)',
        { kind: 'MEDIA_TOO_LARGE', local: false },
        { kind: 'unsupported', reason: 'too_large' },
      ],
      [
        'local 10 MiB cap',
        { kind: 'MEDIA_TOO_LARGE', local: true },
        { kind: 'unsupported', reason: 'too_large' },
      ],
      [
        '415 MEDIA_TYPE_NOT_ALLOWED',
        { kind: 'MEDIA_TYPE_NOT_ALLOWED' },
        { kind: 'unsupported', reason: 'type_not_allowed' },
      ],
      [
        '503 MEDIA_STORAGE_FAILED',
        { kind: 'MEDIA_STORAGE_FAILED', retryAfterSeconds: 5 },
        { kind: 'retry', cause: 'storage_failed', retryAfterSeconds: 5 },
      ],
      [
        '429',
        { kind: 'RATE_LIMITED', retryAfterSeconds: 12 },
        { kind: 'retry', cause: 'rate_limited', retryAfterSeconds: 12 },
      ],
      [
        '5xx',
        {
          kind: 'RETRYABLE',
          cause: 'http_5xx',
          status: 502,
          retryAfterSeconds: 3,
        },
        { kind: 'retry', cause: 'backend_unavailable', retryAfterSeconds: 3 },
      ],
      [
        'timeout',
        {
          kind: 'RETRYABLE',
          cause: 'timeout',
          status: null,
          retryAfterSeconds: null,
        },
        {
          kind: 'retry',
          cause: 'backend_unavailable',
          retryAfterSeconds: null,
        },
      ],
      [
        'aborted',
        { kind: 'ABORTED' },
        { kind: 'retry', cause: 'aborted', retryAfterSeconds: null },
      ],
      [
        '401',
        { kind: 'UNAUTHORIZED' },
        { kind: 'stop', reason: 'backend_unauthorized' },
      ],
      [
        '403',
        { kind: 'FORBIDDEN', code: 'INSUFFICIENT_SCOPE' },
        { kind: 'stop', reason: 'backend_forbidden' },
      ],
      [
        '409 IDEMPOTENCY_CONFLICT',
        { kind: 'IDEMPOTENCY_CONFLICT' },
        { kind: 'park', reason: 'idempotency_conflict' },
      ],
      [
        '400 without a sha',
        {
          kind: 'VALIDATION_ERROR',
          message: 'x',
          local: false,
          shaSent: false,
        },
        { kind: 'park', reason: 'validation' },
      ],
      [
        'local validation even with a sha',
        { kind: 'VALIDATION_ERROR', message: 'x', local: true, shaSent: true },
        { kind: 'park', reason: 'validation' },
      ],
      [
        'undocumented answer',
        { kind: 'UNEXPECTED', status: 418, code: null },
        { kind: 'park', reason: 'unexpected_response' },
      ],
      [
        'BODY_TOO_LARGE',
        { kind: 'BODY_TOO_LARGE' },
        { kind: 'park', reason: 'unexpected_response' },
      ],
    ])('%s', async (_name, result, expected) => {
      const t = setup();
      t.client.uploadMedia.mockResolvedValue(result);
      await expect(t.service.resolveMedia(inMedia(), 'IMAGE')).resolves.toEqual(
        expected,
      );
      expect(t.meta.download).toHaveBeenCalledTimes(1);
      expect(t.files[0].cleanup).toHaveBeenCalledTimes(1);
      await expect(
        t.cache.get(mediaIdempotencyKey(PROVIDER_ID)),
      ).resolves.toBeNull();
    });

    it('a 400 with a sha256 re-downloads once and succeeds', async () => {
      const t = setup();
      t.client.uploadMedia
        .mockResolvedValueOnce({
          kind: 'VALIDATION_ERROR',
          message: 'sha256 mismatch',
          local: false,
          shaSent: true,
        })
        .mockResolvedValueOnce(uploaded());
      await expect(
        t.service.resolveMedia(inMedia(), 'IMAGE'),
      ).resolves.toMatchObject({ kind: 'ok', mediaId: MEDIA_ID });
      expect(t.meta.download).toHaveBeenCalledTimes(2);
      expect(t.client.uploadMedia).toHaveBeenCalledTimes(2);
      expect(t.files).toHaveLength(2);
      for (const file of t.files) expect(file.cleanup).toHaveBeenCalledTimes(1);
    });

    it('a persistent sha mismatch parks after the single re-download', async () => {
      const t = setup();
      t.client.uploadMedia.mockResolvedValue({
        kind: 'VALIDATION_ERROR',
        message: 'sha256 mismatch',
        local: false,
        shaSent: true,
      });
      await expect(t.service.resolveMedia(inMedia(), 'IMAGE')).resolves.toEqual(
        {
          kind: 'park',
          reason: 'sha_mismatch',
        },
      );
      expect(t.meta.download).toHaveBeenCalledTimes(2);
      expect(t.client.uploadMedia).toHaveBeenCalledTimes(2);
      for (const file of t.files) expect(file.cleanup).toHaveBeenCalledTimes(1);
    });

    it('a local source error re-downloads once, then parks', async () => {
      const t = setup();
      t.client.uploadMedia.mockResolvedValue({ kind: 'LOCAL_SOURCE_ERROR' });
      await expect(t.service.resolveMedia(inMedia(), 'IMAGE')).resolves.toEqual(
        {
          kind: 'park',
          reason: 'local_source_error',
        },
      );
      expect(t.meta.download).toHaveBeenCalledTimes(2);
      for (const file of t.files) expect(file.cleanup).toHaveBeenCalledTimes(1);
    });

    it('removes the temp file and parks when the client unexpectedly throws', async () => {
      const t = setup();
      t.client.uploadMedia.mockRejectedValue(new Error(`boom ${PROVIDER_ID}`));
      const outcome = await t.service.resolveMedia(inMedia(), 'IMAGE');
      expect(outcome).toEqual({ kind: 'park', reason: 'unexpected_response' });
      expect(JSON.stringify(outcome)).not.toContain(PROVIDER_ID);
      expect(t.files[0].cleanup).toHaveBeenCalledTimes(1);
    });

    it('a failing temp-file cleanup never changes the outcome', async () => {
      const t = setup();
      t.meta.download.mockImplementation(() =>
        Promise.resolve(
          ok(
            t.nextFile({
              cleanup: jest.fn().mockRejectedValue(new Error('io')),
            }),
          ),
        ),
      );
      await expect(
        t.service.resolveMedia(inMedia(), 'IMAGE'),
      ).resolves.toMatchObject({ kind: 'ok' });
    });
  });

  describe('force and forget', () => {
    it('force skips the cache, re-downloads, uploads under a fresh key and updates the cache', async () => {
      const t = setup();
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      t.client.uploadMedia.mockResolvedValue(uploaded({ mediaId: MEDIA_ID_2 }));
      t.advance(1000);
      const forced = await t.service.resolveMedia(inMedia(), 'IMAGE', {
        force: true,
      });
      expect(forced).toMatchObject({
        kind: 'ok',
        mediaId: MEDIA_ID_2,
        from: 'upload',
      });
      expect(t.meta.download).toHaveBeenCalledTimes(2);
      const keys = t.client.uploadMedia.mock.calls.map(
        (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
      );
      expect(keys[0]).toBe(mediaIdempotencyKey(PROVIDER_ID));
      expect(keys[1]).toMatch(UUID);
      expect(keys[1]).not.toBe(keys[0]);
      await expect(
        t.service.resolveMedia(inMedia(), 'IMAGE'),
      ).resolves.toMatchObject({ mediaId: MEDIA_ID_2, from: 'cache' });
    });

    it('forget(key) drops the entry so the next resolve downloads and uploads again', async () => {
      const t = setup();
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      await expect(
        t.service.forget(mediaIdempotencyKey(PROVIDER_ID)),
      ).resolves.toBe(true);
      await expect(
        t.service.forget(mediaIdempotencyKey(PROVIDER_ID)),
      ).resolves.toBe(false);
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      expect(t.meta.download).toHaveBeenCalledTimes(2);
    });

    it('an entry older than the max age is refreshed under a fresh key (the backend may have purged it)', async () => {
      const t = setup();
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      t.advance(200 * DAY);
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      expect(t.meta.download).toHaveBeenCalledTimes(2);
      const keys = t.client.uploadMedia.mock.calls.map(
        (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
      );
      expect(keys[1]).not.toBe(keys[0]);
    });
  });

  describe('cache resilience and upkeep', () => {
    it('touches a stale entry on a hit but not a fresh one', async () => {
      const t = setup();
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      const touch = jest.spyOn(t.cache, 'touch');
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      await flush();
      expect(touch).not.toHaveBeenCalled();
      t.advance(2 * DAY);
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      await flush();
      expect(touch).toHaveBeenCalledTimes(1);
    });

    it('a cache read failure falls back to the download; a write failure is ignored', async () => {
      const t = setup();
      jest.spyOn(t.cache, 'get').mockRejectedValue(new Error('db down'));
      jest.spyOn(t.cache, 'put').mockRejectedValue(new Error('db down'));
      await expect(
        t.service.resolveMedia(inMedia(), 'IMAGE'),
      ).resolves.toMatchObject({ kind: 'ok', from: 'upload' });
    });

    it('prunes entries unused for 30 days (explicitly and lazily at most once an hour)', async () => {
      const t = setup();
      const prune = jest.spyOn(t.cache, 'pruneUnusedBefore');
      await t.service.resolveMedia(inMedia(), 'IMAGE');
      await flush();
      expect(prune).toHaveBeenCalledTimes(1);
      expect(prune.mock.calls[0][0].getTime()).toBe(
        t.now().getTime() - 30 * DAY,
      );
      await t.service.resolveMedia({ providerMediaId: 'second-id' }, 'IMAGE');
      await flush();
      expect(prune).toHaveBeenCalledTimes(1);
      t.advance(2 * 60 * 60 * 1000);
      await t.service.resolveMedia({ providerMediaId: 'third-id' }, 'IMAGE');
      await flush();
      expect(prune).toHaveBeenCalledTimes(2);
      await expect(t.service.pruneStale()).resolves.toEqual(expect.any(Number));
      prune.mockRejectedValue(new Error('db down'));
      await expect(t.service.pruneStale()).resolves.toBe(0);
    });
  });

  describe('concurrency, singleflight and abort', () => {
    it('never runs more than 2 transfers at once and completes all (S1)', async () => {
      const t = setup();
      let active = 0;
      let peak = 0;
      const gates: Array<ReturnType<typeof gate>> = [];
      t.meta.download.mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        const g = gate();
        gates.push(g);
        await g.promise;
        active -= 1;
        return ok(t.nextFile());
      });
      const runs = Array.from({ length: 6 }, (_v, i) =>
        t.service.resolveMedia({ providerMediaId: `id-${i}` }, 'IMAGE'),
      );
      await flush();
      expect(gates).toHaveLength(2);
      for (let i = 0; i < 6; i += 1) {
        while (gates[i] === undefined) await flush();
        gates[i].open();
        await flush();
      }
      const outcomes = await Promise.all(runs);
      expect(outcomes.every((o) => o.kind === 'ok')).toBe(true);
      expect(peak).toBe(2);
    });

    it('uploads also stay inside the bound (download+upload is one permit)', async () => {
      const t = setup({ maxConcurrency: 1 });
      let active = 0;
      let peak = 0;
      t.client.uploadMedia.mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await flush();
        active -= 1;
        return uploaded();
      });
      await Promise.all(
        Array.from({ length: 4 }, (_v, i) =>
          t.service.resolveMedia({ providerMediaId: `u-${i}` }, 'IMAGE'),
        ),
      );
      expect(peak).toBe(1);
    });

    it('concurrent resolves of the same media share one transfer', async () => {
      const t = setup();
      const g = gate();
      t.meta.download.mockImplementation(async () => {
        await g.promise;
        return ok(t.nextFile());
      });
      const runs = [
        t.service.resolveMedia(inMedia(), 'IMAGE'),
        t.service.resolveMedia(inMedia(), 'IMAGE'),
        t.service.resolveMedia(inMedia(), 'IMAGE'),
      ];
      await flush();
      g.open();
      const outcomes = await Promise.all(runs);
      expect(outcomes.map((o) => o.kind)).toEqual(['ok', 'ok', 'ok']);
      expect(t.meta.download).toHaveBeenCalledTimes(1);
      expect(t.client.uploadMedia).toHaveBeenCalledTimes(1);
    });

    it('an already-aborted signal does nothing and is retryable aborted', async () => {
      const t = setup();
      const controller = new AbortController();
      controller.abort();
      await expect(
        t.service.resolveMedia(inMedia(), 'IMAGE', {
          signal: controller.signal,
        }),
      ).resolves.toEqual({
        kind: 'retry',
        cause: 'aborted',
        retryAfterSeconds: null,
      });
      expect(t.meta.download).not.toHaveBeenCalled();
    });

    it('passes the signal to the download and the upload', async () => {
      const t = setup();
      const controller = new AbortController();
      await t.service.resolveMedia(inMedia(), 'IMAGE', {
        signal: controller.signal,
      });
      expect(t.meta.download.mock.calls[0][0].signal).toBe(controller.signal);
      expect(t.client.uploadMedia.mock.calls[0][0]).toMatchObject({
        signal: controller.signal,
      });
    });

    it('aborting while waiting for a permit stops before any transfer', async () => {
      const t = setup({ maxConcurrency: 1 });
      const g = gate();
      t.meta.download.mockImplementationOnce(async () => {
        await g.promise;
        return ok(t.nextFile());
      });
      const first = t.service.resolveMedia({ providerMediaId: 'a' }, 'IMAGE');
      await flush();
      const controller = new AbortController();
      const second = t.service.resolveMedia({ providerMediaId: 'b' }, 'IMAGE', {
        signal: controller.signal,
      });
      await flush();
      controller.abort();
      g.open();
      await first;
      await expect(second).resolves.toMatchObject({
        kind: 'retry',
        cause: 'aborted',
      });
      expect(t.meta.download).toHaveBeenCalledTimes(1);
    });
  });
});

describe('MirrorMediaService.resolveMedia (OUT: public link)', () => {
  it('opens the link, keys the upload by URL + ETag, uploads and caches', async () => {
    const t = setup();
    const outcome = await t.service.resolveMedia(outMedia, 'IMAGE');
    expect(outcome).toMatchObject({ kind: 'ok', from: 'upload' });
    expect(t.links.open.mock.calls[0][0].url).toBe(URL_PHOTO);
    expect(t.meta.download).not.toHaveBeenCalled();
    expect(t.defaultLink.download).toHaveBeenCalledTimes(1);
    expect(t.client.uploadMedia.mock.calls[0][0]).toMatchObject({
      idempotencyKey: mediaIdempotencyKey(URL_PHOTO, '"v1"'),
      sha256: SHA,
    });
  });

  it.each([
    ['an ETag', '"e1"'],
    ['a Last-Modified', 'Tue, 10 Nov 2026 10:00:00 GMT'],
    ['no validator', null],
  ])('the key carries %s as the version (S5 #1)', async (_n, version) => {
    const t = setup();
    t.links.open.mockResolvedValue(ok(t.openLink(version) as OpenedMirrorLink));
    await t.service.resolveMedia(outMedia, 'IMAGE');
    expect(t.client.uploadMedia.mock.calls[0][0]).toMatchObject({
      idempotencyKey:
        version === null
          ? mediaIdempotencyKey(URL_PHOTO)
          : mediaIdempotencyKey(URL_PHOTO, version),
    });
  });

  it('a cached photo is not downloaded or uploaded: the unread body is discarded', async () => {
    const t = setup();
    await t.service.resolveMedia(outMedia, 'IMAGE');
    const second = t.openLink();
    t.links.open.mockResolvedValue(ok(second as OpenedMirrorLink));
    // Skip the version memo so the headers are checked again.
    t.advance(60 * 60 * 1000);
    await expect(
      t.service.resolveMedia(outMedia, 'IMAGE'),
    ).resolves.toMatchObject({ kind: 'ok', from: 'cache' });
    expect(second.discard).toHaveBeenCalledTimes(1);
    expect(second.download).not.toHaveBeenCalled();
    expect(t.client.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('a changed ETag under the same URL is a new key and uploads again', async () => {
    const t = setup();
    await t.service.resolveMedia(outMedia, 'IMAGE');
    t.advance(60 * 60 * 1000);
    t.links.open.mockResolvedValue(ok(t.openLink('"v2"') as OpenedMirrorLink));
    t.client.uploadMedia.mockResolvedValue(uploaded({ mediaId: MEDIA_ID_2 }));
    await expect(
      t.service.resolveMedia(outMedia, 'IMAGE'),
    ).resolves.toMatchObject({ mediaId: MEDIA_ID_2, from: 'upload' });
    expect(t.client.uploadMedia.mock.calls[1][0]).toMatchObject({
      idempotencyKey: mediaIdempotencyKey(URL_PHOTO, '"v2"'),
    });
  });

  it('the same photo sent to many customers costs one fetch within the version memo window', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1)
      await t.service.resolveMedia(outMedia, 'IMAGE');
    expect(t.links.open).toHaveBeenCalledTimes(1);
    expect(t.client.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('force ignores the memo and the cache, and uploads under a fresh key', async () => {
    const t = setup();
    await t.service.resolveMedia(outMedia, 'IMAGE');
    t.advance(1000);
    t.client.uploadMedia.mockResolvedValue(uploaded({ mediaId: MEDIA_ID_2 }));
    await expect(
      t.service.resolveMedia(outMedia, 'IMAGE', { force: true }),
    ).resolves.toMatchObject({ mediaId: MEDIA_ID_2, from: 'upload' });
    expect(t.links.open).toHaveBeenCalledTimes(2);
    const key = (
      t.client.uploadMedia.mock.calls[1][0] as {
        idempotencyKey: string;
      }
    ).idempotencyKey;
    expect(key).toMatch(UUID);
    expect(key).not.toBe(mediaIdempotencyKey(URL_PHOTO, '"v1"'));
    await expect(
      t.service.resolveMedia(outMedia, 'IMAGE'),
    ).resolves.toMatchObject({ mediaId: MEDIA_ID_2, from: 'cache' });
  });

  it('forget(key) clears the cache entry and the memo for that key', async () => {
    const t = setup();
    await t.service.resolveMedia(outMedia, 'IMAGE');
    await t.service.forget(mediaIdempotencyKey(URL_PHOTO, '"v1"'));
    await t.service.resolveMedia(outMedia, 'IMAGE');
    expect(t.links.open).toHaveBeenCalledTimes(2);
    expect(t.client.uploadMedia).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      { kind: 'unsupported', reason: 'media_unavailable' },
      { kind: 'unsupported', reason: 'media_unavailable' },
    ],
    [
      { kind: 'retry', cause: 'source_transient' },
      { kind: 'retry', cause: 'source_transient', retryAfterSeconds: null },
    ],
  ] as const)('open failure %j', async (failure, expected) => {
    const t = setup();
    t.links.open.mockResolvedValue(failure);
    await expect(t.service.resolveMedia(outMedia, 'IMAGE')).resolves.toEqual(
      expected,
    );
    expect(t.client.uploadMedia).not.toHaveBeenCalled();
  });

  it('a download failure after open is mapped, and the body is not left open', async () => {
    const t = setup();
    const link = t.openLink();
    link.download.mockResolvedValue({
      kind: 'unsupported',
      reason: 'too_large',
    });
    t.links.open.mockResolvedValue(ok(link as OpenedMirrorLink));
    await expect(t.service.resolveMedia(outMedia, 'IMAGE')).resolves.toEqual({
      kind: 'unsupported',
      reason: 'too_large',
    });
  });

  it('a link type mismatch (a PDF url sent as IMAGE) is unsupported and the temp file removed', async () => {
    const t = setup();
    const link = t.openLink();
    link.download.mockImplementation(() =>
      Promise.resolve(ok(t.nextFile({ mimeType: 'application/pdf' }))),
    );
    t.links.open.mockResolvedValue(ok(link as OpenedMirrorLink));
    await expect(t.service.resolveMedia(outMedia, 'IMAGE')).resolves.toEqual({
      kind: 'unsupported',
      reason: 'type_mismatch',
    });
    expect(t.files[0].cleanup).toHaveBeenCalledTimes(1);
    expect(t.client.uploadMedia).not.toHaveBeenCalled();
  });

  it('a sha mismatch re-opens the link once and re-downloads', async () => {
    const t = setup();
    t.client.uploadMedia
      .mockResolvedValueOnce({
        kind: 'VALIDATION_ERROR',
        message: 'sha',
        local: false,
        shaSent: true,
      })
      .mockResolvedValueOnce(uploaded());
    await expect(
      t.service.resolveMedia(outMedia, 'IMAGE'),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(t.links.open).toHaveBeenCalledTimes(2);
    for (const file of t.files) expect(file.cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps a distinct memo and cache per URL', async () => {
    const t = setup();
    await t.service.resolveMedia(outMedia, 'IMAGE');
    await t.service.resolveMedia({ link: `${URL_PHOTO}?other=1` }, 'IMAGE');
    expect(t.links.open).toHaveBeenCalledTimes(2);
    expect(t.client.uploadMedia).toHaveBeenCalledTimes(2);
  });

  it('prefers the Meta id when a payload (wrongly) carries both', async () => {
    const t = setup();
    await t.service.resolveMedia(
      { providerMediaId: PROVIDER_ID, link: URL_PHOTO },
      'IMAGE',
    );
    expect(t.meta.download).toHaveBeenCalledTimes(1);
    expect(t.links.open).not.toHaveBeenCalled();
  });
});
