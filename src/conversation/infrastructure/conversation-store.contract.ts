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
        data: { step: 'initial' },
      });

      expect(created).toEqual({
        senderId: 'wa-ghost',
        lastMessageAt: '2026-06-23T10:00:00.000Z',
        data: { step: 'initial' },
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

    // T3b: legacy `update()` is a marker carve-out writer — a stale patch
    // value is stripped and the LIVE marker (set or explicit null) reapplied.
    it('update() strips a stale patch marker and keeps the live one', async () => {
      const m = casMarker('aaaa22223333');
      await setCas('u1', m);
      await store.update('u1', {
        lastMessageAt: T,
        data: {
          cart: ['sku-1'],
          pendingHumanRequest: casMarker('dead22223333'),
        },
      });
      const fetched = await store.get('u1');
      expect(readPendingHumanRequest(fetched)).toEqual(m);
      expect(fetched!.data.cart).toEqual(['sku-1']);
    });

    // S7 handoff mode: epoch-monotonic CAS on the protected `data.handoff`.
    describe('handoff mode CAS (S7)', () => {
      const human = (epoch: number, requestId = `req-${epoch}`) => ({
        mode: 'HUMAN' as const,
        epoch,
        requestId,
      });
      const bot = (epoch: number) => ({
        mode: 'BOT' as const,
        epoch,
        requestId: null,
      });

      it('defaults to BOT at epoch 0 without creating a row', async () => {
        await expect(store.getHandoff!('h0')).resolves.toEqual({
          mode: 'BOT',
          epoch: 0,
          requestId: null,
          updatedAt: null,
        });
        expect(await store.get('h0')).toBeNull();
      });

      it('starts a session at a newer epoch and preserves siblings', async () => {
        await store.create('h1', { lastMessageAt: T, data: { cart: ['a'] } });
        const result = await store.applyHandoff!('h1', human(1));
        expect(result).toMatchObject({
          applied: true,
          state: { mode: 'HUMAN', epoch: 1, requestId: 'req-1' },
        });
        const state = await store.getHandoff!('h1');
        expect(state).toMatchObject(human(1));
        expect(typeof state.updatedAt).toBe('string');
        const row = await store.get('h1');
        expect(row!.data.cart).toEqual(['a']);
        expect(row!.lastMessageAt).toBe(T);
      });

      it('treats a same-epoch replay as an idempotent DUPLICATE', async () => {
        await store.applyHandoff!('h2', human(1));
        const before = await store.get('h2');
        await expect(store.applyHandoff!('h2', human(1))).resolves.toEqual({
          applied: false,
          reason: 'DUPLICATE',
        });
        await store.applyHandoff!('h2', bot(1));
        await expect(store.applyHandoff!('h2', bot(1))).resolves.toEqual({
          applied: false,
          reason: 'DUPLICATE',
        });
        expect(before!.data.handoff).toMatchObject(human(1));
      });

      it('ends the session with BOT at the same epoch and never restarts it', async () => {
        await store.applyHandoff!('h3', human(2));
        await expect(store.applyHandoff!('h3', bot(2))).resolves.toMatchObject({
          applied: true,
        });
        await expect(store.getHandoff!('h3')).resolves.toMatchObject(bot(2));
        await expect(store.applyHandoff!('h3', human(2))).resolves.toEqual({
          applied: false,
          reason: 'STALE_EPOCH',
        });
        await expect(store.getHandoff!('h3')).resolves.toMatchObject(bot(2));
      });

      it('starts a new session at epoch N+1 after N ended', async () => {
        await store.applyHandoff!('h4', human(2));
        await store.applyHandoff!('h4', bot(2));
        await expect(
          store.applyHandoff!('h4', human(3)),
        ).resolves.toMatchObject({ applied: true });
        await expect(store.getHandoff!('h4')).resolves.toMatchObject(human(3));
      });

      it('ignores an older epoch in either mode', async () => {
        await store.applyHandoff!('h5', human(5));
        for (const order of [bot(4), human(4), bot(0)]) {
          await expect(store.applyHandoff!('h5', order)).resolves.toEqual({
            applied: false,
            reason: 'STALE_EPOCH',
          });
        }
        await expect(store.getHandoff!('h5')).resolves.toMatchObject(human(5));
      });

      it('refuses HUMAN with another requestId at the same epoch', async () => {
        await store.applyHandoff!('h6', human(1, 'req-a'));
        await expect(
          store.applyHandoff!('h6', human(1, 'req-b')),
        ).resolves.toEqual({ applied: false, reason: 'STALE_EPOCH' });
      });

      it('refuses HUMAN at the default epoch 0 and creates no row', async () => {
        await expect(store.applyHandoff!('h7', human(0))).resolves.toEqual({
          applied: false,
          reason: 'STALE_EPOCH',
        });
        expect(await store.get('h7')).toBeNull();
      });

      it.each([
        ['negative epoch', { mode: 'HUMAN', epoch: -1, requestId: 'r' }],
        ['fractional epoch', { mode: 'HUMAN', epoch: 1.5, requestId: 'r' }],
        ['HUMAN without request', { mode: 'HUMAN', epoch: 1, requestId: null }],
        ['unknown mode', { mode: 'PAUSED', epoch: 1, requestId: 'r' }],
      ])('rejects a malformed order (%s) without writes', async (_, order) => {
        // SAFETY: deliberately malformed runtime input to prove fail-closed.
        const malformed = order as unknown as ReturnType<typeof bot>;
        await expect(store.applyHandoff!('h8', malformed)).resolves.toEqual({
          applied: false,
          reason: 'INVALID',
        });
        expect(await store.get('h8')).toBeNull();
      });

      it('fails closed on a corrupt stored value', async () => {
        await store.create('h9', {
          lastMessageAt: T,
          data: { handoff: { mode: 'HUMAN' } as never },
        });
        await expect(store.getHandoff!('h9')).rejects.toThrow(/handoff/);
        await expect(store.applyHandoff!('h9', human(9))).resolves.toEqual({
          applied: false,
          reason: 'INVALID',
        });
      });

      it('survives ordinary update() writes (protected key)', async () => {
        await store.applyHandoff!('h10', human(1));
        await store.update('h10', {
          lastMessageAt: T,
          data: { cart: ['b'], handoff: bot(7) as never },
        });
        await store.update('h10', { lastMessageAt: T, data: {} });
        await expect(store.getHandoff!('h10')).resolves.toMatchObject(human(1));
        await store.update('h11', {
          lastMessageAt: T,
          data: { handoff: human(4) as never },
        });
        await expect(store.getHandoff!('h11')).resolves.toMatchObject(bot(0));
      });

      // (c) A mute applied by a reconcile (a missed `started`, rule 9) is
      // marked as "no greeting" for that epoch, so a later `started` item of
      // the same epoch never greets either.
      describe('greeting skipped marker (reconcile mute)', () => {
        it('a silent HUMAN order records the epoch whose greeting is skipped', async () => {
          await expect(
            store.applyHandoff!('k1', { ...human(3), silent: true }),
          ).resolves.toMatchObject({ applied: true });
          await expect(store.getHandoff!('k1')).resolves.toMatchObject({
            ...human(3),
            greetingSkippedEpoch: 3,
          });
        });

        it('an ordinary order records nothing', async () => {
          await store.applyHandoff!('k2', human(3));
          await expect(store.getHandoff!('k2')).resolves.not.toHaveProperty(
            'greetingSkippedEpoch',
          );
        });

        it('a replay of the same order does not add the marker to an already greeted epoch', async () => {
          await store.applyHandoff!('k3', human(3));
          await expect(
            store.applyHandoff!('k3', { ...human(3), silent: true }),
          ).resolves.toMatchObject({ applied: false, reason: 'DUPLICATE' });
          await expect(store.getHandoff!('k3')).resolves.not.toHaveProperty(
            'greetingSkippedEpoch',
          );
        });

        it('is kept when the same epoch ends and dropped by a newer epoch', async () => {
          await store.applyHandoff!('k4', { ...human(2), silent: true });
          await store.applyHandoff!('k4', bot(2));
          await expect(store.getHandoff!('k4')).resolves.toMatchObject({
            ...bot(2),
            greetingSkippedEpoch: 2,
          });
          await store.applyHandoff!('k4', human(3));
          await expect(store.getHandoff!('k4')).resolves.not.toHaveProperty(
            'greetingSkippedEpoch',
          );
        });
      });

      // T4: the greeting marker lives inside the CAS-owned handoff value, so
      // it survives every writer that already preserves `handoff`.
      describe('greeting marker (live conversation T4)', () => {
        it('records the greeted epoch only for the current epoch', async () => {
          await store.applyHandoff!('g1', human(3));
          await expect(store.markHandoffGreeted!('g1', 2)).resolves.toBe(false);
          await expect(store.markHandoffGreeted!('g1', 4)).resolves.toBe(false);
          await expect(store.getHandoff!('g1')).resolves.not.toHaveProperty(
            'greetedEpoch',
          );
          await expect(store.markHandoffGreeted!('g1', 3)).resolves.toBe(true);
          await expect(store.getHandoff!('g1')).resolves.toMatchObject({
            ...human(3),
            greetedEpoch: 3,
          });
        });

        it('creates no row and refuses a conversation without handoff', async () => {
          await expect(store.markHandoffGreeted!('g2', 1)).resolves.toBe(false);
          expect(await store.get('g2')).toBeNull();
        });

        it('is kept when the same epoch ends and dropped by a newer epoch', async () => {
          await store.applyHandoff!('g3', human(2));
          await store.markHandoffGreeted!('g3', 2);
          await store.applyHandoff!('g3', bot(2));
          await expect(store.getHandoff!('g3')).resolves.toMatchObject({
            ...bot(2),
            greetedEpoch: 2,
          });
          await store.applyHandoff!('g3', human(3));
          await expect(store.getHandoff!('g3')).resolves.not.toHaveProperty(
            'greetedEpoch',
          );
        });

        it('is idempotent and survives update() writes', async () => {
          await store.applyHandoff!('g4', human(1));
          await store.markHandoffGreeted!('g4', 1);
          await expect(store.markHandoffGreeted!('g4', 1)).resolves.toBe(true);
          await store.update('g4', {
            lastMessageAt: T,
            data: { cart: ['x'], handoff: bot(9) as never },
          });
          await expect(store.getHandoff!('g4')).resolves.toMatchObject({
            ...human(1),
            greetedEpoch: 1,
          });
        });

        it('refuses a non-integer or negative epoch', async () => {
          await store.applyHandoff!('g5', human(1));
          await expect(store.markHandoffGreeted!('g5', 1.5)).resolves.toBe(
            false,
          );
          await expect(store.markHandoffGreeted!('g5', -1)).resolves.toBe(
            false,
          );
        });
      });

      // T7: the safety notice (rule 8) is claimed once per epoch, durably.
      describe('safety notice claim (live conversation T7)', () => {
        it('refuses a conversation that is not HUMAN and creates no row', async () => {
          await expect(store.claimHandoffSafetyNotice!('s0', 1)).resolves.toBe(
            false,
          );
          expect(await store.get('s0')).toBeNull();
          await store.applyHandoff!('s0b', bot(2));
          await expect(store.claimHandoffSafetyNotice!('s0b', 2)).resolves.toBe(
            false,
          );
        });

        it('is granted once for the current HUMAN epoch', async () => {
          await store.applyHandoff!('s1', human(3));
          await expect(store.claimHandoffSafetyNotice!('s1', 2)).resolves.toBe(
            false,
          );
          await expect(store.claimHandoffSafetyNotice!('s1', 3)).resolves.toBe(
            true,
          );
          await expect(store.claimHandoffSafetyNotice!('s1', 3)).resolves.toBe(
            false,
          );
          await expect(store.getHandoff!('s1')).resolves.toMatchObject({
            ...human(3),
            safetyNoticeEpoch: 3,
          });
        });

        it('is dropped by a newer epoch, so that epoch may be claimed again', async () => {
          await store.applyHandoff!('s2', human(1));
          await store.claimHandoffSafetyNotice!('s2', 1);
          await store.applyHandoff!('s2', bot(1));
          await expect(store.getHandoff!('s2')).resolves.toMatchObject({
            ...bot(1),
            safetyNoticeEpoch: 1,
          });
          await store.applyHandoff!('s2', human(2));
          await expect(store.getHandoff!('s2')).resolves.not.toHaveProperty(
            'safetyNoticeEpoch',
          );
          await expect(store.claimHandoffSafetyNotice!('s2', 2)).resolves.toBe(
            true,
          );
        });

        it('survives update() writes and keeps the greeting marker', async () => {
          await store.applyHandoff!('s3', human(1));
          await store.markHandoffGreeted!('s3', 1);
          await store.claimHandoffSafetyNotice!('s3', 1);
          await store.update('s3', {
            lastMessageAt: T,
            data: { cart: ['x'], handoff: bot(9) as never },
          });
          await expect(store.getHandoff!('s3')).resolves.toMatchObject({
            ...human(1),
            greetedEpoch: 1,
            safetyNoticeEpoch: 1,
          });
        });

        it('grants exactly one of two concurrent claims', async () => {
          await store.applyHandoff!('s4', human(1));
          const results = await Promise.all([
            store.claimHandoffSafetyNotice!('s4', 1),
            store.claimHandoffSafetyNotice!('s4', 1),
          ]);
          expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('refuses a non-integer or negative epoch', async () => {
          await store.applyHandoff!('s5', human(1));
          await expect(
            store.claimHandoffSafetyNotice!('s5', 1.5),
          ).resolves.toBe(false);
          await expect(store.claimHandoffSafetyNotice!('s5', -1)).resolves.toBe(
            false,
          );
        });
      });

      // Follow-ups S4: the ENDING marker lives inside the CAS-owned handoff.
      describe('ENDING marker (follow-ups S4)', () => {
        const UNTIL = '2026-11-12T10:02:00.000Z';

        it('is refused without a handoff value and creates no row', async () => {
          await expect(store.markHandoffEnding!('n0', 1, UNTIL)).resolves.toBe(
            false,
          );
          expect(await store.get('n0')).toBeNull();
        });

        it('is set for the current or a newer epoch, never for an older one', async () => {
          await store.applyHandoff!('n1', human(3));
          await expect(store.markHandoffEnding!('n1', 2, UNTIL)).resolves.toBe(
            false,
          );
          await expect(store.getHandoff!('n1')).resolves.not.toHaveProperty(
            'ending',
          );
          await expect(store.markHandoffEnding!('n1', 3, UNTIL)).resolves.toBe(
            true,
          );
          await expect(store.getHandoff!('n1')).resolves.toMatchObject({
            ...human(3),
            ending: { epoch: 3, until: UNTIL },
          });
          await expect(store.markHandoffEnding!('n1', 4, UNTIL)).resolves.toBe(
            true,
          );
          await expect(store.getHandoff!('n1')).resolves.toMatchObject({
            ending: { epoch: 4, until: UNTIL },
          });
        });

        it('survives the durable BOT of that epoch and is dropped by another epoch', async () => {
          await store.applyHandoff!('n2', human(2));
          await store.markHandoffEnding!('n2', 2, UNTIL);
          await store.applyHandoff!('n2', bot(2));
          await expect(store.getHandoff!('n2')).resolves.toMatchObject({
            ...bot(2),
            ending: { epoch: 2, until: UNTIL },
          });
          await store.applyHandoff!('n2', human(3));
          await expect(store.getHandoff!('n2')).resolves.not.toHaveProperty(
            'ending',
          );

          await store.applyHandoff!('n3', human(2));
          await store.markHandoffEnding!('n3', 5, UNTIL);
          await store.applyHandoff!('n3', bot(4));
          await expect(store.getHandoff!('n3')).resolves.not.toHaveProperty(
            'ending',
          );
        });

        it('is cleared only for its own epoch and survives update() writes', async () => {
          await store.applyHandoff!('n4', human(1));
          await store.markHandoffEnding!('n4', 1, UNTIL);
          await store.update('n4', {
            lastMessageAt: T,
            data: { cart: ['x'], handoff: bot(9) as never },
          });
          await expect(store.getHandoff!('n4')).resolves.toMatchObject({
            ending: { epoch: 1, until: UNTIL },
          });
          await expect(store.clearHandoffEnding!('n4', 2)).resolves.toBe(false);
          await expect(store.clearHandoffEnding!('n4', 1)).resolves.toBe(true);
          await expect(store.clearHandoffEnding!('n4', 1)).resolves.toBe(false);
          await expect(store.getHandoff!('n4')).resolves.toMatchObject(
            human(1),
          );
          await expect(store.getHandoff!('n4')).resolves.not.toHaveProperty(
            'ending',
          );
        });

        it('refuses a bad epoch or instant', async () => {
          await store.applyHandoff!('n5', human(1));
          await expect(
            store.markHandoffEnding!('n5', 1.5, UNTIL),
          ).resolves.toBe(false);
          await expect(
            store.markHandoffEnding!('n5', 1, 'not-a-date'),
          ).resolves.toBe(false);
          await expect(store.clearHandoffEnding!('n5', -1)).resolves.toBe(
            false,
          );
        });
      });

      describe('listing HUMAN conversations (live conversation T7)', () => {
        it('lists only HUMAN handoffs, ordered, bounded by the limit', async () => {
          await store.applyHandoff!('l-c', human(2, 'req-c'));
          await store.applyHandoff!('l-a', human(1, 'req-a'));
          await store.applyHandoff!('l-b', human(3, 'req-b'));
          await store.applyHandoff!('l-b', bot(3));
          await store.update('l-none', { lastMessageAt: T, data: {} });
          const all = (await store.listHumanHandoffs!(10)).filter((h) =>
            h.senderId.startsWith('l-'),
          );
          expect(all).toEqual([
            { senderId: 'l-a', epoch: 1, requestId: 'req-a' },
            { senderId: 'l-c', epoch: 2, requestId: 'req-c' },
          ]);
          await expect(store.listHumanHandoffs!(1)).resolves.toHaveLength(1);
        });
      });
    });

    // Unit 14 T2: the per-conversation offer / appointment, CAS-owned like
    // the handoff and the cart (`data.scheduling`).
    describe('scheduling state CAS (unit 14 T2)', () => {
      const offer = {
        slots: [
          { startsAt: '2026-11-13T15:00:00.000Z', withinWindow: true },
          { startsAt: '2026-11-13T15:30:00.000Z', withinWindow: false },
        ],
        timeZone: 'America/Mexico_City',
        offeredAt: '2026-11-12T20:00:00.000Z',
        subtype: 'TALK_TO_HUMAN' as const,
        sourceRequestId: '0b0f7c58-6f55-4f4f-a1c4-9a2b7d6a4e11',
        unclearCount: 0,
      };
      const appointment = {
        requestId: 'req-1',
        subtype: 'TALK_TO_HUMAN',
        scheduledFor: '2026-11-13T15:00:00.000Z',
        scheduleVersion: 1,
        timeZone: 'America/Mexico_City',
        rescheduleCount: 0,
      };
      const empty = { offer: null, appointment: null };

      it('reads the empty state for an unknown sender or a row without it', async () => {
        const missing = await store.getScheduling!('sch-0');
        expect(missing.state).toEqual(empty);
        expect(missing.raw).toBeUndefined();
        await store.create('sch-0b', { lastMessageAt: T, data: { a: 1 } });
        const row = await store.getScheduling!('sch-0b');
        expect(row.state).toEqual(empty);
        expect(row.raw).toBeUndefined();
      });

      it('first contact: an absent expectation creates the row', async () => {
        const next = { offer, appointment: null };
        await expect(
          store.commitScheduling!('sch-1', undefined, next, T),
        ).resolves.toBe(true);
        const read = await store.getScheduling!('sch-1');
        expect(read.state).toEqual(next);
        expect((await store.get('sch-1'))!.lastMessageAt).toBe(T);
      });

      it('an absent expectation is refused once the key exists', async () => {
        await store.commitScheduling!(
          'sch-2',
          undefined,
          { offer, appointment: null },
          T,
        );
        await expect(
          store.commitScheduling!('sch-2', undefined, empty, T),
        ).resolves.toBe(false);
        expect((await store.getScheduling!('sch-2')).state.offer).toEqual(
          offer,
        );
      });

      it('compares and sets against the raw value it returned', async () => {
        await store.commitScheduling!(
          'sch-3',
          undefined,
          { offer, appointment: null },
          T,
        );
        const read = await store.getScheduling!('sch-3');
        const booked = { offer: null, appointment };
        await expect(
          store.commitScheduling!('sch-3', read.raw, booked, T),
        ).resolves.toBe(true);
        // The same (now stale) expectation loses.
        await expect(
          store.commitScheduling!(
            'sch-3',
            read.raw,
            { offer, appointment: null },
            T,
          ),
        ).resolves.toBe(false);
        expect((await store.getScheduling!('sch-3')).state).toEqual(booked);
      });

      it('exactly one of two concurrent writers wins the same expectation', async () => {
        await store.commitScheduling!(
          'sch-4',
          undefined,
          { offer, appointment: null },
          T,
        );
        const { raw } = await store.getScheduling!('sch-4');
        const results = await Promise.all([
          store.commitScheduling!(
            'sch-4',
            raw,
            { offer: null, appointment },
            T,
          ),
          store.commitScheduling!(
            'sch-4',
            raw,
            { offer: { ...offer, unclearCount: 1 }, appointment: null },
            T,
          ),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('refuses a malformed next without touching the row', async () => {
        await expect(
          store.commitScheduling!(
            'sch-5',
            undefined,
            { offer: { ...offer, slots: [] }, appointment: null },
            T,
          ),
        ).resolves.toBe(false);
        expect(await store.get('sch-5')).toBeNull();
        await expect(
          store.commitScheduling!('sch-5', undefined, empty, 'not a date'),
        ).resolves.toBe(false);
      });

      it('a corrupt stored value reads as empty and can be overwritten with its raw', async () => {
        await store.create('sch-6', {
          lastMessageAt: T,
          data: { scheduling: 'garbage' },
        });
        const read = await store.getScheduling!('sch-6');
        expect(read.state).toEqual(empty);
        expect(read.raw).toBe('garbage');
        await expect(
          store.commitScheduling!(
            'sch-6',
            read.raw,
            { offer, appointment: null },
            T,
          ),
        ).resolves.toBe(true);
        expect((await store.getScheduling!('sch-6')).state.offer).toEqual(
          offer,
        );
      });

      it('keeps the newer lastMessageAt and every sibling key', async () => {
        await store.create('sch-7', {
          lastMessageAt: '2026-12-01T00:00:00.000Z',
          data: { messages: [{ role: 'user', content: 'hola' }], x: 1 },
        });
        await store.commitScheduling!(
          'sch-7',
          undefined,
          { offer, appointment: null },
          T,
        );
        const fetched = await store.get('sch-7');
        expect(fetched!.lastMessageAt).toBe('2026-12-01T00:00:00.000Z');
        expect(fetched!.data.x).toBe(1);
        expect(fetched!.data.messages).toEqual([
          { role: 'user', content: 'hola' },
        ]);
      });

      it('never bumps lastMessageAt of an existing row (a feed-driven write must not keep stale history alive)', async () => {
        const OLD = '2026-11-01T00:00:00.000Z';
        await store.create('sch-7b', {
          lastMessageAt: OLD,
          data: { messages: [{ role: 'user', content: 'hola' }] },
        });
        await store.commitScheduling!(
          'sch-7b',
          undefined,
          { offer, appointment: null },
          '2026-12-05T00:00:00.000Z',
        );
        expect((await store.get('sch-7b'))!.lastMessageAt).toBe(OLD);
        const { raw } = await store.getScheduling!('sch-7b');
        await store.commitScheduling!(
          'sch-7b',
          raw,
          { offer: null, appointment },
          '2026-12-06T00:00:00.000Z',
        );
        expect((await store.get('sch-7b'))!.lastMessageAt).toBe(OLD);
      });

      it('survives update() writes (CAS-owned, never replaced by a stale patch)', async () => {
        await store.commitScheduling!(
          'sch-8',
          undefined,
          { offer, appointment },
          T,
        );
        await store.update('sch-8', {
          lastMessageAt: T,
          data: { cart: ['x'], scheduling: empty },
        });
        const read = await store.getScheduling!('sch-8');
        expect(read.state).toEqual({ offer, appointment });
        expect((await store.get('sch-8'))!.data.cart).toEqual(['x']);
      });

      it('does not disturb the handoff mode or the pending marker', async () => {
        await store.applyHandoff!('sch-9', {
          mode: 'HUMAN',
          epoch: 1,
          requestId: 'req-1',
        });
        await store.commitScheduling!(
          'sch-9',
          undefined,
          { offer, appointment: null },
          T,
        );
        await expect(store.getHandoff!('sch-9')).resolves.toMatchObject({
          mode: 'HUMAN',
          epoch: 1,
        });
      });
    });

    it('update() cannot resurrect a cleared marker', async () => {
      const m = casMarker('bbbb22223333');
      await setCas('u2', m);
      await expect(clearCas('u2', m.requestId)).resolves.toBe(true);
      await store.update('u2', {
        lastMessageAt: T,
        data: { pendingHumanRequest: casMarker('cccc22223333') },
      });
      const fetched = await store.get('u2');
      expect(readPendingHumanRequest(fetched)).toBeNull();
      expect(Object.hasOwn(fetched!.data, 'pendingHumanRequest')).toBe(true);
      expect(fetched!.data.pendingHumanRequest).toBeNull();
    });
  });
}
