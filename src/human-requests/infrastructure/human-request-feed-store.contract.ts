import type {
  FeedItem,
  RequestCancelledItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { HumanRequestFeedStore } from '../domain/human-request-feed';

export const REF = 'wa:5215550001111';
const ATTEMPT_A = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const ATTEMPT_B = '1c9f6d1f-7e8b-4d2f-8b63-4a2e3c7b8d21';
const AT = '2026-11-10T16:20:00.000Z';

export const cancelledItem = (
  deliveryId: string,
  patch: Partial<RequestCancelledItem> = {},
): RequestCancelledItem => ({
  cursor: `00000000000${deliveryId.length}`,
  deliveryId,
  type: 'request.cancelled',
  requestId: `req-${deliveryId}`,
  conversationRef: REF,
  notBefore: null,
  expiresAt: null,
  payload: {
    requestId: `req-${deliveryId}`,
    reason: 'OTHER',
    cancelledBy: 'STAFF',
  },
  ...patch,
});

/** Behavior every HumanRequestFeedStore adapter must share. */
export function runHumanRequestFeedStoreContract(
  name: string,
  setup: () => Promise<{
    store: HumanRequestFeedStore;
    cleanup: () => Promise<void>;
  }>,
): void {
  describe(`HumanRequestFeedStore contract (${name})`, () => {
    let store: HumanRequestFeedStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await setup());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('starts with a null cursor and persists the saved one', async () => {
      await expect(store.readCursor()).resolves.toBeNull();
      await store.saveCursor('000000001842');
      await expect(store.readCursor()).resolves.toBe('000000001842');
      await store.saveCursor(null);
      await expect(store.readCursor()).resolves.toBeNull();
    });

    it('saves synced_at together with the cursor and keeps it when omitted', async () => {
      await expect(store.readSyncedAt()).resolves.toBeNull();
      await store.saveCursor('000000000010', '2026-11-11T10:00:00.000Z');
      await expect(store.readCursor()).resolves.toBe('000000000010');
      await expect(store.readSyncedAt()).resolves.toBe(
        '2026-11-11T10:00:00.000Z',
      );
      await store.saveCursor('000000000011');
      await expect(store.readCursor()).resolves.toBe('000000000011');
      await expect(store.readSyncedAt()).resolves.toBe(
        '2026-11-11T10:00:00.000Z',
      );
      await store.saveCursor(null, '2026-11-11T11:00:00.000Z');
      await expect(store.readCursor()).resolves.toBeNull();
      await expect(store.readSyncedAt()).resolves.toBe(
        '2026-11-11T11:00:00.000Z',
      );
    });

    it('lists OPEN request ids created before an instant', async () => {
      for (const id of ['o1', 'o2', 'o3'])
        await store.recordOpenRequest({
          requestId: id,
          conversationRef: REF,
          subtype: 'UNKNOWN_QUESTION',
        });
      await store.closeRequest('o2', 'RESOLVED');
      await expect(
        store.listOpenRequestIds(new Date(Date.now() - 3_600_000)),
      ).resolves.toEqual([]);
      const ids = await store.listOpenRequestIds(new Date(Date.now() + 60_000));
      expect([...ids].sort()).toEqual(['o1', 'o3']);
    });

    it('inserts a delivery once and returns the stored row on replay', async () => {
      const first = await store.insertDelivery(cancelledItem('d1'));
      expect(first.inserted).toBe(true);
      expect(first.row).toMatchObject({
        deliveryId: 'd1',
        type: 'request.cancelled',
        requestId: 'req-d1',
        conversationRef: REF,
        localState: 'RECEIVED',
        decision: null,
        attemptId: null,
        ackState: null,
        ackAttempts: 0,
      });
      expect(first.row.item).toEqual(cancelledItem('d1'));
      await store.transition(
        'd1',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'STALE',
          decision: 'DUPLICATE',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: null,
          ack: 'STALE',
        },
      );
      const replay = await store.insertDelivery(
        cancelledItem('d1', { cursor: '999' }),
      );
      expect(replay.inserted).toBe(false);
      expect(replay.row).toMatchObject({
        localState: 'STALE',
        cursor: cancelledItem('d1').cursor,
        attemptId: ATTEMPT_A,
      });
    });

    it('stores an unknown item type without request or conversation', async () => {
      const item: FeedItem = {
        type: 'unknown',
        rawType: 'conversation.started',
        cursor: '7',
        deliveryId: 'u1',
        raw: { type: 'conversation.started' },
      };
      const { row } = await store.insertDelivery(item);
      expect(row).toMatchObject({
        type: 'conversation.started',
        requestId: null,
        conversationRef: null,
      });
    });

    it('transitions only from the expected state and attempt', async () => {
      await store.insertDelivery(cancelledItem('d2'));
      const sending = await store.transition(
        'd2',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'SENDING',
          decision: 'CANCEL_NOTICE',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: null,
          ack: null,
        },
      );
      expect(sending).toMatchObject({ localState: 'SENDING', ackState: null });
      // A second actor with a stale expectation loses.
      await expect(
        store.transition(
          'd2',
          { localState: 'RECEIVED', attemptId: null },
          {
            localState: 'SENDING',
            decision: 'CANCEL_NOTICE',
            attemptId: ATTEMPT_B,
            attemptedAt: AT,
            providerMessageId: null,
            ack: null,
          },
        ),
      ).resolves.toBeNull();
      const sent = await store.transition(
        'd2',
        { localState: 'SENDING', attemptId: ATTEMPT_A },
        {
          localState: 'SENT',
          decision: 'CANCEL_NOTICE',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: 'wamid.1',
          ack: 'PROVIDER_ACCEPTED',
        },
      );
      expect(sent).toMatchObject({
        localState: 'SENT',
        providerMessageId: 'wamid.1',
        ackState: 'PENDING',
        ackOutcome: 'PROVIDER_ACCEPTED',
        ackAttempts: 0,
      });
      expect(sent?.nextAckAt).toBeInstanceOf(Date);
    });

    it('lists due ACKs and completes them only for the current attempt', async () => {
      await store.insertDelivery(cancelledItem('d3'));
      await store.transition(
        'd3',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'STALE',
          decision: 'DUPLICATE',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: null,
          ack: 'STALE',
        },
      );
      const due = await store.listDueAcks(new Date(Date.now() + 1000), 10);
      expect(due.map((row) => row.deliveryId)).toEqual(['d3']);

      const later = new Date(Date.now() + 60_000);
      await expect(
        store.completeAck('d3', ATTEMPT_B, { ackState: 'ACKED' }),
      ).resolves.toBe(false);
      await expect(
        store.completeAck('d3', ATTEMPT_A, {
          ackState: 'PENDING',
          retryAt: later,
          error: 'boom',
        }),
      ).resolves.toBe(true);
      await expect(
        store.listDueAcks(new Date(Date.now() + 1000), 10),
      ).resolves.toEqual([]);
      const retried = await store.getDelivery('d3');
      expect(retried).toMatchObject({ ackState: 'PENDING', ackAttempts: 1 });
      expect(retried?.nextAckAt?.getTime()).toBe(later.getTime());

      await expect(
        store.completeAck('d3', ATTEMPT_A, { ackState: 'ACKED' }),
      ).resolves.toBe(true);
      await expect(store.getDelivery('d3')).resolves.toMatchObject({
        ackState: 'ACKED',
        nextAckAt: null,
      });
      // Terminal: nothing more applies.
      await expect(
        store.completeAck('d3', ATTEMPT_A, {
          ackState: 'FAILED_PERMANENT',
          error: 'x',
        }),
      ).resolves.toBe(false);
    });

    it('clears the owed ACK when the deferral stays local', async () => {
      await store.insertDelivery(cancelledItem('d4'));
      await store.transition(
        'd4',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'HELD_HUMAN',
          decision: 'CLARIFICATION',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: null,
          ack: 'DEFERRED_HUMAN_SESSION',
        },
      );
      await expect(
        store.completeAck('d4', ATTEMPT_A, { ackState: null }),
      ).resolves.toBe(true);
      await expect(store.getDelivery('d4')).resolves.toMatchObject({
        localState: 'HELD_HUMAN',
        ackState: null,
        ackOutcome: null,
      });
    });

    it('lists held rows, optionally by conversation', async () => {
      const other = 'wa:5215550002222';
      for (const [id, ref] of [
        ['h1', REF],
        ['h2', other],
        ['h3', REF],
      ] as const) {
        await store.insertDelivery(cancelledItem(id, { conversationRef: ref }));
        if (id !== 'h3')
          await store.transition(
            id,
            { localState: 'RECEIVED', attemptId: null },
            {
              localState: 'HELD_HUMAN',
              decision: 'CANCEL_NOTICE',
              attemptId: ATTEMPT_A,
              attemptedAt: AT,
              providerMessageId: null,
              ack: null,
            },
          );
      }
      const all = await store.listHeld({ limit: 10 });
      expect(all.map((row) => row.deliveryId).sort()).toEqual(['h1', 'h2']);
      const mine = await store.listHeld({ conversationRef: REF, limit: 10 });
      expect(mine.map((row) => row.deliveryId)).toEqual(['h1']);
    });

    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const putIn = async (
      id: string,
      localState: 'HELD_HUMAN' | 'DEFERRED_WINDOW' | 'STALE' | 'SENT',
      ack: 'STALE' | 'PROVIDER_ACCEPTED' | null,
      ref: string = REF,
    ) => {
      await store.insertDelivery(cancelledItem(id, { conversationRef: ref }));
      await store.transition(
        id,
        { localState: 'RECEIVED', attemptId: null },
        {
          localState,
          decision: 'CANCEL_NOTICE',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: localState === 'SENT' ? 'wamid.p' : null,
          ack,
        },
      );
    };

    it('lists held rows least recently checked first; a check moves a row last', async () => {
      for (const id of ['f1', 'f2', 'f3']) {
        await putIn(id, 'HELD_HUMAN', null);
        await tick();
      }
      const ids = async () =>
        (await store.listHeld({ limit: 2 })).map((row) => row.deliveryId);
      await expect(ids()).resolves.toEqual(['f1', 'f2']);
      // A stale attempt does not count as a check.
      await store.touchHeld('f1', ATTEMPT_B);
      await expect(ids()).resolves.toEqual(['f1', 'f2']);
      await store.touchHeld('f1', ATTEMPT_A);
      await expect(ids()).resolves.toEqual(['f2', 'f3']);
      await tick();
      await store.touchHeld('f2', ATTEMPT_A);
      await expect(ids()).resolves.toEqual(['f3', 'f1']);
      await expect(store.getDelivery('f1')).resolves.toMatchObject({
        localState: 'HELD_HUMAN',
        attemptId: ATTEMPT_A,
      });
    });

    it('touchHeld leaves a row that is no longer held untouched', async () => {
      await putIn('f4', 'STALE', 'STALE');
      const before = await store.getDelivery('f4');
      await tick();
      await store.touchHeld('f4', ATTEMPT_A);
      const after = await store.getDelivery('f4');
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    });

    it('lists DEFERRED_WINDOW rows of one conversation', async () => {
      await putIn('w1', 'DEFERRED_WINDOW', null);
      await putIn('w2', 'DEFERRED_WINDOW', null, 'wa:5215550002222');
      await putIn('w3', 'HELD_HUMAN', null);
      const rows = await store.listDeferredWindow({
        conversationRef: REF,
        limit: 10,
      });
      expect(rows.map((row) => row.deliveryId)).toEqual(['w1']);
    });

    it('purges old terminal rows: deletes ACKED ones, scrubs FAILED_PERMANENT payloads, keeps owed work', async () => {
      await putIn('p1', 'STALE', 'STALE');
      await store.completeAck('p1', ATTEMPT_A, { ackState: 'ACKED' });
      await putIn('p2', 'SENT', 'PROVIDER_ACCEPTED');
      await store.completeAck('p2', ATTEMPT_A, {
        ackState: 'FAILED_PERMANENT',
        error: 'VALIDATION_ERROR',
      });
      await putIn('p3', 'STALE', 'STALE'); // ACK still PENDING
      await putIn('p4', 'HELD_HUMAN', null);
      await putIn('p5', 'DEFERRED_WINDOW', null);
      await store.insertDelivery(cancelledItem('p6')); // RECEIVED

      // Nothing is old enough yet.
      await expect(
        store.purgeTerminal(new Date(Date.now() - 3_600_000), 10),
      ).resolves.toEqual({ deleted: 0, scrubbed: 0 });

      const cutoff = new Date(Date.now() + 60_000);
      await expect(store.purgeTerminal(cutoff, 10)).resolves.toEqual({
        deleted: 1,
        scrubbed: 1,
      });
      await expect(store.getDelivery('p1')).resolves.toBeNull();
      const scrubbed = await store.getDelivery('p2');
      expect(scrubbed).toMatchObject({
        localState: 'SENT',
        ackState: 'FAILED_PERMANENT',
        providerMessageId: 'wamid.p',
        conversationRef: REF,
      });
      expect(scrubbed?.item).toEqual({
        type: 'unknown',
        rawType: 'request.cancelled',
        cursor: cancelledItem('p2').cursor,
        deliveryId: 'p2',
        raw: { purged: true },
      });
      // The scrubbed row still de-duplicates: never handled again.
      await expect(
        store.insertDelivery(cancelledItem('p2')),
      ).resolves.toMatchObject({ inserted: false });
      for (const id of ['p3', 'p4', 'p5', 'p6'])
        await expect(store.getDelivery(id)).resolves.toMatchObject({
          item: cancelledItem(id),
        });
      // Idempotent: a scrubbed row is not counted again.
      await expect(store.purgeTerminal(cutoff, 10)).resolves.toEqual({
        deleted: 0,
        scrubbed: 0,
      });
    });

    it('purges in batches of at most `limit` rows per kind', async () => {
      for (const id of ['b1', 'b2', 'b3']) {
        await putIn(id, 'STALE', 'STALE');
        await store.completeAck(id, ATTEMPT_A, { ackState: 'ACKED' });
      }
      const cutoff = new Date(Date.now() + 60_000);
      await expect(store.purgeTerminal(cutoff, 2)).resolves.toEqual({
        deleted: 2,
        scrubbed: 0,
      });
      await expect(store.purgeTerminal(cutoff, 2)).resolves.toEqual({
        deleted: 1,
        scrubbed: 0,
      });
    });

    it('lists SENDING rows whose attempt started before a cutoff', async () => {
      await store.insertDelivery(cancelledItem('s1'));
      await store.transition(
        's1',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'SENDING',
          decision: 'CANCEL_NOTICE',
          attemptId: ATTEMPT_A,
          attemptedAt: AT,
          providerMessageId: null,
          ack: null,
        },
      );
      await expect(
        store.listStuckSending(new Date('2026-11-10T16:19:00.000Z'), 10),
      ).resolves.toEqual([]);
      const stuck = await store.listStuckSending(
        new Date('2026-11-10T16:30:00.000Z'),
        10,
      );
      expect(stuck.map((row) => row.deliveryId)).toEqual(['s1']);
    });

    it('records open requests idempotently and closes them once', async () => {
      await store.recordOpenRequest({
        requestId: 'r1',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      await store.recordOpenRequest({
        requestId: 'r1',
        conversationRef: REF,
        subtype: 'COMPLAINT',
      });
      await expect(store.getRequest('r1')).resolves.toMatchObject({
        requestId: 'r1',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
        legacyId: null,
        status: 'OPEN',
      });
      await expect(store.closeRequest('r1', 'CANCELLED')).resolves.toBe(true);
      await expect(store.closeRequest('r1', 'RESOLVED')).resolves.toBe(false);
      await expect(store.getRequest('r1')).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      await expect(store.closeRequest('missing', 'CANCELLED')).resolves.toBe(
        false,
      );
      await expect(store.getRequest('missing')).resolves.toBeNull();
    });
  });
}
