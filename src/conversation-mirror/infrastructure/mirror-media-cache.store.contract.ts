import type { MirrorMediaCacheStore } from '../domain/mirror-media-cache.store';

/** Behavior every cache store must show (in-memory and PostgreSQL). */
export interface CacheContractHarness {
  store: MirrorMediaCacheStore;
  /** Moves the store's notion of "now" forward. */
  advance(ms: number): Promise<void>;
  now(): Date;
  cleanup(): Promise<void>;
}

const KEY = '8b1f0d3e-4c52-5a91-9e0a-1f2e3d4c5b6a';
const OTHER = '9c2a1e4f-5d63-5ba2-8f1b-2a3f4e5d6c7b';
const MEDIA = '0b3f1c1e-8a53-4d6f-9c1b-2a4e5f6a7b8c';
const MEDIA_2 = '1c4a2d2f-9b64-4e70-8d2c-3b5f6a7b8c9d';
const DAY = 24 * 60 * 60 * 1000;

export function runMirrorMediaCacheStoreContract(
  name: string,
  make: () => CacheContractHarness | Promise<CacheContractHarness>,
  lifecycle: {
    beforeAll?: () => Promise<void>;
    afterAll?: () => Promise<void>;
    beforeEach?: () => Promise<void>;
    run?: typeof describe;
  } = {},
): void {
  const suite = lifecycle.run ?? describe;
  suite(`${name} cache contract`, () => {
    let h: CacheContractHarness;
    if (lifecycle.beforeAll) beforeAll(lifecycle.beforeAll);
    if (lifecycle.afterAll) afterAll(lifecycle.afterAll);
    beforeEach(async () => {
      await lifecycle.beforeEach?.();
      h = await make();
    });
    afterEach(async () => {
      await h.cleanup();
    });

    const entry = (
      over: Partial<{ idempotencyKey: string; mediaId: string }> = {},
    ) => ({
      idempotencyKey: KEY,
      mediaId: MEDIA,
      mimeType: 'image/jpeg',
      sizeBytes: 182344,
      ...over,
    });

    it('returns null for an unknown key', async () => {
      await expect(h.store.get(KEY)).resolves.toBeNull();
    });

    it('stores and reads an entry with created/last-used timestamps', async () => {
      await h.store.put(entry());
      const found = await h.store.get(KEY);
      expect(found).toMatchObject({
        idempotencyKey: KEY,
        mediaId: MEDIA,
        mimeType: 'image/jpeg',
        sizeBytes: 182344,
      });
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.lastUsedAt).toBeInstanceOf(Date);
    });

    it('upserts: a second put replaces the media id and restarts createdAt', async () => {
      await h.store.put(entry());
      const first = await h.store.get(KEY);
      await h.advance(2000);
      await h.store.put(entry({ mediaId: MEDIA_2 }));
      const second = await h.store.get(KEY);
      expect(second?.mediaId).toBe(MEDIA_2);
      expect(second!.createdAt.getTime()).toBeGreaterThan(
        first!.createdAt.getTime(),
      );
    });

    it('touch moves lastUsedAt forward without changing createdAt; touching an unknown key is a no-op', async () => {
      await h.store.put(entry());
      const before = await h.store.get(KEY);
      await h.advance(5000);
      const idle = await h.store.get(KEY);
      await h.store.touch(KEY);
      const after = await h.store.get(KEY);
      expect(after!.lastUsedAt.getTime()).toBeGreaterThan(
        before!.lastUsedAt.getTime(),
      );
      expect(after!.lastUsedAt.getTime()).toBeGreaterThan(
        idle!.lastUsedAt.getTime(),
      );
      expect(after!.createdAt.getTime()).toBe(idle!.createdAt.getTime());
      await expect(h.store.touch(OTHER)).resolves.toBeUndefined();
    });

    it('forget removes only that key and reports whether it existed', async () => {
      await h.store.put(entry());
      await h.store.put(entry({ idempotencyKey: OTHER, mediaId: MEDIA_2 }));
      await expect(h.store.forget(KEY)).resolves.toBe(true);
      await expect(h.store.forget(KEY)).resolves.toBe(false);
      await expect(h.store.get(KEY)).resolves.toBeNull();
      await expect(h.store.get(OTHER)).resolves.toMatchObject({
        mediaId: MEDIA_2,
      });
    });

    it('prunes entries unused since the cutoff and keeps recently used ones', async () => {
      await h.store.put(entry());
      await h.advance(40 * DAY);
      await h.store.put(entry({ idempotencyKey: OTHER, mediaId: MEDIA_2 }));
      const pruned = await h.store.pruneUnusedBefore(
        new Date(h.now().getTime() - 30 * DAY),
      );
      expect(pruned).toBe(1);
      await expect(h.store.get(KEY)).resolves.toBeNull();
      await expect(h.store.get(OTHER)).resolves.not.toBeNull();
    });

    it('a touched entry survives a prune that would have removed it', async () => {
      await h.store.put(entry());
      await h.advance(40 * DAY);
      await h.store.touch(KEY);
      await expect(
        h.store.pruneUnusedBefore(new Date(h.now().getTime() - 30 * DAY)),
      ).resolves.toBe(0);
      await expect(h.store.get(KEY)).resolves.not.toBeNull();
    });
  });
}
