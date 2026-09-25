import type {
  AgentMessage,
  ConversationState,
  ConversationStore,
} from '../domain/conversation-store';
import {
  readPendingHumanRequest,
  type PendingHumanRequest,
} from '../domain/conversation-store';

/**
 * Shared contract-suite factory for `ConversationStore`.
 *
 * Run against every adapter that honours the port. Scenarios cover the
 * spec requirements: create+get round-trip, UPSERT semantics, merge
 * parity (data preserve vs replace), messages round-trip, ISO
 * millisecond precision, get→null on miss.
 *
 * Per gate-review W1, "State survives adapter instance restart" is a
 * Postgres-only scenario and lives OUTSIDE this factory (in-memory
 * creates a fresh Map per instance and would fail the assertion).
 * Per W3, parity is asserted via `toEqual` (deep-equal), NOT
 * reference identity — JSONB round-trip drops key order.
 */
export type StoreFactory = () => Promise<{
  store: ConversationStore;
  cleanup?: () => Promise<void>;
}>;

/**
 * 13 spec scenarios are realised through 8 factory scenarios:
 *   s1 (create+get)                covers R1: create+get, R3: senderId-preserve
 *   s2 (update patch w/o data)     covers R1: data-preserve, R3: shallow-merge
 *   s3 (update patch w/ data)      covers R1: data REPLACE, R3: data REPLACE
 *   s4 (UPSERT on missing)         covers R1: UPSERT, R3: no-prior creates
 *   s5 (messages + extras RT)      covers R4: mixed-variant + extra keys
 *   s6 (ms-precision ISO RT)       covers R5: known ISO timestamp round-trip
 *   s7 (get→null)                  covers R1: unknown sender, R3: get→null
 *   s8 (subsequent get reflects)   covers R1: latest read wins
 */
