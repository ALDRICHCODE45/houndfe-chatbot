import { Logger } from '@nestjs/common';
import type {
  ConversationStaffMessageItem,
  DeliveryOutcomeInput,
  PendingDeliveriesResult,
  RecordDeliveryOutcomeResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import { WhatsappSendError } from '../../whatsapp/infrastructure/meta-whatsapp.sender';
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
const NOW = new Date('2026-11-10T16:20:00.000Z');
const WINDOW_CLOSED = () =>
  new WhatsappSendError(400, '131047', 'Re-engagement message');

const message = (
  deliveryId: string,
  seq: number,
  deferred = false,
): ConversationStaffMessageItem => {
  const base = staffMessageItem(deliveryId);
  return {
    ...base,
    payload: { ...base.payload, seq },
    ...(deferred ? { deferredReason: 'WINDOW_CLOSED' as const } : {}),
  };
};

/**
 * Delivery service + a stub live handler (the relay plan the real handler
 * builds for a staff message while HUMAN on the item's epoch) + a fake
 * backend. `deliveries` scripts what Meta answers to each relay send.
 */
const setup = (options: { unfinishedEndMaxMs?: number } = {}) => {
  const time = { now: NOW };
  // The store stamps its writes with the same fake clock as the service, so
  // "written after the lookup started" is deterministic.
  const store = new InMemoryHumanRequestFeedStore(() => time.now.getTime());
  const acks: Array<{ deliveryId: string; body: DeliveryOutcomeInput }> = [];
  const ackScript: Array<RecordDeliveryOutcomeResult | Error> = [];
  const pendingCalls: string[] = [];
  const backend: {
    pending: PendingDeliveriesResult | Error;
    /** Runs while a listing is in flight (after the backend answered, before
     *  the caller sees it): a concurrent replayer's writes go here. */
    duringList?: () => Promise<void>;
  } = {
    pending: { kind: 'ok', items: [] },
  };
  const delivered: string[] = [];
  const metaScript: Array<Error | string> = [];
  const textSent: string[] = [];
  const human = { value: true };
  let wamid = 0;
  let attempt = 0;
  const plan = (row: DeliveryRow): Promise<LivePlan> => {
    if (row.item.type !== 'conversation.staff_message')
      return Promise.resolve({ action: 'stale', decision: 'UNKNOWN_TYPE' });
    return Promise.resolve({
      action: 'relay',
      decision: 'STAFF_MESSAGE',
      senderId: SENDER,
      deferrable: true,
      deliver: () => {
        delivered.push(row.deliveryId);
        const next = metaScript.shift();
        if (next instanceof Error) return Promise.reject(next);
        wamid += 1;
        return Promise.resolve({ providerMessageId: next ?? `wamid.${wamid}` });
      },
    });
  };
  const service = new HumanRequestDeliveryService(
    {
      store,
      client: {
        recordDeliveryOutcome: (deliveryId, body) => {
          acks.push({ deliveryId, body });
          const next = ackScript.shift();
          if (next instanceof Error) return Promise.reject(next);
          return Promise.resolve(
            next ?? {
              kind: 'ok',
              response: {
                deliveryId,
                outcome: body.outcome,
                attemptId: body.attemptId,
                ackReceivedAt: null,
              },
            },
          );
        },
        listPendingDeliveries: async (filter) => {
          pendingCalls.push(filter.conversationRef ?? '');
          const answer = backend.pending;
          await backend.duringList?.();
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      sender: {
        sendText: (m) => {
          textSent.push(m.text);
          return Promise.resolve({ providerMessageId: 'wamid.text' });
        },
      },
      handoff: { isHumanMode: () => Promise.resolve(human.value) },
      isWindowOpen: () => Promise.resolve(true),
      live: { plan },
    },
    {
      clock: () => time.now,
      random: () => 1,
      unfinishedEndMaxMs: options.unfinishedEndMaxMs,
      newAttemptId: () => {
        attempt += 1;
        return `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
      },
    },
  );
  return {
    store,
    service,
    acks,
    ackScript,
    pendingCalls,
    backend,
    delivered,
    metaScript,
    textSent,
    time,
    human,
  };
};

const later = (ms: number) => new Date(NOW.getTime() + ms);

const attemptId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('deferred staff messages while the conversation is HUMAN (B1)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a customer inbound resends the deferred message with a new attemptId and ACKs PROVIDER_ACCEPTED', async () => {
    const { service, store, acks, metaScript, delivered, backend } = setup();
    metaScript.push(WINDOW_CLOSED());
    await service.accept(message('b1', 18));
    await expect(store.getDelivery('b1')).resolves.toMatchObject({
      localState: 'DEFERRED_WINDOW',
      attemptId: attemptId(1),
    });
    expect(acks.map((a) => a.body.outcome)).toEqual(['DEFERRED_WINDOW_CLOSED']);
    backend.pending = { kind: 'ok', items: [message('b1', 18, true)] };

    await service.onHumanCustomerInbound(REF);

    expect(delivered).toEqual(['b1', 'b1']);
    await expect(store.getDelivery('b1')).resolves.toMatchObject({
      localState: 'SENT',
      attemptId: attemptId(2),
      providerMessageId: 'wamid.1',
      ackState: 'ACKED',
      ackOutcome: 'PROVIDER_ACCEPTED',
    });
    expect(acks[1].body).toMatchObject({
      outcome: 'PROVIDER_ACCEPTED',
      attemptId: attemptId(2),
      providerMessageId: 'wamid.1',
    });
  });

  it('replays a local deferral the backend does not list (its ACK never landed)', async () => {
    const { service, store, metaScript, ackScript, delivered } = setup();
    metaScript.push(WINDOW_CLOSED());
    ackScript.push(new Error('502'));
    await service.accept(message('b2', 18));
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual(['b2', 'b2']);
    await expect(store.getDelivery('b2')).resolves.toMatchObject({
      localState: 'SENT',
    });
  });

  it('resends several deferred messages in seq order, whatever order they are listed or stored in', async () => {
    const { service, store, metaScript, delivered, backend } = setup();
    metaScript.push(WINDOW_CLOSED(), WINDOW_CLOSED(), WINDOW_CLOSED());
    await service.accept(message('s3', 30));
    await service.accept(message('s1', 10));
    await service.accept(message('s2', 20));
    delivered.length = 0;
    backend.pending = {
      kind: 'ok',
      items: [
        message('s3', 30, true),
        message('s1', 10, true),
        message('s2', 20, true),
      ],
    };
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual(['s1', 's2', 's3']);
    for (const id of ['s1', 's2', 's3'])
      await expect(store.getDelivery(id)).resolves.toMatchObject({
        localState: 'SENT',
      });
  });

  it('never releases held request.* rows and sends no bot text while HUMAN', async () => {
    const { service, store, textSent, delivered, metaScript, backend } =
      setup();
    // A cancellation notice that arrived while HUMAN would be STALE; a held
    // row is simulated directly.
    const { row } = await store.insertDelivery(cancelledItem('h1'));
    await store.transition(
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
    metaScript.push(WINDOW_CLOSED());
    await service.accept(message('b3', 18));
    backend.pending = { kind: 'ok', items: [message('b3', 18, true)] };

    await service.onHumanCustomerInbound(REF);

    expect(textSent).toEqual([]);
    await expect(store.getDelivery('h1')).resolves.toMatchObject({
      localState: 'HELD_HUMAN',
      attemptId: attemptId(90),
    });
    expect(delivered).toEqual(['b3', 'b3']);
  });

  it('only live staff messages are replayed (a local request.* deferral stays as it is)', async () => {
    const { service, store, delivered, textSent } = setup();
    const { row } = await store.insertDelivery(cancelledItem('d1'));
    await store.transition(
      row.deliveryId,
      { localState: 'RECEIVED', attemptId: null },
      {
        localState: 'DEFERRED_WINDOW',
        decision: 'CANCEL_NOTICE',
        attemptId: attemptId(91),
        attemptedAt: NOW.toISOString(),
        providerMessageId: null,
        ack: null,
      },
    );
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual([]);
    expect(textSent).toEqual([]);
    await expect(store.getDelivery('d1')).resolves.toMatchObject({
      localState: 'DEFERRED_WINDOW',
    });
  });

  it('asks the backend once per inbound, and not again within the throttle window', async () => {
    const { service, pendingCalls, time } = setup();
    await service.onHumanCustomerInbound(REF);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF]);
    time.now = new Date(NOW.getTime() + 60_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF, REF]);
    await service.onHumanCustomerInbound('wa:5215550002222');
    expect(pendingCalls).toEqual([REF, REF, 'wa:5215550002222']);
  });

  it('a local deferral is still replayed inside the throttle window (no backend call)', async () => {
    const { service, metaScript, delivered, pendingCalls } = setup();
    await service.onHumanCustomerInbound(REF);
    metaScript.push(WINDOW_CLOSED());
    await service.accept(message('b4', 18));
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toHaveLength(1);
    expect(delivered).toEqual(['b4', 'b4']);
  });

  it('never throws: a failing backend read does not stop the local replay', async () => {
    const { service, store, metaScript, backend, delivered } = setup();
    metaScript.push(WINDOW_CLOSED());
    await service.accept(message('b5', 18));
    backend.pending = new Error('backend down');
    await expect(service.onHumanCustomerInbound(REF)).resolves.toBeUndefined();
    expect(delivered).toEqual(['b5', 'b5']);
    await expect(store.getDelivery('b5')).resolves.toMatchObject({
      localState: 'SENT',
    });
  });

  it('a malformed conversationRef is ignored', async () => {
    const { service, pendingCalls } = setup();
    await service.onHumanCustomerInbound('not-a-ref');
    expect(pendingCalls).toEqual([]);
  });

  it('logs never print the customer phone', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, backend } = setup();
    backend.pending = new Error('backend down');
    await service.onHumanCustomerInbound(REF);
    const lines = (warn.mock.calls as unknown[][]).map((call) =>
      String(call[0]),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(SENDER);
  });
});

describe('a staff message failed with 131047 after Meta accepted it (B2)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const sentAndAcked = async (id = 'x1') => {
    const harness = setup();
    await harness.service.accept(message(id, 18));
    await expect(harness.store.getDelivery(id)).resolves.toMatchObject({
      localState: 'SENT',
      providerMessageId: 'wamid.1',
      ackState: 'ACKED',
    });
    // Later, the customer writes again (after the ACK was recorded).
    harness.time.now = later(60_000);
    return harness;
  };

  it('listed again as deferred WINDOW_CLOSED while the local row is SENT: deferred, then resent with a new attemptId on the next HUMAN inbound', async () => {
    const { service, store, acks, delivered, backend } = await sentAndAcked();
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };

    await service.onHumanCustomerInbound(REF);

    expect(delivered).toEqual(['x1', 'x1']);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      localState: 'SENT',
      attemptId: attemptId(3),
      providerMessageId: 'wamid.2',
      ackState: 'ACKED',
      ackOutcome: 'PROVIDER_ACCEPTED',
    });
    // attempt 2 was the SENT → DEFERRED_WINDOW move, 3 the resend.
    expect(acks.map((a) => a.body.attemptId)).toEqual([
      attemptId(1),
      attemptId(3),
    ]);
    expect(acks[1].body).toMatchObject({
      outcome: 'PROVIDER_ACCEPTED',
      providerMessageId: 'wamid.2',
    });
  });

  it('the move SENT → DEFERRED_WINDOW is a compare-and-set (a row that moved on is left alone)', async () => {
    const { service, store, delivered, backend } = await sentAndAcked();
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };
    jest.spyOn(store, 'transition').mockResolvedValueOnce(null);
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual(['x1']);
  });

  it('also works in BOT mode replay (onCustomerInbound) for a row Meta accepted', async () => {
    const { service, delivered, backend, store } = await sentAndAcked();
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };
    await service.onCustomerInbound(REF);
    // The stub handler resends; the real handler would STALE it in BOT mode.
    expect(delivered).toEqual(['x1', 'x1']);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      localState: 'SENT',
      attemptId: attemptId(3),
    });
  });

  it('an UNKNOWN row (ACKed DELIVERY_UNKNOWN) listed as deferred is resent too', async () => {
    const harness = setup();
    harness.metaScript.push(new Error('socket hang up'));
    await harness.service.accept(message('x2', 18));
    await expect(harness.store.getDelivery('x2')).resolves.toMatchObject({
      localState: 'UNKNOWN',
      ackState: 'ACKED',
    });
    harness.time.now = later(60_000);
    harness.backend.pending = { kind: 'ok', items: [message('x2', 18, true)] };
    await harness.service.onHumanCustomerInbound(REF);
    expect(harness.delivered).toEqual(['x2', 'x2']);
    await expect(harness.store.getDelivery('x2')).resolves.toMatchObject({
      localState: 'SENT',
    });
  });

  it('a SENT row whose ACK is still PENDING is not resent (the backend has not heard of it yet): the ACK is flushed instead', async () => {
    const harness = setup();
    harness.ackScript.push(new Error('502'));
    await harness.service.accept(message('x3', 18));
    await expect(harness.store.getDelivery('x3')).resolves.toMatchObject({
      localState: 'SENT',
      ackState: 'PENDING',
    });
    harness.backend.pending = { kind: 'ok', items: [message('x3', 18, true)] };
    await harness.service.onHumanCustomerInbound(REF);
    expect(harness.delivered).toEqual(['x3']);
  });

  it('listed without a deferredReason (plain pending) the SENT row is not resent', async () => {
    const { service, delivered, backend } = await sentAndAcked();
    backend.pending = { kind: 'ok', items: [message('x1', 18)] };
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual(['x1']);
  });

  it('a resend answered 409 OUTCOME_ALREADY_RECORDED means "not coming": the ACK is permanently failed and the row is never resent', async () => {
    const {
      service,
      store,
      ackScript,
      delivered,
      backend,
      acks,
      time,
      pendingCalls,
    } = await sentAndAcked();
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };
    ackScript.push({ kind: 'OUTCOME_ALREADY_RECORDED' } as never);
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual(['x1', 'x1']);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      ackState: 'FAILED_PERMANENT',
    });
    // Even if the backend (wrongly) listed it again, we stop. The clock moves
    // past the throttle so the backend really is queried each time.
    const before = acks.length;
    const queried = pendingCalls.length;
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };
    time.now = later(5 * 60_000);
    await service.onHumanCustomerInbound(REF);
    time.now = later(10 * 60_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toHaveLength(queried + 2);
    expect(delivered).toEqual(['x1', 'x1']);
    expect(acks).toHaveLength(before);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      localState: 'SENT',
      ackState: 'FAILED_PERMANENT',
    });
  });

  it('stale listing: a listing fetched before a concurrent replayer resent and ACKed the row does not reopen it (no double send)', async () => {
    const { service, store, delivered, backend, acks, time } =
      await sentAndAcked();
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };
    // While our listing is in flight, another replayer finishes the resend
    // (SENT → SENT with a new attempt) and its ACK is recorded.
    backend.duringList = async () => {
      backend.duringList = undefined;
      const row = await store.getDelivery('x1');
      const next = await store.transition(
        'x1',
        { localState: 'SENT', attemptId: row!.attemptId },
        {
          localState: 'SENT',
          decision: 'STAFF_MESSAGE',
          attemptId: attemptId(50),
          attemptedAt: time.now.toISOString(),
          providerMessageId: 'wamid.other',
          ack: 'PROVIDER_ACCEPTED',
        },
      );
      await store.completeAck('x1', next!.attemptId!, { ackState: 'ACKED' });
    };
    const before = acks.length;

    await service.onHumanCustomerInbound(REF);

    expect(delivered).toEqual(['x1']);
    expect(acks).toHaveLength(before);
    await expect(store.getDelivery('x1')).resolves.toMatchObject({
      localState: 'SENT',
      attemptId: attemptId(50),
      providerMessageId: 'wamid.other',
      ackState: 'ACKED',
    });
  });

  it('a row ACKed before the lookup started is reopened (the guard only blocks a newer write)', async () => {
    const { service, delivered, backend, time, store } = await sentAndAcked();
    const row = await store.getDelivery('x1');
    // The ACK landed strictly before the lookup starts.
    time.now = new Date(row!.updatedAt.getTime() + 1);
    backend.pending = { kind: 'ok', items: [message('x1', 18, true)] };
    await service.onHumanCustomerInbound(REF);
    expect(delivered).toEqual(['x1', 'x1']);
  });
});

describe('the HUMAN pending-deliveries throttle (L16 a, verify adv. 5)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a failed lookup does not arm the throttle: the next inbound inside the window asks again', async () => {
    const { service, pendingCalls, backend, time } = setup();
    backend.pending = new Error('backend down');
    await service.onHumanCustomerInbound(REF);
    time.now = later(1_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF, REF]);
  });

  it('a rate-limited lookup does not arm the throttle either', async () => {
    const { service, pendingCalls, backend, time } = setup();
    backend.pending = { kind: 'RATE_LIMITED', retryAfterSeconds: 5 };
    await service.onHumanCustomerInbound(REF);
    time.now = later(1_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF, REF]);
  });

  it('a successful lookup still throttles the next inbound inside the window', async () => {
    const { service, pendingCalls, time } = setup();
    await service.onHumanCustomerInbound(REF);
    time.now = later(1_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF]);
  });

  it('a backend-only deferral that appears inside the throttle window is resent on a later inbound after the window', async () => {
    const { service, store, pendingCalls, backend, delivered, time } = setup();
    // First inbound: nothing deferred yet; the lookup arms the throttle.
    await service.onHumanCustomerInbound(REF);
    // Staff message sent; Meta accepts, then 131047 makes the backend defer
    // it again (the local row stays SENT/ACKED).
    await service.accept(message('bo1', 18));
    expect(delivered).toEqual(['bo1']);
    backend.pending = { kind: 'ok', items: [message('bo1', 18, true)] };
    // Inside the window: no backend call, nothing resent.
    time.now = later(5_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF]);
    expect(delivered).toEqual(['bo1']);
    // After the window: the backend is asked again and the row is resent.
    time.now = later(60_000);
    await service.onHumanCustomerInbound(REF);
    expect(pendingCalls).toEqual([REF, REF]);
    expect(delivered).toEqual(['bo1', 'bo1']);
    await expect(store.getDelivery('bo1')).resolves.toMatchObject({
      localState: 'SENT',
      ackState: 'ACKED',
    });
  });
});

describe('the unfinished-ended hold is bounded and logged once (L13 a)', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const MIN = 60_000;
  const heldCancel = async (harness: ReturnType<typeof setup>) => {
    const { row } = await harness.store.insertDelivery(cancelledItem('hc1'));
    await harness.store.transition(
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
    harness.human.value = false;
  };
  const lines = (spy: jest.SpyInstance) =>
    (spy.mock.calls as unknown[][])
      .map((call) => String(call[0]))
      .filter((line) => line.includes('conversation.ended'));

  it('a fresh unfinished ended holds the replay (and the hold is logged once)', async () => {
    const harness = setup();
    await heldCancel(harness);
    await harness.store.insertDelivery(endedItem('e1'));
    harness.time.now = later(MIN);
    await harness.service.onCustomerInbound(REF);
    await harness.service.onCustomerInbound(REF);
    expect(harness.textSent).toEqual([]);
    await expect(harness.store.getDelivery('hc1')).resolves.toMatchObject({
      localState: 'HELD_HUMAN',
    });
    const held = lines(log);
    expect(held).toHaveLength(1);
    expect(held[0]).not.toContain(SENDER);
    expect(held[0]).toContain('1111');
  });

  it('an ended stuck for more than 10 minutes no longer holds: the replay goes out, the expiry is logged once', async () => {
    const harness = setup();
    await heldCancel(harness);
    await harness.store.insertDelivery(endedItem('e2'));
    harness.time.now = later(11 * MIN);
    await harness.service.onCustomerInbound(REF);
    expect(harness.textSent).toHaveLength(1);
    await expect(harness.store.getDelivery('hc1')).resolves.toMatchObject({
      localState: 'SENT',
    });
    // A second held row of the same conversation: no second log line.
    const { row } = await harness.store.insertDelivery(cancelledItem('hc2'));
    await harness.store.transition(
      row.deliveryId,
      { localState: 'RECEIVED', attemptId: null },
      {
        localState: 'HELD_HUMAN',
        decision: 'CANCEL_NOTICE',
        attemptId: attemptId(91),
        attemptedAt: NOW.toISOString(),
        providerMessageId: null,
        ack: null,
      },
    );
    await harness.service.onCustomerInbound(REF);
    expect(harness.textSent).toHaveLength(2);
    const expired = lines(warn);
    expect(expired).toHaveLength(1);
    expect(expired[0]).not.toContain(SENDER);
  });

  it('the bound is configurable: a 1 minute bound releases an ended older than that, the default 10 minute bound still holds it', async () => {
    const short = setup({ unfinishedEndMaxMs: MIN });
    await heldCancel(short);
    await short.store.insertDelivery(endedItem('e3'));
    // 2 minutes after the ended was written: inside the default bound, past
    // the configured one.
    short.time.now = later(2 * MIN);
    await short.service.onCustomerInbound(REF);
    expect(short.textSent).toHaveLength(1);

    const dflt = setup();
    await heldCancel(dflt);
    await dflt.store.insertDelivery(endedItem('e4'));
    dflt.time.now = later(2 * MIN);
    await dflt.service.onCustomerInbound(REF);
    expect(dflt.textSent).toEqual([]);
  });
});
