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
