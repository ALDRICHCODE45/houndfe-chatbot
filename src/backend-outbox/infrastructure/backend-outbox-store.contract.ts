import type {
  BackendOutboxEnqueueInput,
  BackendOutboxKind,
  BackendOutboxStore,
} from '../domain/backend-outbox';

/**
 * Shared contract for every `BackendOutboxStore` adapter: seq allocation
 * per (conversation, lane), idempotent enqueue, strict head-of-line
 * claiming per lane (a failing head blocks only its own conversation lane),
 * lease fencing and expiry, backoff scheduling, DEAD letting the next seq
 * proceed, purge.
 */
export type BackendOutboxStoreFactory = () => Promise<{
  store: BackendOutboxStore;
  cleanup?: () => Promise<void>;
}>;

const A = 'wa:5215550001111';
const B = 'wa:5215550002222';
const OWNER = 'backend-outbox:test-a';
const OTHER_OWNER = 'backend-outbox:test-b';
const LEASE_MS = 60_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const input = (
  conversationRef: string,
  idempotencyKey: string,
  payload: Record<string, unknown> = { n: idempotencyKey },
  kind: BackendOutboxKind = 'MESSAGE_MIRROR',
): BackendOutboxEnqueueInput => ({
  conversationRef,
  kind,
  idempotencyKey,
  payload,
});

const control = (
  conversationRef: string,
  idempotencyKey: string,
  kind: BackendOutboxKind,
): BackendOutboxEnqueueInput =>
  input(conversationRef, idempotencyKey, { n: idempotencyKey }, kind);

