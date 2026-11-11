import { Logger } from '@nestjs/common';
import type {
  DeliveryOutcomeInput,
  PendingDeliveriesResult,
  RecordDeliveryOutcomeResult,
  RequestAnsweredItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { WhatsappSendError } from '../../whatsapp/infrastructure/meta-whatsapp.sender';
import {
  REF,
  cancelledItem,
} from '../infrastructure/human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import {
  HumanRequestDeliveryService,
  type HumanRequestDeliveryOptions,
} from './human-request-delivery.service';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-10T16:20:00.000Z');
const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'casual' };

const answered = (
  deliveryId: string,
  payload: RequestAnsweredItem['payload'],
  patch: Partial<RequestAnsweredItem> = {},
): RequestAnsweredItem => ({
  cursor: `c-${deliveryId}`,
  deliveryId,
  type: 'request.answered',
  requestId: `req-${deliveryId}`,
  conversationRef: REF,
  notBefore: null,
  expiresAt: null,
  payload,
  ...patch,
});

const decision = (deliveryId: string) =>
  answered(deliveryId, {
    kind: 'DECISION',
    subtype: 'RESTOCK',
    action: 'PROVIDE_RESTOCK_ESTIMATE',
    legacyId: 'legacy-1',
    text: 'El producto «Croquetas 20 kg» estará disponible en aproximadamente 7 días.',
    prefix: null,
    productName: 'Croquetas 20 kg',
    restockDays: 7,
  });

const clarification = (deliveryId: string, text = 'Sí, lo tenemos en azul.') =>
  answered(deliveryId, {
    kind: 'CLARIFICATION',
    text,
    prefix: 'Le comparto la respuesta del equipo:',
  });

class FakeClient {
  readonly acks: Array<{ deliveryId: string; body: DeliveryOutcomeInput }> = [];
  readonly pendingCalls: string[] = [];
  ackScript: Array<RecordDeliveryOutcomeResult | Error> = [];
  pending: PendingDeliveriesResult | Error = { kind: 'ok', items: [] };

  recordDeliveryOutcome(
    deliveryId: string,
    body: DeliveryOutcomeInput,
  ): Promise<RecordDeliveryOutcomeResult> {
    this.acks.push({ deliveryId, body });
    const next = this.ackScript.shift();
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
  }

  listPendingDeliveries(filter: {
    conversationRef?: string;
  }): Promise<PendingDeliveriesResult> {
    this.pendingCalls.push(filter.conversationRef ?? '');
    return this.pending instanceof Error
      ? Promise.reject(this.pending)
      : Promise.resolve(this.pending);
  }
}

class FakeSender {
  readonly sent: Array<{ to: string; text: string }> = [];
  script: Array<Error | string> = [];
  private n = 0;
  sendText(message: { to: string; text: string }) {
    this.sent.push(message);
    const next = this.script.shift();
    if (next instanceof Error) return Promise.reject(next);
    this.n += 1;
    return Promise.resolve({ providerMessageId: next ?? `wamid.${this.n}` });
  }
}

