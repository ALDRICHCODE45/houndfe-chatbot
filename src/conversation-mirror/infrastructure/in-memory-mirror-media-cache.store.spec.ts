import { InMemoryMirrorMediaCacheStore } from './in-memory-mirror-media-cache.store';
import { runMirrorMediaCacheStoreContract } from './mirror-media-cache.store.contract';

runMirrorMediaCacheStoreContract('InMemoryMirrorMediaCacheStore', () => {
  let now = new Date('2026-11-12T10:00:00.000Z');
  const store = new InMemoryMirrorMediaCacheStore(() => now);
  return {
    store,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
      return Promise.resolve();
    },
    now: () => now,
    cleanup: () => Promise.resolve(),
  };
});