export function runConversationStoreContract(
  label: string,
  makeStore: StoreFactory,
): void {
  describe(`ConversationStore contract — ${label}`, () => {
    let store: ConversationStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const built = await makeStore();
      store = built.store;
      cleanup = built.cleanup;
    });

    afterEach(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    // s1: create + get round-trip
    it('round-trips a freshly created state through create + get', async () => {
      const created = await store.create('wa-001', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'greeting' },
      });

      expect(created).toEqual({
        senderId: 'wa-001',
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'greeting' },
      });

      const fetched = await store.get('wa-001');
      expect(fetched).toEqual(created);
    });

    // s2: update patch without data PRESERVES existing data
    it('update() without data preserves the existing data payload', async () => {
      await store.create('wa-update', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'cart', productId: 'prod-1' },
      });

      const updated = await store.update('wa-update', {
        lastMessageAt: '2026-06-23T10:30:00.000Z',
      });

      expect(updated).toEqual({
        senderId: 'wa-update',
        lastMessageAt: '2026-06-23T10:30:00.000Z',
        data: { step: 'cart', productId: 'prod-1' },
      });
    });

    // s3: update patch with data REPLACES data wholesale (no deep merge)
    it('update() with data replaces the prior data object as a whole', async () => {
      await store.create('wa-data-replace', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'old', kept: 'should-not-survive' },
      });

      const updated = await store.update('wa-data-replace', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'new' },
      });

      expect(updated).toEqual({
        senderId: 'wa-data-replace',
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'new' },
      });
      // explicitly: the dropped key is gone
      expect((updated.data as Record<string, unknown>).kept).toBeUndefined();
    });

    // s4: UPSERT — update on a missing sender creates from the patch
    it('update() UPSERTs when no prior record exists', async () => {
      const created = await store.update('wa-ghost', {
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { messages: [] },
      });

      expect(created).toEqual({
        senderId: 'wa-ghost',
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { messages: [] },
      });

      // A subsequent get must reflect the new record.
      const fetched = await store.get('wa-ghost');
      expect(fetched).toEqual(created);
    });

    // s5: mixed-variant messages + arbitrary extra keys round-trip intact
    it('round-trips mixed-variant AgentMessage[] and arbitrary extra keys', async () => {
      const transcript: AgentMessage[] = [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: { now: '2026-06-23T11:00:00.000Z' },
        },
      ];

      await store.create('wa-rich', {
        lastMessageAt: '2026-06-23T11:00:00.000Z',
        data: {
          messages: transcript,
          cart: ['sku-1', 'sku-2'],
          lastIntent: 'product_search',
        },
      });

      const fetched = await store.get('wa-rich');
      expect(fetched).toEqual({
        senderId: 'wa-rich',
        lastMessageAt: '2026-06-23T11:00:00.000Z',
        data: {
          messages: transcript,
          cart: ['sku-1', 'sku-2'],
          lastIntent: 'product_search',
        },
      });

      // discriminator-preservation assertions
      const data = fetched!.data as {
        messages: AgentMessage[];
      };
      expect(data.messages[0].role).toBe('user');
      expect(data.messages[1].role).toBe('assistant');
      expect(data.messages[2].role).toBe('tool');
      expect((data.messages[2] as { toolCallId: string }).toolCallId).toBe(
        'call-1',
      );
    });

    // s6: known ISO timestamp with ms precision round-trips byte-exact
    it('round-trips a millisecond-precision ISO timestamp unchanged', async () => {
      const msTimestamp = '2026-06-30T15:24:13.456Z';

      await store.create('wa-ms', {
        lastMessageAt: msTimestamp,
        data: {},
      });

      const fetched = await store.get('wa-ms');
      expect(fetched).not.toBeNull();
      expect(fetched!.lastMessageAt).toBe(msTimestamp);
    });

    // s7: get() on a never-seen sender returns null
    it('get() returns null for a sender that has never been stored', async () => {
      const fetched = await store.get('never-seen');
      expect(fetched).toBeNull();
    });

    // s8: subsequent get reflects the latest update
    it('subsequent get() reflects the most recent update', async () => {
      await store.create('wa-persist', {
        lastMessageAt: '2026-06-23T08:00:00.000Z',
        data: {},
      });

      await store.update('wa-persist', {
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'cart' },
      });

      const fetched = await store.get('wa-persist');
      const expected: ConversationState = {
        senderId: 'wa-persist',
        lastMessageAt: '2026-06-23T09:00:00.000Z',
        data: { step: 'cart' },
      };
      expect(fetched).toEqual(expected);
    });

    // CAS parity for the human-handoff marker (T3a). Legacy `update()` is
    // deliberately not involved here (T3b changes its marker preservation).
    const T = '2026-07-01T08:00:00.000Z';
    const casMarker = (id: string): PendingHumanRequest => ({
      requestId: id,
      ref: `HF-${id}`,
      createdAt: T,
      customerNotifiedAt: T,
    });
    const setCas = (s: string, m: PendingHumanRequest) =>
      store.setPendingHumanRequest(s, m, T);
    const clearCas = (s: string, requestId: string) =>
      store.clearPendingHumanRequest(s, requestId, T);

    it('setPendingHumanRequest() inserts first-contact and replays exactly', async () => {
      const m = casMarker('aaaa11112222');
      await expect(setCas('c1', m)).resolves.toBe(true);
      await expect(setCas('c1', m)).resolves.toBe(true);
      const fetched = await store.get('c1');
      expect(readPendingHumanRequest(fetched)).toEqual(m);
      expect(fetched!.lastMessageAt).toBe(T);
    });

    it('setPendingHumanRequest() preserves siblings and refuses a conflict', async () => {
      await store.create('c2', { lastMessageAt: T, data: { cart: ['sku-1'] } });
      const m1 = casMarker('bbbb11112222');
      const m2 = casMarker('cccc11112222');
      await expect(setCas('c2', m1)).resolves.toBe(true);
      await expect(setCas('c2', m2)).resolves.toBe(false);
      const fetched = await store.get('c2');
      expect(readPendingHumanRequest(fetched)).toEqual(m1);
      expect(fetched!.data.cart).toEqual(['sku-1']);
    });

    it('clearPendingHumanRequest() nulls the marker and allows a fresh set', async () => {
      const m1 = casMarker('dddd11112222');
      await setCas('c3', m1);
      await expect(clearCas('c3', m1.requestId)).resolves.toBe(true);
      const cleared = await store.get('c3');
      expect(readPendingHumanRequest(cleared)).toBeNull();
      expect(Object.hasOwn(cleared!.data, 'pendingHumanRequest')).toBe(true);
      expect(cleared!.data.pendingHumanRequest).toBeNull();
      const m2 = casMarker('eeee11112222');
      await expect(setCas('c3', m2)).resolves.toBe(true);
      expect(readPendingHumanRequest(await store.get('c3'))).toEqual(m2);
    });

    it('both CAS primitives fail closed on malformed state and invalid args', async () => {
      await store.create('c4', {
        lastMessageAt: T,
        data: {
          // SAFETY: deliberately malformed on-disk shape to prove fail-closed.
          pendingHumanRequest: {
            requestId: 'x',
          } as unknown as PendingHumanRequest,
        },
      });
      const m = casMarker('ffff11112222');
      await expect(setCas('c4', m)).resolves.toBe(false);
      await expect(setCas('c4', { ...m, ref: '' })).resolves.toBe(false);
      await expect(store.setPendingHumanRequest('', m, T)).resolves.toBe(false);
      await expect(store.setPendingHumanRequest('c4', m, '')).resolves.toBe(
        false,
      );
      await expect(clearCas('c4', 'x')).resolves.toBe(false);
      await expect(clearCas('c-absent', m.requestId)).resolves.toBe(false);
      await store.create('c6', {
        lastMessageAt: T,
        data: {
          // SAFETY: four valid fields plus a hostile extra key.
          pendingHumanRequest: {
            ...casMarker('gggg11112222'),
            x: 1,
          } as unknown as PendingHumanRequest,
        },
      });
      await expect(clearCas('c6', 'gggg11112222')).resolves.toBe(false);
      await setCas('c5', m);
      await expect(clearCas('c5', 'wrong-id')).resolves.toBe(false);
    });
  });
}