const setup = (options: HumanRequestDeliveryOptions = {}) => {
  const store = new InMemoryHumanRequestFeedStore();
  const modeChecks: string[] = [];
  const client = new FakeClient();
  const sender = new FakeSender();
  const human = { value: false };
  const window = { open: true };
  const time = { now: NOW };
  let style: CustomerStyle | null = null;
  let attempt = 0;
  const service = new HumanRequestDeliveryService(
    {
      store,
      client,
      sender,
      handoff: {
        isHumanMode: (senderId: string) => {
          modeChecks.push(senderId);
          return Promise.resolve(human.value);
        },
      },
      isWindowOpen: () => Promise.resolve(window.open),
      customerStyle: () => Promise.resolve(style),
    },
    {
      ...options,
      clock: () => time.now,
      random: () => 1,
      newAttemptId: () => {
        attempt += 1;
        return `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
      },
    },
  );
  return {
    store,
    client,
    sender,
    human,
    window,
    time,
    service,
    modeChecks,
    setStyle: (next: CustomerStyle | null) => {
      style = next;
    },
  };
};

const attemptId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('HumanRequestDeliveryService', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('request.answered', () => {
    it('DECISION: no send, LEGACY_PATH_DELIVERS, ACK STALE (L4)', async () => {
      const { service, sender, client, store } = setup();
      await service.accept(decision('d1'));
      expect(sender.sent).toEqual([]);
      expect(client.acks).toEqual([
        {
          deliveryId: 'd1',
          body: {
            outcome: 'STALE',
            attemptId: attemptId(1),
            attemptedAt: NOW.toISOString(),
          },
        },
      ]);
      await expect(store.getDelivery('d1')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'LEGACY_PATH_DELIVERS',
        ackState: 'ACKED',
      });
    });

    it('CLARIFICATION: styled prefix + verbatim text, ACK PROVIDER_ACCEPTED', async () => {
      const { service, sender, client, store, setStyle } = setup();
      setStyle(TU);
      await service.accept(
        clarification('d2', 'Usted puede pasar el lunes, dígame si le sirve.'),
      );
      expect(sender.sent).toEqual([
        {
          to: SENDER,
          text: 'Te comparto la respuesta del equipo:\nUsted puede pasar el lunes, dígame si le sirve.',
        },
      ]);
      expect(client.acks).toEqual([
        {
          deliveryId: 'd2',
          body: {
            outcome: 'PROVIDER_ACCEPTED',
            attemptId: attemptId(1),
            providerMessageId: 'wamid.1',
            attemptedAt: NOW.toISOString(),
          },
        },
      ]);
      await expect(store.getDelivery('d2')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'CLARIFICATION',
        providerMessageId: 'wamid.1',
        ackState: 'ACKED',
      });
    });

    it('CLARIFICATION without a stored style keeps the usted prefix', async () => {
      const { service, sender } = setup();
      await service.accept(clarification('d3'));
      expect(sender.sent[0].text).toBe(
        'Le comparto la respuesta del equipo:\nSí, lo tenemos en azul.',
      );
    });

    it('an unrecognized kind is not sent: ACK STALE with a warning', async () => {
      const { service, sender, client, store } = setup();
      await service.accept(
        answered('d4', {
          kind: 'unrecognized',
          text: 'algo',
          prefix: null,
          raw: { kind: 'POLL' },
        }),
      );
      expect(sender.sent).toEqual([]);
      expect(client.acks[0].body.outcome).toBe('STALE');
      await expect(store.getDelivery('d4')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'UNKNOWN_KIND',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('POLL'));
    });

    it('a send with no conversationRef is not attempted: ACK STALE', async () => {
      const { service, sender, client, store } = setup();
      await service.accept({ ...clarification('d5'), conversationRef: null });
      expect(sender.sent).toEqual([]);
      expect(client.acks[0].body.outcome).toBe('STALE');
      await expect(store.getDelivery('d5')).resolves.toMatchObject({
        decision: 'NO_CONVERSATION',
      });
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('request.cancelled', () => {
    it('closes the registry row; DUPLICATE sends nothing and ACKs STALE', async () => {
      const { service, sender, client, store } = setup();
      await store.recordOpenRequest({
        requestId: 'req-c1',
        conversationRef: REF,
        subtype: 'UNKNOWN_QUESTION',
      });
      await service.accept(
        cancelledItem('c1', {
          payload: {
            requestId: 'req-c1',
            reason: 'DUPLICATE',
            cancelledBy: 'STAFF',
          },
        }),
      );
      expect(sender.sent).toEqual([]);
      expect(client.acks[0].body.outcome).toBe('STALE');
      await expect(store.getRequest('req-c1')).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      await expect(store.getDelivery('c1')).resolves.toMatchObject({
        decision: 'DUPLICATE',
      });
    });

    it('other reasons send the styled generic notice while the window is open', async () => {
      const { service, sender, client, setStyle } = setup();
      setStyle(TU);
      await service.accept(cancelledItem('c2'));
      expect(sender.sent).toEqual([
        {
          to: SENDER,
          text: 'El equipo cerró tu consulta. Si necesitas algo más, escríbeme por aquí.',
        },
      ]);
      expect(client.acks[0].body.outcome).toBe('PROVIDER_ACCEPTED');
    });

    it('the usted generic notice by default', async () => {
      const { service, sender } = setup();
      await service.accept(cancelledItem('c3'));
      expect(sender.sent[0].text).toBe(
        'El equipo cerró su consulta. Si necesita algo más, escríbame por aquí.',
      );
    });

    it('customerNote is relayed verbatim after the team prefix', async () => {
      const { service, sender } = setup();
      await service.accept(
        cancelledItem('c4', {
          payload: {
            requestId: 'req-c4',
            reason: 'NOT_ACTIONABLE',
            cancelledBy: 'STAFF',
            customerNote: 'Ese modelo ya no se fabrica, disculpe.',
          },
        }),
      );
      expect(sender.sent[0].text).toBe(
        'Le comparto la respuesta del equipo:\nEse modelo ya no se fabrica, disculpe.',
      );
    });

    it('window closed: no send, ACK STALE, never a deferral', async () => {
      const { service, sender, client, store, window } = setup();
      window.open = false;
      await service.accept(cancelledItem('c5'));
      expect(sender.sent).toEqual([]);
      expect(client.acks[0].body.outcome).toBe('STALE');
      await expect(store.getDelivery('c5')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'WINDOW_CLOSED',
      });
    });

    it("Meta's window error on a notice is STALE, not a deferral", async () => {
      const { service, sender, client } = setup();
      sender.script = [new WhatsappSendError(400, 131047, 'Re-engagement')];
      await service.accept(cancelledItem('c6'));
      expect(client.acks[0].body.outcome).toBe('STALE');
    });
  });

  it('an unknown item type is not sent: ACK STALE with a warning', async () => {
    const { service, sender, client, store } = setup();
    await service.accept({
      type: 'unknown',
      rawType: 'conversation.started',
      cursor: '9',
      deliveryId: 'u1',
      raw: {},
    });
    expect(sender.sent).toEqual([]);
    expect(client.acks[0].body.outcome).toBe('STALE');
    await expect(store.getDelivery('u1')).resolves.toMatchObject({
      decision: 'UNKNOWN_TYPE',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('conversation.started'),
    );
  });

  describe('no double delivery', () => {
    it('a replayed deliveryId is never sent again', async () => {
      const { service, sender, client } = setup();
      await service.accept(clarification('r1'));
      await service.accept(clarification('r1'));
      expect(sender.sent).toHaveLength(1);
      expect(client.acks).toHaveLength(1);
    });

    it('crash after send before ACK: the replay ACKs the stored evidence, no second send', async () => {
      const { service, sender, client, store } = setup();
      client.ackScript = [new Error('socket hang up')];
      await service.accept(clarification('r2'));
      expect(sender.sent).toHaveLength(1);
      const stored = await store.getDelivery('r2');
      expect(stored).toMatchObject({ localState: 'SENT', ackState: 'PENDING' });

      await service.accept(clarification('r2'));
      expect(sender.sent).toHaveLength(1);
      expect(client.acks).toHaveLength(2);
      expect(client.acks[1]).toEqual(client.acks[0]);
      await expect(store.getDelivery('r2')).resolves.toMatchObject({
        ackState: 'ACKED',
      });
    });

    it('uncertain send: UNKNOWN + DELIVERY_UNKNOWN, never retried', async () => {
      const { service, sender, client, store } = setup();
      sender.script = [new WhatsappSendError(null, null, 'timeout')];
      await service.accept(clarification('r3'));
      expect(client.acks[0].body).toEqual({
        outcome: 'DELIVERY_UNKNOWN',
        attemptId: attemptId(1),
        attemptedAt: NOW.toISOString(),
      });
      await expect(store.getDelivery('r3')).resolves.toMatchObject({
        localState: 'UNKNOWN',
      });
      await service.accept(clarification('r3'));
      await service.sweepAcks();
      await service.replayHeld();
      expect(sender.sent).toHaveLength(1);
    });

    it('a crash between SENDING and the result is recovered as DELIVERY_UNKNOWN by the sweep', async () => {
      const { service, sender, client, store } = setup();
      await store.insertDelivery(clarification('r4'));
      await store.transition(
        'r4',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'SENDING',
          decision: 'CLARIFICATION',
          attemptId: attemptId(99),
          attemptedAt: '2026-11-10T15:00:00.000Z',
          providerMessageId: null,
          ack: null,
        },
      );
      // The feed replay leaves an in-flight-looking row alone…
      await service.accept(clarification('r4'));
      expect(sender.sent).toEqual([]);
      // …and the sweep turns an old one into DELIVERY_UNKNOWN.
      await expect(service.recoverStuckSending()).resolves.toBe(1);
      expect(client.acks[0].body).toEqual({
        outcome: 'DELIVERY_UNKNOWN',
        attemptId: attemptId(99),
        attemptedAt: '2026-11-10T15:00:00.000Z',
      });
      expect(sender.sent).toEqual([]);
    });
  });

  describe('window closed by Meta', () => {
    it('DEFERRED_WINDOW + ACK DEFERRED_WINDOW_CLOSED; replayed on the next inbound', async () => {
      const { service, sender, client, store } = setup();
      sender.script = [new WhatsappSendError(400, '131047', 'Re-engagement')];
      await service.accept(clarification('w1'));
      expect(client.acks[0].body).toEqual({
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptId: attemptId(1),
        attemptedAt: NOW.toISOString(),
      });
      await expect(store.getDelivery('w1')).resolves.toMatchObject({
        localState: 'DEFERRED_WINDOW',
      });
      // A feed replay does not resend a deferred row.
      await service.accept(clarification('w1'));
      expect(sender.sent).toHaveLength(1);

      client.pending = { kind: 'ok', items: [clarification('w1')] };
      await service.onCustomerInbound(REF);
      expect(client.pendingCalls).toEqual([REF]);
      expect(sender.sent).toHaveLength(2);
      expect(client.acks[1].body).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        attemptId: attemptId(2),
      });
    });

    it('a pending delivery unknown locally is recorded and delivered', async () => {
      const { service, sender, client, store } = setup();
      client.pending = { kind: 'ok', items: [clarification('w2')] };
      await service.onCustomerInbound(REF);
      expect(sender.sent).toHaveLength(1);
      await expect(store.getDelivery('w2')).resolves.toMatchObject({
        localState: 'SENT',
      });
    });

    it('onCustomerInbound never throws', async () => {
      const { service, client } = setup();
      client.pending = new Error('backend down');
      await expect(service.onCustomerInbound(REF)).resolves.toBeUndefined();
      client.pending = { kind: 'RATE_LIMITED', retryAfterSeconds: 1 };
      await expect(service.onCustomerInbound(REF)).resolves.toBeUndefined();
      await expect(service.onCustomerInbound('bogus')).resolves.toBeUndefined();
    });
  });

  describe('HUMAN hold', () => {
    it('held: no send, HELD_HUMAN, deferral attempted; replayed once BOT', async () => {
      const { service, sender, client, store, human } = setup();
      human.value = true;
      await service.accept(clarification('h1'));
      expect(sender.sent).toEqual([]);
      expect(client.acks[0].body).toEqual({
        outcome: 'DEFERRED_HUMAN_SESSION',
        attemptId: attemptId(1),
        attemptedAt: NOW.toISOString(),
      });
      await expect(store.getDelivery('h1')).resolves.toMatchObject({
        localState: 'HELD_HUMAN',
        ackState: 'ACKED',
      });
      // Still HUMAN: the sweep keeps it held, no new deferral.
      await service.replayHeld();
      expect(sender.sent).toEqual([]);
      expect(client.acks).toHaveLength(1);

      human.value = false;
      await expect(service.replayHeld()).resolves.toBe(1);
      expect(sender.sent).toHaveLength(1);
      expect(client.acks[1].body).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        attemptId: attemptId(2),
      });
    });

    it('VALIDATION_ERROR on the deferral (5c not live) keeps the hold local', async () => {
      const { service, client, store, human } = setup();
      human.value = true;
      client.ackScript = [{ kind: 'VALIDATION_ERROR', message: 'outcome' }];
      await service.accept(clarification('h2'));
      await expect(store.getDelivery('h2')).resolves.toMatchObject({
        localState: 'HELD_HUMAN',
        ackState: null,
      });
      expect(error).not.toHaveBeenCalled();
      await expect(service.sweepAcks()).resolves.toBe(0);
    });

    it('a held cancellation never sends a deferral and is decided once BOT', async () => {
      const { service, sender, client, store, human, window } = setup();
      human.value = true;
      await service.accept(cancelledItem('h3'));
      expect(client.acks).toEqual([]);
      await expect(store.getDelivery('h3')).resolves.toMatchObject({
        localState: 'HELD_HUMAN',
        ackState: null,
      });
      human.value = false;
      window.open = false;
      await service.onCustomerInbound(REF);
      expect(sender.sent).toEqual([]);
      expect(client.acks[0].body.outcome).toBe('STALE');
    });

    it('an unreadable mode fails the item (retried), never sends', async () => {
      const store = new InMemoryHumanRequestFeedStore();
      const sender = new FakeSender();
      const service = new HumanRequestDeliveryService(
        {
          store,
          client: new FakeClient(),
          sender,
          handoff: { isHumanMode: () => Promise.reject(new Error('db')) },
          isWindowOpen: () => Promise.resolve(true),
        },
        { clock: () => NOW },
      );
      await expect(service.accept(clarification('h4'))).rejects.toThrow();
      expect(sender.sent).toEqual([]);
      await expect(store.getDelivery('h4')).resolves.toMatchObject({
        localState: 'RECEIVED',
      });
    });
  });

  describe('durable ACKs', () => {
    it('the sweeper retries the SAME body until 200', async () => {
      const { service, client, store, time } = setup();
      client.ackScript = [new Error('502'), new Error('502')];
      await service.accept(decision('a1'));
      await expect(store.getDelivery('a1')).resolves.toMatchObject({
        ackState: 'PENDING',
        ackAttempts: 1,
      });
      // Not due yet (backoff).
      await expect(service.sweepAcks()).resolves.toBe(0);
      time.now = new Date(NOW.getTime() + 3_600_000);
      await expect(service.sweepAcks()).resolves.toBe(1);
      time.now = new Date(NOW.getTime() + 7_200_000);
      await expect(service.sweepAcks()).resolves.toBe(1);
      expect(client.acks).toHaveLength(3);
      expect(new Set(client.acks.map((a) => JSON.stringify(a))).size).toBe(1);
      await expect(store.getDelivery('a1')).resolves.toMatchObject({
        ackState: 'ACKED',
        ackAttempts: 2,
      });
    });

    it('RATE_LIMITED honors Retry-After', async () => {
      const { service, client, store } = setup();
      client.ackScript = [{ kind: 'RATE_LIMITED', retryAfterSeconds: 42 }];
      await service.accept(decision('a2'));
      const row = await store.getDelivery('a2');
      expect(row?.nextAckAt?.getTime()).toBe(NOW.getTime() + 42_000);
    });

    it.each([
      'IDEMPOTENCY_CONFLICT',
      'OUTCOME_ALREADY_RECORDED',
      'OUTCOME_NOT_ALLOWED',
      'NOT_FOUND',
    ] as const)('%s is FAILED_PERMANENT with an error log', async (kind) => {
      const { service, client, store } = setup();
      client.ackScript = [{ kind }];
      await service.accept(decision('a3'));
      await expect(store.getDelivery('a3')).resolves.toMatchObject({
        ackState: 'FAILED_PERMANENT',
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining(kind));
      await expect(service.sweepAcks()).resolves.toBe(0);
      expect(client.acks).toHaveLength(1);
    });
  });

  it('a transient window read failure fails the item without a decision', async () => {
    const store = new InMemoryHumanRequestFeedStore();
    const service = new HumanRequestDeliveryService(
      {
        store,
        client: new FakeClient(),
        sender: new FakeSender(),
        handoff: { isHumanMode: () => Promise.resolve(false) },
        isWindowOpen: () => Promise.reject(new Error('db')),
      },
      { clock: () => NOW },
    );
    await expect(service.accept(cancelledItem('t1'))).rejects.toThrow('db');
    await expect(store.getDelivery('t1')).resolves.toMatchObject({
      localState: 'RECEIVED',
    });
  });

  describe('held replay fairness', () => {
    it('rows still held are moved behind the others, so every held row is checked', async () => {
      const { service, human, modeChecks } = setup({ batchSize: 2 });
      human.value = true;
      const senders = ['5215550000001', '5215550000002', '5215550000003'];
      for (const [i, senderId] of senders.entries())
        await service.accept({
          ...clarification(`fair${i}`),
          conversationRef: `wa:${senderId}`,
        });
      modeChecks.length = 0;
      await service.replayHeld();
      await service.replayHeld();
      expect(new Set(modeChecks)).toEqual(new Set(senders));
    });
  });

  describe('local DEFERRED_WINDOW replay', () => {
    it('a deferred row the backend does not list is re-delivered on the next inbound', async () => {
      const { service, sender, client, store } = setup();
      sender.script = [new WhatsappSendError(400, '131047', 'Re-engagement')];
      client.ackScript = [new Error('502')]; // the deferral ACK stays PENDING
      await service.accept(clarification('dw1'));
      await expect(store.getDelivery('dw1')).resolves.toMatchObject({
        localState: 'DEFERRED_WINDOW',
        ackState: 'PENDING',
      });
      client.pending = { kind: 'ok', items: [] };
      await service.onCustomerInbound(REF);
      expect(sender.sent).toHaveLength(2);
      await expect(store.getDelivery('dw1')).resolves.toMatchObject({
        localState: 'SENT',
        attemptId: attemptId(2),
        ackState: 'ACKED',
        ackOutcome: 'PROVIDER_ACCEPTED',
      });
    });

    it('a deferred row also listed by the backend is delivered once', async () => {
      const { service, sender, client } = setup();
      sender.script = [new WhatsappSendError(400, '131047', 'Re-engagement')];
      await service.accept(clarification('dw2'));
      client.pending = { kind: 'ok', items: [clarification('dw2')] };
      await service.onCustomerInbound(REF);
      expect(sender.sent).toHaveLength(2);
      expect(
        client.acks.filter((a) => a.body.outcome === 'PROVIDER_ACCEPTED'),
      ).toHaveLength(1);
    });

    it('deferred rows of other conversations are left alone', async () => {
      const { service, sender } = setup();
      sender.script = [new WhatsappSendError(400, '131047', 'Re-engagement')];
      await service.accept(clarification('dw3'));
      await service.onCustomerInbound('wa:5215550009999');
      expect(sender.sent).toHaveLength(1);
    });
  });

  describe('logs', () => {
    it('never print the customer phone (only its last 4 digits)', async () => {
      const { service, client, store } = setup();
      client.pending = new Error('backend down');
      await service.onCustomerInbound(REF);
      client.pending = { kind: 'RATE_LIMITED', retryAfterSeconds: 1 };
      await service.onCustomerInbound(REF);
      jest.spyOn(store, 'listHeld').mockRejectedValueOnce(new Error('db down'));
      await service.onCustomerInbound(REF);
      const calls: unknown[][] = [
        ...(warn.mock.calls as unknown[][]),
        ...(error.mock.calls as unknown[][]),
      ];
      const lines = calls.map((call) => String(call[0]));
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(line).not.toContain(SENDER);
        expect(line).toContain('1111');
      }
    });
  });

  describe('abandon (poison feed item)', () => {
    it('a RECEIVED row becomes STALE / LOCAL_FAILURE, ACK STALE, nothing sent', async () => {
      const { service, store, client, sender } = setup();
      await store.insertDelivery(cancelledItem('z1'));
      await service.abandon(cancelledItem('z1'), 'Error: boom');
      expect(sender.sent).toEqual([]);
      await expect(store.getDelivery('z1')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'LOCAL_FAILURE',
        ackState: 'ACKED',
        ackOutcome: 'STALE',
      });
      expect(client.acks).toEqual([
        {
          deliveryId: 'z1',
          body: {
            outcome: 'STALE',
            attemptId: attemptId(1),
            attemptedAt: NOW.toISOString(),
          },
        },
      ]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('z1'));
    });

    it('with no ledger row (the insert itself fails) it ACKs STALE once, nothing sent', async () => {
      const { service, store, client, sender } = setup();
      await service.abandon(cancelledItem('z2'), 'Error: insert');
      expect(sender.sent).toEqual([]);
      await expect(store.getDelivery('z2')).resolves.toBeNull();
      expect(client.acks).toEqual([
        {
          deliveryId: 'z2',
          body: {
            outcome: 'STALE',
            attemptId: attemptId(1),
            attemptedAt: NOW.toISOString(),
          },
        },
      ]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('z2'));
    });

    it('a SENDING row is left to the stuck-send sweep (DELIVERY_UNKNOWN), never resent', async () => {
      const { service, store, client, sender } = setup();
      await store.insertDelivery(cancelledItem('z3'));
      await store.transition(
        'z3',
        { localState: 'RECEIVED', attemptId: null },
        {
          localState: 'SENDING',
          decision: 'CANCEL_NOTICE',
          attemptId: attemptId(9),
          attemptedAt: NOW.toISOString(),
          providerMessageId: null,
          ack: null,
        },
      );
      await service.abandon(cancelledItem('z3'), 'Error: boom');
      expect(sender.sent).toEqual([]);
      expect(client.acks).toEqual([]);
      await expect(store.getDelivery('z3')).resolves.toMatchObject({
        localState: 'SENDING',
        attemptId: attemptId(9),
      });
    });

    it('rejects when the ledger cannot be read (not a poison item: the page stays stuck)', async () => {
      const { service, store, client } = setup();
      jest.spyOn(store, 'getDelivery').mockRejectedValueOnce(new Error('db'));
      await expect(
        service.abandon(cancelledItem('z4'), 'Error: db'),
      ).rejects.toThrow('db');
      expect(client.acks).toEqual([]);
    });
  });
});
