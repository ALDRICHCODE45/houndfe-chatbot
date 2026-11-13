import { Logger } from '@nestjs/common';
import type {
  ConversationEndedItem,
  ConversationReassignedItem,
  ConversationStartedItem,
  DeliveryOutcomeInput,
  RecordDeliveryOutcomeResult,
  RequestAnsweredItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  SessionAckInput,
  SessionAckResult,
} from '../../chatbot-api/domain/dtos/live-conversation.dto';
import { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { WhatsappSendError } from '../../whatsapp/infrastructure/meta-whatsapp.sender';
import { REF } from '../infrastructure/human-request-feed-store.contract';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestDeliveryService } from './human-request-delivery.service';
import { LiveConversationService } from './live-conversation.service';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-12T16:20:00.000Z');
const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'casual' };

const GREETING = 'Le atiende Ana del equipo HoundFe.';
const GREETING_NO_NAME = 'Le atiende una persona del equipo HoundFe.';
const REASSIGNED = 'Ahora le atiende Luis, del equipo HoundFe.';
const REASSIGNED_NO_NAME = 'Ahora le atiende otra persona del equipo HoundFe.';
const FAREWELL =
  'Listo, terminó la atención con el equipo. Si necesita algo más, aquí sigo para ayudarle.';
const FAREWELL_TU =
  'Listo, terminó la atención con el equipo. Si necesitas algo más, aquí sigo para ayudarte.';
const RESUME = 'Seguimos por aquí, ¿en qué le ayudo?';
const RESUME_TU = 'Seguimos por aquí, ¿en qué te ayudo?';

const envelope = (deliveryId: string) => ({
  cursor: `c-${deliveryId}`,
  deliveryId,
  requestId: `req-${deliveryId}`,
  conversationRef: REF as string | null,
  notBefore: null,
  expiresAt: null,
});

const started = (
  deliveryId: string,
  payload: Partial<ConversationStartedItem['payload']> = {},
  patch: Partial<ConversationStartedItem> = {},
): ConversationStartedItem => ({
  ...envelope(deliveryId),
  type: 'conversation.started',
  payload: {
    requestId: `req-${deliveryId}`,
    handoffEpoch: 3,
    staffFirstName: 'Ana',
    whatsappWindowClosesAt: null,
    ...payload,
  },
  ...patch,
});

const reassigned = (
  deliveryId: string,
  payload: Partial<ConversationReassignedItem['payload']> = {},
): ConversationReassignedItem => ({
  ...envelope(deliveryId),
  type: 'conversation.reassigned',
  payload: {
    requestId: `req-${deliveryId}`,
    handoffEpoch: 3,
    staffFirstName: 'Luis',
    ...payload,
  },
});

const ended = (
  deliveryId: string,
  payload: Partial<ConversationEndedItem['payload']> = {},
): ConversationEndedItem => ({
  ...envelope(deliveryId),
  type: 'conversation.ended',
  payload: {
    requestId: `req-${deliveryId}`,
    handoffEpoch: 3,
    reason: 'FINISHED',
    farewell: true,
    resumeNotice: false,
    ...payload,
  },
});

const clarification = (deliveryId: string): RequestAnsweredItem => ({
  ...envelope(deliveryId),
  type: 'request.answered',
  payload: {
    kind: 'CLARIFICATION',
    text: 'Sí, lo tenemos en azul.',
    prefix: 'Le comparto la respuesta del equipo:',
  },
});

const okAck = (input: SessionAckInput): SessionAckResult => ({
  kind: 'ok',
  epoch: input.epoch,
  state: input.state,
  sessionState: input.state === 'STARTED' ? 'ACTIVE' : 'ENDED',
});