export function runBackendOutboxStoreContract(
  label: string,
  makeStore: BackendOutboxStoreFactory,
): void {
  describe(`BackendOutboxStore contract — ${label}`, () => {
    let store: BackendOutboxStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      ({ store, cleanup } = await makeStore());
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it('allocates seq per conversation starting at 1', async () => {
      const a1 = await store.enqueue(input(A, 'a1'));
      const a2 = await store.enqueue(input(A, 'a2'));
      const b1 = await store.enqueue(input(B, 'b1'));
      expect([a1.created, a2.created, b1.created]).toEqual([true, true, true]);
      expect([a1.entry.seq, a2.entry.seq, b1.entry.seq]).toEqual([1, 2, 1]);
      expect(a1.entry).toMatchObject({
        conversationRef: A,
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'a1',
        payload: { n: 'a1' },
        status: 'PENDING',
        attempts: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        doneAt: null,
      });
      expect(a1.entry.createdAt).toBeInstanceOf(Date);
      expect(a1.entry.nextAttemptAt).toBeInstanceOf(Date);
    });

    it('allocates seq per lane: mirror and control lanes both start at 1', async () => {
      const m1 = await store.enqueue(input(A, 'm1'));
      const c1 = await store.enqueue(control(A, 'c1', 'REQUEST_CREATE'));
      const s2 = await store.enqueue(input(A, 's2', {}, 'MESSAGE_STATUS'));
      const c2 = await store.enqueue(control(A, 'c2', 'SESSION_ACK'));
      const c3 = await store.enqueue(control(A, 'c3', 'DELIVERY_OUTCOME'));
      expect(
        [m1, c1, s2, c2, c3].map((r) => [r.entry.idempotencyKey, r.entry.seq]),
      ).toEqual([
        ['m1', 1],
        ['c1', 1],
        ['s2', 2],
        ['c2', 2],
        ['c3', 3],
      ]);
    });

    it('a control head is claimable while a mirror head of the same conversation is stuck retrying', async () => {
      await store.enqueue(input(A, 'm1'));
      await store.enqueue(input(A, 'm2', {}, 'MESSAGE_STATUS'));
      await store.enqueue(control(A, 'c1', 'REQUEST_CREATE'));
      await store.enqueue(control(A, 'c2', 'REQUEST_CANCEL'));
      const first = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(first.map((e) => e.idempotencyKey).sort()).toEqual(['c1', 'm1']);
      const m1 = first.find((e) => e.idempotencyKey === 'm1')!;
      const c1 = first.find((e) => e.idempotencyKey === 'c1')!;
      // The mirror lane keeps retrying (not wired) far into the future.
      await expect(store.reschedule(m1, 60_000, 'not wired')).resolves.toBe(
        true,
      );
      await expect(store.claimHeads(20, OWNER, LEASE_MS)).resolves.toEqual([]);
      await expect(store.markDone(c1)).resolves.toBe(true);
      // Control order is kept within its lane; m2 still waits behind m1.
      const second = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(second.map((e) => e.idempotencyKey)).toEqual(['c2']);
      await expect(store.markDone(second[0])).resolves.toBe(true);
      await expect(store.claimHeads(20, OWNER, LEASE_MS)).resolves.toEqual([]);
    });

    it('keeps strict order within each lane of one conversation', async () => {
      for (let n = 1; n <= 3; n++) {
        await store.enqueue(input(A, `m${n}`));
        await store.enqueue(control(A, `c${n}`, 'REQUEST_CREATE'));
      }
      const delivered: string[][] = [];
      for (let round = 0; round < 3; round++) {
        const claimed = await store.claimHeads(20, OWNER, LEASE_MS);
        delivered.push(claimed.map((e) => e.idempotencyKey).sort());
        for (const entry of claimed)
          if (entry.idempotencyKey === 'c2') await store.markDead(entry, '422');
          else await store.markDone(entry);
      }
      expect(delivered).toEqual([
        ['c1', 'm1'],
        ['c2', 'm2'],
        ['c3', 'm3'],
      ]);
      await expect(store.claimHeads(20, OWNER, LEASE_MS)).resolves.toEqual([]);
    });

    it('a duplicate idempotency key is a no-op returning the existing row', async () => {
      const first = await store.enqueue(input(A, 'dup', { v: 1 }));
      const again = await store.enqueue(input(A, 'dup', { v: 2 }));
      expect(again.created).toBe(false);
      expect(again.entry.id).toBe(first.entry.id);
      expect(again.entry.payload).toEqual({ v: 1 });
      // The duplicate did not consume a seq.
      const next = await store.enqueue(input(A, 'after'));
      expect(next.entry.seq).toBe(2);
    });

    it('rejects invalid input instead of dropping it', async () => {
      await expect(store.enqueue(input('5215550001111', 'x'))).rejects.toThrow(
        RangeError,
      );
      await expect(
        store.enqueue({ ...input(A, 'x'), kind: 'NOPE' as never }),
      ).rejects.toThrow(RangeError);
      await expect(store.enqueue(input(A, ''))).rejects.toThrow(RangeError);
      await expect(
        store.enqueue({ ...input(A, 'x'), payload: [] as never }),
      ).rejects.toThrow(TypeError);
    });

    it('claims only the lowest open seq per conversation', async () => {
      await store.enqueue(input(A, 'a1'));
      await store.enqueue(input(A, 'a2'));
      await store.enqueue(input(B, 'b1'));
      const claimed = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(claimed.map((e) => e.idempotencyKey).sort()).toEqual(['a1', 'b1']);
      for (const entry of claimed) {
        expect(entry.status).toBe('IN_FLIGHT');
        expect(entry.leaseOwner).toBe(OWNER);
        expect(entry.leaseExpiresAt).toBeInstanceOf(Date);
      }
      // Heads are leased: nothing else is claimable, a2 waits for a1.
      await expect(
        store.claimHeads(20, OTHER_OWNER, LEASE_MS),
      ).resolves.toEqual([]);
      const a1 = claimed.find((e) => e.idempotencyKey === 'a1')!;
      await expect(store.markDone(a1)).resolves.toBe(true);
      const next = await store.claimHeads(20, OTHER_OWNER, LEASE_MS);
      expect(next.map((e) => e.idempotencyKey)).toEqual(['a2']);
    });

    it('honors the claim limit', async () => {
      await store.enqueue(input(A, 'a1'));
      await store.enqueue(input(B, 'b1'));
      await expect(store.claimHeads(1, OWNER, LEASE_MS)).resolves.toHaveLength(
        1,
      );
      await expect(store.claimHeads(1, OWNER, LEASE_MS)).resolves.toHaveLength(
        1,
      );
      await expect(store.claimHeads(1, OWNER, LEASE_MS)).resolves.toEqual([]);
    });

    it('a rescheduled head blocks only its own conversation until due', async () => {
      await store.enqueue(input(A, 'a1'));
      await store.enqueue(input(A, 'a2'));
      const [a1] = await store.claimHeads(20, OWNER, LEASE_MS);
      await expect(store.reschedule(a1, 60_000, 'boom')).resolves.toBe(true);
      await store.enqueue(input(B, 'b1'));
      const claimed = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(claimed.map((e) => e.idempotencyKey)).toEqual(['b1']);
    });

    it('a due rescheduled head is claimable again with attempts and error', async () => {
      await store.enqueue(input(A, 'a1'));
      const [first] = await store.claimHeads(20, OWNER, LEASE_MS);
      await store.reschedule(first, 0, 'temporary');
      const [again] = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(again).toMatchObject({
        idempotencyKey: 'a1',
        attempts: 1,
        lastError: 'temporary',
      });
    });

    it('an expired lease is reclaimable and fences the old owner', async () => {
      await store.enqueue(input(A, 'a1'));
      await store.enqueue(input(A, 'a2'));
      const [stale] = await store.claimHeads(20, OWNER, 1);
      await sleep(20);
      const [fresh] = await store.claimHeads(20, OTHER_OWNER, LEASE_MS);
      expect(fresh.idempotencyKey).toBe('a1');
      expect(fresh.leaseOwner).toBe(OTHER_OWNER);
      await expect(store.markDone(stale)).resolves.toBe(false);
      await expect(store.reschedule(stale, 0, 'x')).resolves.toBe(false);
      await expect(store.markDead(stale, 'x')).resolves.toBe(false);
      await expect(store.markDone(fresh)).resolves.toBe(true);
      await expect(store.markDone(fresh)).resolves.toBe(false);
    });

    it('a DEAD head lets the next seq proceed', async () => {
      await store.enqueue(input(A, 'a1'));
      await store.enqueue(input(A, 'a2'));
      const [a1] = await store.claimHeads(20, OWNER, LEASE_MS);
      await expect(store.markDead(a1, '422 VALIDATION_ERROR')).resolves.toBe(
        true,
      );
      const [a2] = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(a2.idempotencyKey).toBe('a2');
      // A DEAD row keeps its key: re-enqueueing it is still a no-op.
      const again = await store.enqueue(input(A, 'a1'));
      expect(again).toMatchObject({
        created: false,
        entry: { status: 'DEAD', lastError: '422 VALIDATION_ERROR' },
      });
    });

    it('purges DONE rows older than the retention, in batches', async () => {
      await store.enqueue(input(A, 'a1'));
      await store.enqueue(input(B, 'b1'));
      await store.enqueue(input(A, 'a2'));
      for (const entry of await store.claimHeads(20, OWNER, LEASE_MS))
        await store.markDone(entry);
      await sleep(10);
      await expect(store.purgeDone(7 * 24 * 3_600_000, 100)).resolves.toBe(0);
      await expect(store.purgeDone(0, 1)).resolves.toBe(1);
      await expect(store.purgeDone(0, 100)).resolves.toBe(1);
      await expect(store.purgeDone(0, 100)).resolves.toBe(0);
      // The pending a2 survives and seq never restarts.
      const [a2] = await store.claimHeads(20, OWNER, LEASE_MS);
      expect(a2).toMatchObject({ idempotencyKey: 'a2', seq: 2 });
      const a3 = await store.enqueue(input(A, 'a3'));
      expect(a3.entry.seq).toBe(3);
    });
  });
}
