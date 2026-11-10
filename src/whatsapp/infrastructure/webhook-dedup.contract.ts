import {
  WEBHOOK_CLAIM_LEASE_MS,
  type WebhookDedupStore,
} from '../domain/webhook-dedup.store';

/**
 * Shared behavior contract for every WebhookDedupStore adapter.
 *
 * Mirrors the conversation-store.contract pattern: the in-memory adapter
 * runs it always; the Postgres adapter runs it under the RUN_DOCKER_TESTS
 * gate so adapters cannot drift. The factory receives the contract's clock
 * so leases and purge cutoffs are deterministic in both adapters.
 */
export function runWebhookDedupContract(
  label: string,
  factory: (now: () => Date) => Promise<{
    store: WebhookDedupStore;
    cleanup: () => Promise<void>;
  }>,
): void {
  describe(`${label} (dedup contract)`, () => {
    const T0 = new Date('2026-11-09T16:00:00.000Z').getTime();
    const DAY_MS = 24 * 60 * 60_000;
    let nowMs = T0;
    const now = () => new Date(nowMs);
    const advance = (ms: number) => {
      nowMs += ms;
    };
    let store: WebhookDedupStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      nowMs = T0;
      ({ store, cleanup } = await factory(now));
    });

    afterEach(async () => {
      await cleanup();
    });

    it('claims a fresh message id', async () => {
      await expect(store.claim('wamid.fresh')).resolves.toEqual(
        expect.any(String),
      );
    });

    it('reports a live claim as a duplicate', async () => {
      await store.claim('wamid.live');
      advance(WEBHOOK_CLAIM_LEASE_MS - 1000);
      await expect(store.claim('wamid.live')).resolves.toBeNull();
    });

    it('lets exactly one of several concurrent claims win', async () => {
      const tokens = await Promise.all(
        Array.from({ length: 8 }, () => store.claim('wamid.race')),
      );
      expect(tokens.filter((token) => token !== null)).toHaveLength(1);
    });

    it('lets a redelivery take over an expired claim', async () => {
      const first = await store.claim('wamid.crashed');
      advance(WEBHOOK_CLAIM_LEASE_MS);
      const second = await store.claim('wamid.crashed');
      expect(second).toEqual(expect.any(String));
      expect(second).not.toBe(first);
      await expect(store.claim('wamid.crashed')).resolves.toBeNull();
    });

    it('treats a DONE message as a duplicate forever (until purged)', async () => {
      await store.claim('wamid.done');
      await store.markSeen('wamid.done');
      await expect(store.claim('wamid.done')).resolves.toBeNull();
      advance(7 * DAY_MS);
      await expect(store.claim('wamid.done')).resolves.toBeNull();
    });

    it('records DONE without a prior claim', async () => {
      await store.markSeen('wamid.unclaimed');
      await expect(store.claim('wamid.unclaimed')).resolves.toBeNull();
    });

    it('markSeen is idempotent (double mark does not throw)', async () => {
      await store.markSeen('wamid.twice');
      await expect(store.markSeen('wamid.twice')).resolves.toBeUndefined();
      await expect(store.claim('wamid.twice')).resolves.toBeNull();
    });

    it('release lets the redelivery process the message again', async () => {
      const token = await store.claim('wamid.failed');
      await store.release('wamid.failed', token as string);
      await expect(store.claim('wamid.failed')).resolves.toEqual(
        expect.any(String),
      );
    });

    it('a stale release never drops the claim that took over', async () => {
      const stale = await store.claim('wamid.slow');
      advance(WEBHOOK_CLAIM_LEASE_MS);
      await store.claim('wamid.slow');
      await store.release('wamid.slow', stale as string);
      await expect(store.claim('wamid.slow')).resolves.toBeNull();
    });

    it('release never reopens a DONE message', async () => {
      const token = await store.claim('wamid.answered');
      await store.markSeen('wamid.answered');
      await store.release('wamid.answered', token as string);
      await expect(store.claim('wamid.answered')).resolves.toBeNull();
    });

    it('does not collide between distinct message ids', async () => {
      await store.markSeen('wamid.a');
      await expect(store.claim('wamid.a')).resolves.toBeNull();
      await expect(store.claim('wamid.b')).resolves.toEqual(expect.any(String));
    });

    it('purges only DONE and abandoned claims older than the cutoff', async () => {
      await store.markSeen('wamid.old-done');
      await store.claim('wamid.old-abandoned');
      advance(DAY_MS);
      const cutoff = now();
      advance(1000);
      await store.markSeen('wamid.new-done');
      await store.claim('wamid.new-claim');

      await expect(store.purgeBefore(cutoff, 100)).resolves.toBe(2);

      // Purged ids are new again; younger rows keep deduplicating.
      await expect(store.claim('wamid.old-done')).resolves.toEqual(
        expect.any(String),
      );
      await expect(store.claim('wamid.old-abandoned')).resolves.toEqual(
        expect.any(String),
      );
      await expect(store.claim('wamid.new-done')).resolves.toBeNull();
      await expect(store.claim('wamid.new-claim')).resolves.toBeNull();
    });

    it('never purges a claim whose lease is still live', async () => {
      await store.claim('wamid.in-flight');
      await expect(
        store.purgeBefore(new Date(nowMs + 1000), 100),
      ).resolves.toBe(0);
      await expect(store.claim('wamid.in-flight')).resolves.toBeNull();
    });

    it('purges in bounded batches', async () => {
      for (let i = 0; i < 5; i++) await store.markSeen(`wamid.bulk-${i}`);
      advance(1000);
      await expect(store.purgeBefore(now(), 3)).resolves.toBe(3);
      await expect(store.purgeBefore(now(), 3)).resolves.toBe(2);
      await expect(store.purgeBefore(now(), 3)).resolves.toBe(0);
    });
  });
}