const setup = () => {
  const events: string[] = [];
  const conversation = new InMemoryConversationStore();
  const modeService = new HandoffModeService(conversation);
  const mode = {
    getState: (id: string) => modeService.getState(id),
    applyStarted: (id: string, epoch: number, requestId: string) => {
      events.push('cas:started');
      return modeService.applyStarted(id, epoch, requestId);
    },
    applyEnded: (id: string, epoch: number) => {
      events.push('cas:ended');
      return modeService.applyEnded(id, epoch);
    },
    markGreeted: (id: string, epoch: number) => {
      events.push('greeted');
      return modeService.markGreeted(id, epoch);
    },
  };

  const acks: SessionAckInput[] = [];
  const modeAtAck: string[] = [];
  const ackScript: Array<SessionAckResult | Error> = [];
  const live = {
    sessionAck: async (
      _ref: string,
      input: SessionAckInput,
    ): Promise<SessionAckResult> => {
      events.push(`ack:${input.state}`);
      acks.push(input);
      const state = await modeService.getState(SENDER);
      modeAtAck.push(`${state.mode}:${state.epoch}`);
      const next = ackScript.shift();
      if (next instanceof Error) throw next;
      return next ?? okAck(input);
    },
  };

  const outcomes: Array<{ deliveryId: string; body: DeliveryOutcomeInput }> =
    [];
  const feedClient = {
    recordDeliveryOutcome: (
      deliveryId: string,
      body: DeliveryOutcomeInput,
    ): Promise<RecordDeliveryOutcomeResult> => {
      events.push(`outcome:${body.outcome}`);
      outcomes.push({ deliveryId, body });
      return Promise.resolve({
        kind: 'ok',
        response: {
          deliveryId,
          outcome: body.outcome,
          attemptId: body.attemptId,
          ackReceivedAt: null,
        },
      });
    },
    listPendingDeliveries: () => {
      events.push('replay:pending');
      return Promise.resolve({ kind: 'ok' as const, items: [] });
    },
  };

  const sent: Array<Record<string, unknown>> = [];
  const sendScript: Array<Error | string> = [];
  let wamid = 0;
  const sender = {
    sendText: (message: { to: string; text: string }) => {
      events.push(`send:${message.text}`);
      sent.push(message);
      const next = sendScript.shift();
      if (next instanceof Error) return Promise.reject(next);
      wamid += 1;
      return Promise.resolve({ providerMessageId: next ?? `wamid.${wamid}` });
    },
  };

  const window = { open: true, fail: false };
  let style: CustomerStyle | null = null;
  const isWindowOpen = () =>
    window.fail
      ? Promise.reject(new Error('window read failed'))
      : Promise.resolve(window.open);
  const customerStyle = () => Promise.resolve(style);
  const store = new InMemoryHumanRequestFeedStore();
  let attempt = 0;
  const service = new HumanRequestDeliveryService(
    {
      store,
      client: feedClient,
      sender,
      handoff: { isHumanMode: (id: string) => modeService.isHumanMode(id) },
      isWindowOpen,
      customerStyle,
      live: new LiveConversationService({
        mode,
        client: live,
        isWindowOpen,
        customerStyle,
      }),
    },
    {
      clock: () => NOW,
      random: () => 1,
      newAttemptId: () => {
        attempt += 1;
        return `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
      },
    },
  );
  return {
    service,
    store,
    events,
    sent,
    sendScript,
    acks,
    modeAtAck,
    ackScript,
    outcomes,
    window,
    mode: modeService,
    setStyle: (next: CustomerStyle | null) => {
      style = next;
    },
  };
};

type Harness = ReturnType<typeof setup>;

const texts = (h: Harness) => h.sent.map((m) => m.text);
const lastOutcome = (h: Harness) => h.outcomes.at(-1)!.body;
const row = (h: Harness, id: string) => h.store.getDelivery(id);
const handoff = (h: Harness) => h.mode.getState(SENDER);

const failure = (kind: string): SessionAckResult =>
  ({
    RETRYABLE: {
      kind: 'RETRYABLE',
      cause: 'http_5xx',
      status: 503,
      retryAfterSeconds: null,
    },
    TIMEOUT: {
      kind: 'RETRYABLE',
      cause: 'timeout',
      status: null,
      retryAfterSeconds: null,
    },
    RATE_LIMITED: { kind: 'RATE_LIMITED', retryAfterSeconds: 2 },
    UNAUTHORIZED: { kind: 'UNAUTHORIZED' },
  })[kind] as SessionAckResult;

describe('LiveConversationService (T4)', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    const record = (message: unknown) => {
      logs.push(String(message));
    };
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(record);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('conversation.started', () => {
    it('CAS to HUMAN first, then session-ack STARTED, and only then the greeting', async () => {
      const h = setup();
      await h.service.accept(started('s1'));
      expect(h.events.slice(0, 5)).toEqual([
        'cas:started',
        'ack:STARTED',
        `send:${GREETING}`,
        'outcome:PROVIDER_ACCEPTED',
        'greeted',
      ]);
      // The mute was already durable when the ack went out.
      expect(h.modeAtAck).toEqual(['HUMAN:3']);
      expect(h.acks).toEqual([{ epoch: 3, state: 'STARTED' }]);
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
        requestId: 'req-s1',
        greetedEpoch: 3,
      });
      expect(lastOutcome(h)).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.1',
      });
      await expect(row(h, 's1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'SESSION_STARTED',
        providerMessageId: 'wamid.1',
        ackState: 'ACKED',
      });
    });

    it('sends the greeting as a BOT message (default origin, mirrored)', async () => {
      const h = setup();
      await h.service.accept(started('s2'));
      expect(h.sent).toEqual([{ to: SENDER, text: GREETING }]);
      expect(h.sent[0]).not.toHaveProperty('origin');
    });

    it.each([
      ['usted with a name', null, 'Ana', GREETING],
      ['usted without a name', null, null, GREETING_NO_NAME],
      ['usted with a blank name', null, '  ', GREETING_NO_NAME],
      ['tú with a name', TU, 'Ana', 'Te atiende Ana del equipo HoundFe.'],
      [
        'tú without a name',
        TU,
        null,
        'Te atiende una persona del equipo HoundFe.',
      ],
    ])('greeting copy: %s', async (_label, style, name, expected) => {
      const h = setup();
      h.setStyle(style);
      await h.service.accept(started('s3', { staffFirstName: name }));
      expect(texts(h)).toEqual([expected]);
    });

    it('never rewrites a staff name that looks like copy', async () => {
      const h = setup();
      h.setStyle(TU);
      await h.service.accept(started('s3b', { staffFirstName: 'Dígame$&' }));
      expect(texts(h)).toEqual(['Te atiende Dígame$& del equipo HoundFe.']);
    });

    it.each([
      ['an older epoch', 2, 'HUMAN'],
      ['the same epoch', 3, 'HUMAN'],
    ])(
      '%s is STALE: no ack, no greeting, state untouched',
      async (_l, epoch) => {
        const h = setup();
        await h.mode.applyStarted(SENDER, 3, 'req-first');
        await h.service.accept(
          started('s4', { handoffEpoch: epoch }, { requestId: 'req-other' }),
        );
        expect(h.acks).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
        await expect(row(h, 's4')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'STALE_EPOCH',
        });
        await expect(handoff(h)).resolves.toMatchObject({
          mode: 'HUMAN',
          epoch: 3,
          requestId: 'req-first',
        });
      },
    );

    it('the same epoch after it ended cannot restart: STALE, no ack', async () => {
      const h = setup();
      await h.mode.applyStarted(SENDER, 3, 'req-first');
      await h.mode.applyEnded(SENDER, 3);
      await h.service.accept(started('s5', {}, { requestId: 'req-other' }));
      expect(h.acks).toEqual([]);
      expect(h.sent).toEqual([]);
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
    });

    it('a newer epoch replaces an older HUMAN one', async () => {
      const h = setup();
      await h.mode.applyStarted(SENDER, 2, 'req-old');
      await h.service.accept(started('s6'));
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
        requestId: 'req-s6',
      });
      expect(texts(h)).toEqual([GREETING]);
    });

    it('a closed window still mutes and acks, but sends no greeting (STALE)', async () => {
      const h = setup();
      h.window.open = false;
      await h.service.accept(started('s7'));
      expect(h.events.slice(0, 2)).toEqual(['cas:started', 'ack:STARTED']);
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 's7')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_STARTED',
      });
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
      await expect(handoff(h)).resolves.not.toHaveProperty('greetedEpoch');
    });

    it('ack 409 STALE_EPOCH: no greeting, STALE, no retry of the ack', async () => {
      const h = setup();
      h.ackScript.push({
        kind: 'STALE_EPOCH',
        currentEpoch: 4,
        mode: 'BOT',
        sessionState: null,
      });
      await h.service.accept(started('s8'));
      expect(h.acks).toHaveLength(1);
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 's8')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'STALE_EPOCH',
      });
      await expect(handoff(h)).resolves.not.toHaveProperty('greetedEpoch');
    });

    it('ack 404 NOT_FOUND: no greeting, STALE', async () => {
      const h = setup();
      h.ackScript.push({ kind: 'NOT_FOUND' });
      await h.service.accept(started('s9'));
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
    });

    it.each(['RETRYABLE', 'TIMEOUT', 'RATE_LIMITED', 'UNAUTHORIZED'])(
      'ack failure %s: no greeting, no outcome ACK, the item is retried and then completes once',
      async (kind) => {
        const h = setup();
        h.ackScript.push(failure(kind));
        const item = started('s10');
        await expect(h.service.accept(item)).rejects.toThrow(/session-ack/);
        expect(h.sent).toEqual([]);
        expect(h.outcomes).toEqual([]);
        await expect(row(h, 's10')).resolves.toMatchObject({
          localState: 'RECEIVED',
        });
        // Already muted, as the contract requires.
        await expect(handoff(h)).resolves.toMatchObject({
          mode: 'HUMAN',
          epoch: 3,
        });

        await h.service.accept(item);
        expect(h.acks).toHaveLength(2);
        expect(texts(h)).toEqual([GREETING]);
        expect(lastOutcome(h)).toMatchObject({ outcome: 'PROVIDER_ACCEPTED' });
        await expect(handoff(h)).resolves.toMatchObject({ greetedEpoch: 3 });
      },
    );

    it('an ack that throws is retried like a retryable failure', async () => {
      const h = setup();
      h.ackScript.push(new Error('socket hang up'));
      await expect(h.service.accept(started('s11'))).rejects.toThrow();
      expect(h.sent).toEqual([]);
      await h.service.accept(started('s11'));
      expect(texts(h)).toEqual([GREETING]);
    });

    it('a window read that fails after the ack is retried, greeting still once', async () => {
      const h = setup();
      h.window.fail = true;
      await expect(h.service.accept(started('s12'))).rejects.toThrow(/window/);
      expect(h.sent).toEqual([]);
      h.window.fail = false;
      await h.service.accept(started('s12'));
      expect(texts(h)).toEqual([GREETING]);
      expect(h.acks).toHaveLength(2);
    });

    it('an uncertain send is DELIVERY_UNKNOWN and no greeting is recorded', async () => {
      const h = setup();
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(started('s13'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'DELIVERY_UNKNOWN' });
      await expect(row(h, 's13')).resolves.toMatchObject({
        localState: 'UNKNOWN',
        decision: 'SESSION_STARTED',
      });
      expect(h.events).not.toContain('greeted');
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
      await expect(handoff(h)).resolves.not.toHaveProperty('greetedEpoch');
    });

    it('Meta saying the window closed at send time is STALE, never a deferral', async () => {
      const h = setup();
      h.sendScript.push(new WhatsappSendError(400, 131047, 'Re-engagement'));
      await h.service.accept(started('s14'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 's14')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'WINDOW_CLOSED',
      });
      expect(h.events).not.toContain('greeted');
    });

    it('a replayed deliveryId is neither acked nor greeted twice', async () => {
      const h = setup();
      await h.service.accept(started('s15'));
      await h.service.accept(started('s15'));
      expect(h.acks).toHaveLength(1);
      expect(h.sent).toHaveLength(1);
      expect(h.outcomes).toHaveLength(1);
    });

    it('a conversationRef that is not a WhatsApp ref: STALE, nothing muted', async () => {
      const h = setup();
      await h.service.accept(
        started('s16', {}, { conversationRef: 'telegram:1' }),
      );
      expect(h.events.filter((e) => e.startsWith('cas'))).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 's16')).resolves.toMatchObject({
        decision: 'NO_CONVERSATION',
      });
    });

    it('logs carry neither the phone nor a wamid', async () => {
      const h = setup();
      h.ackScript.push({
        kind: 'STALE_EPOCH',
        currentEpoch: 4,
        mode: 'BOT',
        sessionState: null,
      });
      await h.service.accept(started('s17'));
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(started('s18', { handoffEpoch: 5 }));
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).not.toContain(SENDER);
        expect(line).not.toContain('wamid');
      }
    });
  });

  describe('conversation.reassigned', () => {
    const humanAt = (h: Harness, epoch = 3) =>
      h.mode.applyStarted(SENDER, epoch, 'req-x');

    it('HUMAN at that epoch, window open: sends the notice, no session-ack, state unchanged', async () => {
      const h = setup();
      await humanAt(h);
      await h.service.accept(reassigned('r1'));
      expect(texts(h)).toEqual([REASSIGNED]);
      expect(h.acks).toEqual([]);
      expect(h.events.filter((e) => e.startsWith('cas'))).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.1',
      });
      await expect(row(h, 'r1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'REASSIGNED_NOTICE',
      });
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
      expect(h.sent[0]).not.toHaveProperty('origin');
    });

    it.each([
      ['usted with a name', null, 'Luis', REASSIGNED],
      ['usted without a name', null, null, REASSIGNED_NO_NAME],
      [
        'tú with a name',
        TU,
        'Luis',
        'Ahora te atiende Luis, del equipo HoundFe.',
      ],
      [
        'tú without a name',
        TU,
        null,
        'Ahora te atiende otra persona del equipo HoundFe.',
      ],
    ])('copy: %s', async (_l, style, name, expected) => {
      const h = setup();
      h.setStyle(style);
      await humanAt(h);
      await h.service.accept(reassigned('r2', { staffFirstName: name }));
      expect(texts(h)).toEqual([expected]);
    });

    it.each([
      ['another HUMAN epoch', 'HUMAN', 4, 'STALE_EPOCH'],
      ['an older item epoch', 'HUMAN', 2, 'STALE_EPOCH'],
    ])('%s: STALE, nothing sent', async (_l, _m, epoch, decision) => {
      const h = setup();
      await humanAt(h);
      await h.service.accept(reassigned('r3', { handoffEpoch: epoch }));
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 'r3')).resolves.toMatchObject({ decision });
    });

    it('a conversation already back in BOT at that epoch: STALE (session over)', async () => {
      const h = setup();
      await humanAt(h);
      await h.mode.applyEnded(SENDER, 3);
      await h.service.accept(reassigned('r4'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 'r4')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_NOT_ACTIVE',
      });
    });

    it('a conversation that was never muted: STALE', async () => {
      const h = setup();
      await h.service.accept(reassigned('r5'));
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
    });

    it('window closed: STALE, nothing sent', async () => {
      const h = setup();
      await humanAt(h);
      h.window.open = false;
      await h.service.accept(reassigned('r6'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 'r6')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'WINDOW_CLOSED',
      });
    });

    it('an uncertain send is DELIVERY_UNKNOWN', async () => {
      const h = setup();
      await humanAt(h);
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(reassigned('r7'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'DELIVERY_UNKNOWN' });
    });

    it('a replayed deliveryId sends once', async () => {
      const h = setup();
      await humanAt(h);
      await h.service.accept(reassigned('r8'));
      await h.service.accept(reassigned('r8'));
      expect(h.sent).toHaveLength(1);
    });
  });

  describe('conversation.ended', () => {
    const humanAt = (h: Harness, epoch = 3) =>
      h.mode.applyStarted(SENDER, epoch, 'req-x');

    it('BOT first, then the farewell, then the outcome, then session-ack ENDED, then the replay', async () => {
      const h = setup();
      await humanAt(h);
      h.events.length = 0;
      await h.service.accept(ended('e1'));
      expect(h.events).toEqual([
        'cas:ended',
        `send:${FAREWELL}`,
        'outcome:PROVIDER_ACCEPTED',
        'ack:ENDED',
        'replay:pending',
      ]);
      expect(h.acks).toEqual([
        { epoch: 3, state: 'ENDED', providerMessageId: 'wamid.1' },
      ]);
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      await expect(row(h, 'e1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'FAREWELL',
        ackState: 'ACKED',
      });
      expect(h.sent[0]).not.toHaveProperty('origin');
    });

    it.each(['FINISHED', 'FORCED', 'IDLE_TIMEOUT'] as const)(
      '%s with farewell true sends the farewell',
      async (reason) => {
        const h = setup();
        await humanAt(h);
        await h.service.accept(ended('e2', { reason }));
        expect(texts(h)).toEqual([FAREWELL]);
      },
    );

    it('tú farewell', async () => {
      const h = setup();
      h.setStyle(TU);
      await humanAt(h);
      await h.service.accept(ended('e3'));
      expect(texts(h)).toEqual([FAREWELL_TU]);
    });

    it('farewell false: BOT, nothing sent, STALE, session-ack ENDED, replay', async () => {
      const h = setup();
      await humanAt(h);
      h.events.length = 0;
      await h.service.accept(ended('e4', { farewell: false }));
      expect(h.events).toEqual([
        'cas:ended',
        'outcome:STALE',
        'ack:ENDED',
        'replay:pending',
      ]);
      expect(h.acks).toEqual([{ epoch: 3, state: 'ENDED' }]);
      await expect(row(h, 'e4')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_ENDED',
      });
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
    });

    it('window closed: no farewell (STALE), still BOT, ack and replay', async () => {
      const h = setup();
      await humanAt(h);
      h.window.open = false;
      await h.service.accept(ended('e5'));
      expect(h.sent).toEqual([]);
      expect(h.events).toContain('ack:ENDED');
      expect(h.events).toContain('replay:pending');
      await expect(row(h, 'e5')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_ENDED',
      });
    });

    it('a HUMAN epoch higher than N: STALE, no ack, no replay, nothing changes', async () => {
      const h = setup();
      await humanAt(h, 4);
      h.events.length = 0;
      await h.service.accept(ended('e6'));
      expect(h.events).toEqual(['cas:ended', 'outcome:STALE']);
      await expect(row(h, 'e6')).resolves.toMatchObject({
        decision: 'STALE_EPOCH',
      });
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 4,
      });
    });

    it('an ended for a lower stored epoch (missed started) applies', async () => {
      const h = setup();
      await humanAt(h, 1);
      await h.service.accept(ended('e7'));
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      expect(texts(h)).toEqual([FAREWELL]);
    });

    it('session-ack ENDED 409 is a reconcile signal: logged, not retried, replay still runs', async () => {
      for (const reply of [
        { kind: 'SESSION_NOT_ENDING' as const },
        {
          kind: 'STALE_EPOCH' as const,
          currentEpoch: 4,
          mode: 'HUMAN' as const,
          sessionState: 'STARTING' as const,
        },
      ]) {
        const h = setup();
        await humanAt(h);
        h.ackScript.push(reply);
        await h.service.accept(ended('e8'));
        expect(h.acks).toHaveLength(1);
        expect(h.events).toContain('replay:pending');
        expect(logs.some((line) => /reconcile/i.test(line))).toBe(true);
        await expect(row(h, 'e8')).resolves.toMatchObject({
          localState: 'SENT',
          ackState: 'ACKED',
        });
      }
    });

    it('session-ack ENDED failing (5xx / throw) never blocks the item or the replay', async () => {
      for (const reply of [failure('RETRYABLE'), new Error('socket hang up')]) {
        const h = setup();
        await humanAt(h);
        h.ackScript.push(reply);
        await expect(h.service.accept(ended('e9'))).resolves.toBeUndefined();
        expect(h.acks).toHaveLength(1);
        expect(h.events).toContain('replay:pending');
      }
    });

    it('an uncertain farewell is DELIVERY_UNKNOWN; the ack carries no wamid; replay still runs', async () => {
      const h = setup();
      await humanAt(h);
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(ended('e10'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'DELIVERY_UNKNOWN' });
      expect(h.acks).toEqual([{ epoch: 3, state: 'ENDED' }]);
      expect(h.events).toContain('replay:pending');
    });

    it('the farewell goes out before a held HUMAN_SESSION delivery is replayed', async () => {
      const h = setup();
      await humanAt(h);
      await h.service.accept(clarification('held1'));
      await expect(row(h, 'held1')).resolves.toMatchObject({
        localState: 'HELD_HUMAN',
      });
      expect(h.sent).toEqual([]);
      await h.service.accept(ended('e11'));
      expect(texts(h)).toEqual([
        FAREWELL,
        'Le comparto la respuesta del equipo:\nSí, lo tenemos en azul.',
      ]);
      expect(h.events.indexOf('ack:ENDED')).toBeLessThan(
        h.events.findIndex((e) => e.includes('Sí, lo tenemos')),
      );
    });

    it('a failed window read is retried; the BOT state is already durable and the farewell goes once', async () => {
      const h = setup();
      await humanAt(h);
      h.window.fail = true;
      await expect(h.service.accept(ended('e12'))).rejects.toThrow(/window/);
      expect(h.sent).toEqual([]);
      expect(h.acks).toEqual([]);
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      h.window.fail = false;
      await h.service.accept(ended('e12'));
      expect(texts(h)).toEqual([FAREWELL]);
      expect(h.acks).toHaveLength(1);
    });

    it('a replayed deliveryId sends one farewell and one ack', async () => {
      const h = setup();
      await humanAt(h);
      await h.service.accept(ended('e13'));
      await h.service.accept(ended('e13'));
      expect(h.sent).toHaveLength(1);
      expect(h.acks).toHaveLength(1);
    });

    it('logs carry neither the phone nor a wamid', async () => {
      const h = setup();
      await humanAt(h);
      h.ackScript.push({ kind: 'SESSION_NOT_ENDING' });
      await h.service.accept(ended('e14'));
      for (const line of logs) {
        expect(line).not.toContain(SENDER);
        expect(line).not.toContain('wamid');
      }
    });
  });

  describe('conversation.ended START_TIMEOUT', () => {
    const timeout = (id: string, resumeNotice = true) =>
      ended(id, { reason: 'START_TIMEOUT', farewell: false, resumeNotice });

    it('without a greeting: BOT, nothing sent, STALE, no session-ack, replay runs', async () => {
      const h = setup();
      h.window.open = false;
      await h.service.accept(started('t1')); // muted, no greeting
      h.window.open = true;
      h.events.length = 0;
      await h.service.accept(timeout('t2'));
      expect(h.sent).toEqual([]);
      expect(h.acks).toHaveLength(1); // only the STARTED one
      expect(h.events).toEqual([
        'cas:ended',
        'outcome:STALE',
        'replay:pending',
      ]);
      await expect(row(h, 't2')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_REVERTED',
      });
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
    });

    it('with a greeting that went out and resumeNotice: sends the resume text, no session-ack', async () => {
      const h = setup();
      await h.service.accept(started('t3'));
      h.events.length = 0;
      await h.service.accept(timeout('t4'));
      expect(texts(h)).toEqual([GREETING, RESUME]);
      expect(h.acks).toHaveLength(1);
      expect(h.events).toEqual([
        'cas:ended',
        `send:${RESUME}`,
        'outcome:PROVIDER_ACCEPTED',
        'replay:pending',
      ]);
      await expect(row(h, 't4')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'RESUME_NOTICE',
      });
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      expect(h.sent[1]).not.toHaveProperty('origin');
    });

    it('tú resume copy', async () => {
      const h = setup();
      h.setStyle(TU);
      await h.service.accept(started('t5'));
      await h.service.accept(timeout('t6'));
      expect(texts(h)[1]).toBe(RESUME_TU);
    });

    it('resumeNotice false: nothing sent even after a greeting', async () => {
      const h = setup();
      await h.service.accept(started('t7'));
      await h.service.accept(timeout('t8', false));
      expect(texts(h)).toEqual([GREETING]);
      await expect(row(h, 't8')).resolves.toMatchObject({
        decision: 'SESSION_REVERTED',
      });
    });

    it('an uncertain greeting does not count as a greeting that went out', async () => {
      const h = setup();
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(started('t9'));
      await h.service.accept(timeout('t10'));
      expect(texts(h)).toEqual([GREETING]);
    });

    it('a greeting of another epoch does not count', async () => {
      const h = setup();
      await h.service.accept(started('t11', { handoffEpoch: 2 }));
      await h.service.accept(
        ended('t12', { handoffEpoch: 2, reason: 'FINISHED' }),
      );
      h.window.open = false;
      await h.service.accept(started('t13', { handoffEpoch: 3 })); // no greeting
      h.window.open = true;
      await h.service.accept(timeout('t14'));
      expect(texts(h)).toEqual([GREETING, FAREWELL]);
    });

    it('a closed window sends no resume notice (STALE)', async () => {
      const h = setup();
      await h.service.accept(started('t15'));
      h.window.open = false;
      await h.service.accept(timeout('t16'));
      expect(texts(h)).toEqual([GREETING]);
      await expect(row(h, 't16')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_REVERTED',
      });
    });

    it('a newer HUMAN epoch than N: STALE, nothing changes, no replay', async () => {
      const h = setup();
      await h.mode.applyStarted(SENDER, 4, 'req-new');
      await h.service.accept(timeout('t17'));
      expect(h.sent).toEqual([]);
      expect(h.events).not.toContain('replay:pending');
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 4,
      });
    });

    it('an uncertain resume notice is DELIVERY_UNKNOWN', async () => {
      const h = setup();
      await h.service.accept(started('t18'));
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(timeout('t19'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'DELIVERY_UNKNOWN' });
    });
  });
});
