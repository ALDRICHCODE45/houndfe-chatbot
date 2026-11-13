import { Logger } from '@nestjs/common';
import {
  REF,
  cancelledItem,
  endedItem,
  staffMessageItem,
} from '../infrastructure/human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import type { DeliveryRow } from '../domain/human-request-feed';
import { HumanRequestDeliveryService } from './human-request-delivery.service';
import type { LivePlan } from './live-conversation.service';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-12T16:20:00.000Z');
const attemptId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Follow-ups S4: while the conversation carries an ENDING marker the replay
 * paths hold every non-lifecycle row; the farewell path itself is unaffected.
 */
const setup = (
  options: { ending?: boolean | Error; withoutReader?: boolean } = {},
) => {
  const store = new InMemoryHumanRequestFeedStore(() => NOW.getTime());
  const state = { ending: options.ending ?? true, human: false };
  const textSent: string[] = [];
  const relayed: string[] = [];
  const pendingCalls: string[] = [];
  const isEndingCalls: string[] = [];
  let attempt = 0;
  const plan = (row: DeliveryRow): Promise<LivePlan> => {
    if (row.item.type === 'conversation.staff_message')
      return Promise.resolve({
        action: 'relay',
        decision: 'STAFF_MESSAGE',
        senderId: SENDER,
        deferrable: true,
        deliver: () => {
          relayed.push(row.deliveryId);
          return Promise.resolve({ providerMessageId: 'wamid.staff' });
        },
      });
    if (row.item.type === 'conversation.ended')
      return Promise.resolve({
        action: 'send',
        decision: 'FAREWELL',
        senderId: SENDER,
        text: 'farewell',
      });
    return Promise.resolve({ action: 'stale', decision: 'UNKNOWN_TYPE' });
  };
  const service = new HumanRequestDeliveryService(
    {
      store,
      client: {
        recordDeliveryOutcome: (deliveryId, body) =>
          Promise.resolve({
            kind: 'ok',
            response: {
              deliveryId,
              outcome: body.outcome,
              attemptId: body.attemptId,
              ackReceivedAt: null,
            },
          }),
        listPendingDeliveries: (filter) => {
          pendingCalls.push(filter.conversationRef ?? '');
          return Promise.resolve({ kind: 'ok' as const, items: [] });
        },
      },
      sender: {
        sendText: (m) => {
          textSent.push(m.text);
          return Promise.resolve({ providerMessageId: 'wamid.text' });
        },
      },
      handoff: {
        isHumanMode: () => Promise.resolve(state.human),
        ...(options.withoutReader === true
          ? {}
          : {
              isEnding: (id: string) => {
                isEndingCalls.push(id);
                if (state.ending instanceof Error)
                  return Promise.reject(state.ending);
                return Promise.resolve(state.ending);
              },
            }),
      },
      isWindowOpen: () => Promise.resolve(true),
      live: { plan },
    },
    {
      clock: () => NOW,
      random: () => 1,
      newAttemptId: () => {
        attempt += 1;
        return attemptId(attempt);
      },
    },
  );
  return {
    store,
    service,
    state,
    textSent,
    relayed,
    pendingCalls,
    isEndingCalls,
  };
};
type Harness = ReturnType<typeof setup>;

const heldCancel = async (h: Harness, id = 'hc1') => {
  const { row } = await h.store.insertDelivery(cancelledItem(id));
  await h.store.transition(
    row.deliveryId,
    { localState: 'RECEIVED', attemptId: null },
    {
      localState: 'HELD_HUMAN',
      decision: 'CANCEL_NOTICE',
      attemptId: attemptId(90),
      attemptedAt: NOW.toISOString(),
      providerMessageId: null,
      ack: null,
    },
  );
};

describe('ENDING marker honoured by the replay paths (follow-ups S4)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('onCustomerInbound releases nothing and makes no backend call while ENDING; it releases once the marker is gone', async () => {
    const h = setup();
    await heldCancel(h);
    await h.service.onCustomerInbound(REF);
    expect(h.textSent).toEqual([]);
    expect(h.pendingCalls).toEqual([]);
    await expect(h.store.getDelivery('hc1')).resolves.toMatchObject({
      localState: 'HELD_HUMAN',
    });
    h.state.ending = false;
    await h.service.onCustomerInbound(REF);
    expect(h.textSent).toHaveLength(1);
    await expect(h.store.getDelivery('hc1')).resolves.toMatchObject({
      localState: 'SENT',
    });
  });

  it('the 15 s replayHeld sweep releases nothing while ENDING and everything after', async () => {
    const h = setup();
    await heldCancel(h, 'hc1');
    await heldCancel(h, 'hc2');
    await expect(h.service.replayHeld()).resolves.toBe(0);
    await expect(h.service.replayHeld()).resolves.toBe(0);
    expect(h.textSent).toEqual([]);
    h.state.ending = false;
    await expect(h.service.replayHeld()).resolves.toBe(2);
    expect(h.textSent).toHaveLength(2);
  });

  it('replayHeld reads the marker once per conversation, not once per row', async () => {
    const h = setup();
    await heldCancel(h, 'hc1');
    await heldCancel(h, 'hc2');
    await heldCancel(h, 'hc3');
    await h.service.replayHeld();
    expect(h.isEndingCalls).toHaveLength(1);
  });

  it('onHumanCustomerInbound does not resend a deferred staff message while ENDING', async () => {
    const h = setup({ ending: false });
    await h.store.insertDelivery(staffMessageItem('sm1'));
    const row = (await h.store.getDelivery('sm1'))!;
    await h.store.transition(
      row.deliveryId,
      { localState: 'RECEIVED', attemptId: null },
      {
        localState: 'DEFERRED_WINDOW',
        decision: 'STAFF_MESSAGE',
        attemptId: attemptId(91),
        attemptedAt: NOW.toISOString(),
        providerMessageId: null,
        ack: null,
      },
    );
    h.state.ending = true;
    await h.service.onHumanCustomerInbound(REF);
    expect(h.relayed).toEqual([]);
    h.state.ending = false;
    await h.service.onHumanCustomerInbound(REF);
    expect(h.relayed).toEqual(['sm1']);
  });

  it('the farewell path itself (a feed ended item) is unaffected by the marker', async () => {
    const h = setup();
    await h.service.accept(endedItem('e1'));
    expect(h.textSent).toEqual(['farewell']);
    await expect(h.store.getDelivery('e1')).resolves.toMatchObject({
      localState: 'SENT',
    });
  });

  it('an unreadable marker holds (fail closed) instead of releasing', async () => {
    const h = setup({ ending: new Error('db down') });
    await heldCancel(h);
    await expect(h.service.onCustomerInbound(REF)).resolves.toBeUndefined();
    await expect(h.service.replayHeld()).resolves.toBe(0);
    expect(h.textSent).toEqual([]);
  });

  it('without a reader that knows isEnding nothing changes (hand-built harnesses)', async () => {
    const h = setup({ withoutReader: true });
    await heldCancel(h);
    await h.service.onCustomerInbound(REF);
    expect(h.textSent).toHaveLength(1);
  });
});
