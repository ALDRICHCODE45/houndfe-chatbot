import type { WebhookDedupStore } from '../domain/webhook-dedup.store';

/**
 * Shared behavior contract for every WebhookDedupStore adapter.
 *
 * Mirrors the conversation-store.contract pattern: the in-memory adapter
 * runs it always; the Postgres adapter runs it under the RUN_DOCKER_TESTS
 * gate so adapters cannot drift.
 */
export function runWebhookDedupContract(
  label: string,
  factory: () => Promise<{ store: WebhookDedupStore; cleanup: () => Promise<void> }>,
): void {
  describe(`${label} (dedup contract)`, () => {
    let store: WebhookDedupStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await factory());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('reports a fresh message id as NOT a duplicate', async () => {
      await expect(store.isDuplicate('wamid.fresh')).resolves.toBe(false);
    });

    it('reports a message id as a duplicate AFTER markSeen', async () => {
      await store.markSeen('wamid.once');
      await expect(store.isDuplicate('wamid.once')).resolves.toBe(true);
    });

    it('markSeen is idempotent (double mark does not throw)', async () => {
      await store.markSeen('wamid.twice');
      await expect(store.markSeen('wamid.twice')).resolves.toBeUndefined();
      await expect(store.isDuplicate('wamid.twice')).resolves.toBe(true);
    });

    it('does not collide between distinct message ids', async () => {
      await store.markSeen('wamid.a');
      await expect(store.isDuplicate('wamid.a')).resolves.toBe(true);
      await expect(store.isDuplicate('wamid.b')).resolves.toBe(false);
    });

    it('supports many ids without error', async () => {
      for (let i = 0; i < 50; i++) {
        await store.markSeen(`wamid.bulk-${i}`);
      }
      for (let i = 0; i < 50; i++) {
        await expect(store.isDuplicate(`wamid.bulk-${i}`)).resolves.toBe(true);
      }
      await expect(store.isDuplicate('wamid.bulk-999')).resolves.toBe(false);
    });
  });
}
