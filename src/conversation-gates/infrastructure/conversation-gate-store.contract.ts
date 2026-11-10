import type {
  ConversationGate,
  ConversationGateStore,
} from '../domain/conversation-gate.store';

/**
 * Shared contract for every `ConversationGateStore` adapter: upsert per
 * (sender, kind), expiry enforced on read, atomic single-use consume with an
 * optional payload match, bounded purge of expired rows only, and payload
 * validation before any write.
 */
export type ConversationGateStoreFactory = (now: () => Date) => Promise<{
  store: ConversationGateStore;
  cleanup?: () => Promise<void>;
}>;

const SENDER = '5215550001111';
const OTHER = '5215550002222';
const T0 = new Date('2026-11-09T16:00:00.000Z');
const FIVE_MINUTES = 5 * 60 * 1000;

const gate = (patch: Partial<ConversationGate> = {}): ConversationGate => ({
  senderId: SENDER,
  kind: 'order_confirmation',
  payload: { reference: 'ref-1', armed: false, at: T0.toISOString() },
  expiresAt: new Date(T0.getTime() + FIVE_MINUTES),
  ...patch,
});

export function runConversationGateStoreContract(
  label: string,
  makeStore: ConversationGateStoreFactory,
): void {
  describe(`ConversationGateStore contract — ${label}`, () => {
    let now: Date;
    let store: ConversationGateStore;
    let cleanup: (() => Promise<void>) | undefined;
    const advance = (ms: number) => {
      now = new Date(now.getTime() + ms);
    };

    beforeEach(async () => {
      now = T0;
      ({ store, cleanup } = await makeStore(() => now));
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it('reads nothing for an unknown sender', async () => {
      await expect(store.get(SENDER, 'order_confirmation')).resolves.toBeNull();
      await expect(store.list(SENDER)).resolves.toEqual([]);
    });

    it('round-trips a gate with ISO expiry and a detached payload', async () => {
      const written = gate();
      await store.put(written);
      const read = await store.get(SENDER, 'order_confirmation');
      expect(read).toEqual(written);
      expect(read!.expiresAt.toISOString()).toBe('2026-11-09T16:05:00.000Z');
      (read!.payload as Record<string, unknown>).armed = true;
      await expect(
        store.get(SENDER, 'order_confirmation'),
      ).resolves.toMatchObject({ payload: { armed: false } });
    });

    it('upserts one gate per (sender, kind)', async () => {
      await store.put(gate());
      await store.put(gate({ payload: { reference: 'ref-2' } }));
      await store.put(gate({ kind: 'restock_pending', payload: { n: 1 } }));
      await store.put(gate({ senderId: OTHER }));
      await expect(
        store.get(SENDER, 'order_confirmation'),
      ).resolves.toMatchObject({ payload: { reference: 'ref-2' } });
      const kinds = (await store.list(SENDER)).map((g) => g.kind).sort();
      expect(kinds).toEqual(['order_confirmation', 'restock_pending']);
    });

    it('treats an expired gate as absent on every read', async () => {
      await store.put(gate());
      advance(FIVE_MINUTES - 1);
      await expect(
        store.get(SENDER, 'order_confirmation'),
      ).resolves.not.toBeNull();
      advance(1);
      await expect(store.get(SENDER, 'order_confirmation')).resolves.toBeNull();
      await expect(store.list(SENDER)).resolves.toEqual([]);
      await expect(
        store.consume(SENDER, 'order_confirmation'),
      ).resolves.toBeNull();
    });

    it('consumes exactly once', async () => {
      await store.put(gate());
      await expect(
        store.consume(SENDER, 'order_confirmation'),
      ).resolves.toMatchObject({ payload: { reference: 'ref-1' } });
      await expect(
        store.consume(SENDER, 'order_confirmation'),
      ).resolves.toBeNull();
      await expect(store.get(SENDER, 'order_confirmation')).resolves.toBeNull();
    });

    it('consumes only when the payload still matches', async () => {
      await store.put(gate());
      await expect(
        store.consume(SENDER, 'order_confirmation', { reference: 'ref-old' }),
      ).resolves.toBeNull();
      await expect(
        store.get(SENDER, 'order_confirmation'),
      ).resolves.not.toBeNull();
      await expect(
        store.consume(SENDER, 'order_confirmation', { reference: 'ref-1' }),
      ).resolves.not.toBeNull();
    });

    it('concurrent consumes yield exactly one winner', async () => {
      await store.put(gate());
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.consume(SENDER, 'order_confirmation', { reference: 'ref-1' }),
        ),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('deletes one gate only', async () => {
      await store.put(gate());
      await store.put(gate({ kind: 'restock_pending' }));
      await store.delete(SENDER, 'order_confirmation');
      await store.delete(SENDER, 'checkout_address');
      expect((await store.list(SENDER)).map((g) => g.kind)).toEqual([
        'restock_pending',
      ]);
    });

    it('purges expired gates in bounded batches and keeps live ones', async () => {
      await store.put(gate({ senderId: '5215550000001' }));
      await store.put(gate({ senderId: '5215550000002' }));
      await store.put(gate({ senderId: '5215550000003' }));
      await store.put(
        gate({ expiresAt: new Date(T0.getTime() + 2 * FIVE_MINUTES) }),
      );
      advance(FIVE_MINUTES);
      await expect(store.purgeExpired(2)).resolves.toBe(2);
      await expect(store.purgeExpired(2)).resolves.toBe(1);
      await expect(store.purgeExpired(2)).resolves.toBe(0);
      await expect(
        store.get(SENDER, 'order_confirmation'),
      ).resolves.not.toBeNull();
    });

    it('rejects an invalid gate before writing', async () => {
      await expect(store.put(gate({ kind: 'nope' as never }))).rejects.toThrow(
        /kind/,
      );
      await expect(store.put(gate({ senderId: '' }))).rejects.toThrow(/sender/);
      await expect(store.put(gate({ payload: [] as never }))).rejects.toThrow(
        /payload/,
      );
      await expect(
        store.put(gate({ payload: { big: 'x'.repeat(70_000) } })),
      ).rejects.toThrow(/payload_size/);
      await expect(store.list(SENDER)).resolves.toEqual([]);
    });
  });
}
