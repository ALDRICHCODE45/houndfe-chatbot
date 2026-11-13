import { Logger } from '@nestjs/common';
import type {
  ConversationEndedItem,
  ConversationReassignedItem,
  ConversationStaffMessageItem,
  ConversationStartedItem,
  DeliveryOutcomeInput,
  RecordDeliveryOutcomeResult,
  RequestAnsweredItem,
  TemplateRequestedItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  DownloadStaffMediaResult,
  SessionAckInput,
  SessionAckResult,
} from '../../chatbot-api/domain/dtos/live-conversation.dto';
import { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import type {
  OutboundMediaFile,
  OutboundTemplate,
} from '../../whatsapp/domain/whatsapp-sender.port';
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

const setup = (
  options: { refuseThrows?: boolean; noRefuse?: boolean } = {},
) => {
  const events: string[] = [];
  const conversation = new InMemoryConversationStore();
  const modeService = new HandoffModeService(conversation);
  /** One entry is consumed after each `getState` read resolves (a mode
   *  change landing right after the read: the TOCTOU the guard closes). */
  const afterGetState: Array<() => Promise<unknown>> = [];
  /** Failures of successive `markGreeted` calls (undefined = succeeds). */
  const greetScript: Array<Error | undefined> = [];
  const refused: string[] = [];
  const mode = {
    getState: async (id: string) => {
      const state = await modeService.getState(id);
      const hook = afterGetState.shift();
      if (hook !== undefined) await hook();
      return state;
    },
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
      const failure = greetScript.shift();
      if (failure !== undefined) return Promise.reject(failure);
      return modeService.markGreeted(id, epoch);
    },
  };

  const downloads: string[] = [];
  const cleanups: string[] = [];
  const downloadScript: DownloadStaffMediaResult[] = [];
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
    downloadStaffMedia: (
      mediaId: string,
    ): Promise<DownloadStaffMediaResult> => {
      events.push(`download:${mediaId}`);
      downloads.push(mediaId);
      const next = downloadScript.shift();
      if (next !== undefined) return Promise.resolve(next);
      return Promise.resolve({
        kind: 'ok',
        filePath: `/tmp/staff-${mediaId}`,
        mimeType: 'image/jpeg',
        filename: 'foto.jpg',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        cleanup: () => {
          events.push(`cleanup:${mediaId}`);
          cleanups.push(mediaId);
          return Promise.resolve();
        },
      });
    },
  };

  const outcomes: Array<{ deliveryId: string; body: DeliveryOutcomeInput }> =
    [];
  const outcomeScript: RecordDeliveryOutcomeResult[] = [];
  const feedClient = {
    recordDeliveryOutcome: (
      deliveryId: string,
      body: DeliveryOutcomeInput,
    ): Promise<RecordDeliveryOutcomeResult> => {
      events.push(`outcome:${body.outcome}`);
      outcomes.push({ deliveryId, body });
      const scripted = outcomeScript.shift();
      if (scripted !== undefined) return Promise.resolve(scripted);
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
  const templates: Array<Record<string, unknown>> = [];
  const mediaSends: Array<Record<string, unknown>> = [];
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
    sendTemplate: (message: OutboundTemplate) => {
      events.push(`template:${String(message.templateName)}`);
      templates.push({ ...message });
      const next = sendScript.shift();
      if (next instanceof Error) return Promise.reject(next);
      wamid += 1;
      return Promise.resolve({ providerMessageId: next ?? `wamid.${wamid}` });
    },
    sendMediaFile: (message: OutboundMediaFile) => {
      events.push(`media:${String(message.mimeType)}`);
      mediaSends.push({ ...message });
      const next = sendScript.shift();
      if (next instanceof Error) return Promise.reject(next);
      wamid += 1;
      return Promise.resolve({
        providerMessageId: next ?? `wamid.${wamid}`,
        providerMediaId: 'media.1',
      });
    },
  };

  const window = {
    open: true,
    fail: false,
    /** Runs on every window read, before it answers (a mode change landing
     *  between the planning reads and the send). */
    hook: undefined as undefined | (() => Promise<unknown>),
  };
  let style: CustomerStyle | null = null;
  const isWindowOpen = async () => {
    if (window.hook !== undefined) await window.hook();
    if (window.fail) throw new Error('window read failed');
    return window.open;
  };
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
        sender,
        isWindowOpen,
        customerStyle,
        ...(options.noRefuse === true
          ? {}
          : {
              onAckRefused: (ref: string) => {
                events.push('ack-refused');
                refused.push(ref);
                if (options.refuseThrows === true)
                  throw new Error('reconcile exploded');
              },
            }),
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
    templates,
    mediaSends,
    downloads,
    cleanups,
    downloadScript,
    outcomeScript,
    sendScript,
    acks,
    modeAtAck,
    ackScript,
    outcomes,
    window,
    afterGetState,
    greetScript,
    refused,
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

const staffText = (
  deliveryId: string,
  payload: Partial<{
    handoffEpoch: number;
    seq: number;
    messageId: string;
    text: string;
  }> = {},
): ConversationStaffMessageItem => ({
  ...envelope(deliveryId),
  type: 'conversation.staff_message',
  payload: {
    requestId: `req-${deliveryId}`,
    handoffEpoch: 3,
    seq: 18,
    messageId: `msg-${deliveryId}`,
    type: 'TEXT',
    text: 'Hola, le confirmo su pedido\nSaldo: $1,200 *gracias*',
    ...payload,
  },
});

const staffMedia = (
  deliveryId: string,
  payload: {
    type?: 'IMAGE' | 'DOCUMENT';
    mimeType?: string;
    caption?: string | null;
    mediaId?: string;
    filename?: string;
    handoffEpoch?: number;
  } = {},
): ConversationStaffMessageItem => ({
  ...envelope(deliveryId),
  type: 'conversation.staff_message',
  payload: {
    requestId: `req-${deliveryId}`,
    handoffEpoch: payload.handoffEpoch ?? 3,
    seq: 20,
    messageId: `msg-${deliveryId}`,
    type: payload.type ?? 'IMAGE',
    mediaId: payload.mediaId ?? `media-${deliveryId}`,
    mimeType: payload.mimeType ?? 'image/jpeg',
    filename: payload.filename ?? 'foto.jpg',
    caption: payload.caption === undefined ? 'Su pedido' : payload.caption,
  },
});

const templateRequested = (
  deliveryId: string,
  payload: Partial<{
    handoffEpoch: number;
    messageId: string;
    languageCode: string;
    templateName: string;
  }> = {},
): TemplateRequestedItem => ({
  ...envelope(deliveryId),
  type: 'template.requested',
  payload: {
    requestId: `req-${deliveryId}`,
    handoffEpoch: 3,
    seq: 19,
    messageId: `msg-${deliveryId}`,
    templateName: 'seguimiento_pedido',
    languageCode: 'es_MX',
    ...payload,
  },
});

/** Mutes the conversation on epoch 3 the way a handled `started` does. */
const muted = async (h: Harness, epoch = 3) => {
  await h.mode.applyStarted(SENDER, epoch, 'req-live');
};

const downloaded = (
  h: Harness,
  patch: { mimeType?: string; filename?: string } = {},
): void => {
  h.downloadScript.push({
    kind: 'ok',
    filePath: '/tmp/staff-file',
    mimeType: patch.mimeType ?? 'image/jpeg',
    filename: patch.filename ?? 'servidor.bin',
    sizeBytes: 10,
    sha256: 'b'.repeat(64),
    cleanup: () => {
      h.events.push('cleanup:file');
      h.cleanups.push('file');
      return Promise.resolve();
    },
  });
};

const sendError = (
  status: number | null,
  code: string | number | null = null,
  stage: 'send' | 'upload' = 'send',
) => new WhatsappSendError(status, code, 'meta said no', stage);

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

  describe('conversation.staff_message (T5)', () => {
    it('relays the text verbatim as STAFF while HUMAN on the same epoch and reports the wamid', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push('wamid.STAFF1');
      const item = staffText('s1');
      await h.service.accept(item);
      expect(h.sent).toEqual([
        {
          to: SENDER,
          text: 'Hola, le confirmo su pedido\nSaldo: $1,200 *gracias*',
          origin: 'STAFF',
        },
      ]);
      expect(lastOutcome(h)).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.STAFF1',
      });
      await expect(row(h, 's1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'STAFF_MESSAGE',
        providerMessageId: 'wamid.STAFF1',
        ackState: 'ACKED',
      });
    });

    it('never mirrors: nothing but the STAFF-origin send happens and no notice is added', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(staffText('s2'));
      expect(h.events.filter((e) => e.startsWith('send:'))).toHaveLength(1);
      expect(h.sent.every((m) => m.origin === 'STAFF')).toBe(true);
      expect(h.acks).toEqual([]);
    });

    it('does not read the 24 h window locally: Meta is the source of truth', async () => {
      const h = setup();
      await muted(h);
      h.window.fail = true;
      await h.service.accept(staffText('s3'));
      expect(h.sent).toHaveLength(1);
    });

    it.each([
      ['an older item epoch', 2, 3],
      ['a newer item epoch (never muted for it)', 5, 3],
    ])('%s is STALE, nothing is sent', async (_name, itemEpoch, ours) => {
      const h = setup();
      await muted(h, ours);
      await h.service.accept(staffText('s4', { handoffEpoch: itemEpoch }));
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 's4')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'STALE_EPOCH',
      });
    });

    it('same epoch but already BOT again is STALE (session over)', async () => {
      const h = setup();
      await muted(h);
      await h.mode.applyEnded(SENDER, 3);
      await h.service.accept(staffText('s5'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 's5')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_NOT_ACTIVE',
      });
    });

    it('never started at all (epoch 0, BOT) is STALE', async () => {
      const h = setup();
      await h.service.accept(staffText('s6'));
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
    });

    it('rule 10: muted on that epoch, no outcome is ever the STALE of an epoch/session mismatch', async () => {
      const failures: Array<[string, Error | string]> = [
        ['ok', 'wamid.R10'],
        ['closed', sendError(400, 131047)],
        ['uncertain', sendError(null)],
        ['refused', sendError(400, 100)],
        ['plain', new Error('boom')],
      ];
      for (const [name, script] of failures) {
        const h = setup();
        await muted(h);
        h.sendScript.push(script);
        await h.service.accept(staffText(`r10-${name}`));
        const stored = await row(h, `r10-${name}`);
        expect(stored?.decision).not.toBe('STALE_EPOCH');
        expect(stored?.decision).not.toBe('SESSION_NOT_ACTIVE');
      }
    });

    it('rule 10: an unreadable handoff state is retried, never ACKed STALE', async () => {
      const h = setup();
      await muted(h);
      jest
        .spyOn(HandoffModeService.prototype, 'getState')
        .mockRejectedValueOnce(new Error('db down'));
      await expect(h.service.accept(staffText('s7'))).rejects.toThrow();
      expect(h.outcomes).toEqual([]);
      await expect(row(h, 's7')).resolves.toMatchObject({
        localState: 'RECEIVED',
      });
      await h.service.accept(staffText('s7'));
      expect(h.sent).toHaveLength(1);
    });

    it('a closed window (131047) is DEFERRED_WINDOW_CLOSED, kept locally, never STALE', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 131047));
      await h.service.accept(staffText('s8'));
      expect(lastOutcome(h)).toMatchObject({
        outcome: 'DEFERRED_WINDOW_CLOSED',
      });
      await expect(row(h, 's8')).resolves.toMatchObject({
        localState: 'DEFERRED_WINDOW',
        decision: 'STAFF_MESSAGE',
      });
    });

    it('a deferred message is resent on the next customer message while the same epoch is HUMAN, with a new attemptId', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 131047), 'wamid.LATE');
      await h.service.accept(staffText('s9'));
      const first = (await row(h, 's9'))!.attemptId;
      await h.service.onCustomerInbound(REF);
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1]).toMatchObject({ origin: 'STAFF' });
      expect(lastOutcome(h)).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.LATE',
      });
      const second = await row(h, 's9');
      expect(second).toMatchObject({ localState: 'SENT' });
      expect(second!.attemptId).not.toBe(first);
    });

    it('a deferred message whose epoch already ended is NOT resent: STALE, and a 409 OUTCOME_ALREADY_RECORDED means "not coming"', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 131047));
      await h.service.accept(staffText('s10'));
      await h.mode.applyEnded(SENDER, 3);
      h.outcomeScript.push({ kind: 'OUTCOME_ALREADY_RECORDED' });
      await h.service.onCustomerInbound(REF);
      expect(h.sent).toHaveLength(1);
      await expect(row(h, 's10')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_NOT_ACTIVE',
        ackState: 'FAILED_PERMANENT',
      });
      // Stops: a further inbound does nothing more.
      const outcomesBefore = h.outcomes.length;
      await h.service.onCustomerInbound(REF);
      expect(h.outcomes).toHaveLength(outcomesBefore);
      expect(h.sent).toHaveLength(1);
    });

    it('a deferred message of an older epoch is not resent under a newer HUMAN epoch', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 131047));
      await h.service.accept(staffText('s11'));
      await h.mode.applyEnded(SENDER, 3);
      await h.mode.applyStarted(SENDER, 4, 'req-next');
      await h.service.onCustomerInbound(REF);
      expect(h.sent).toHaveLength(1);
      await expect(row(h, 's11')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'STALE_EPOCH',
      });
    });

    it.each([
      ['a network error (no status)', () => sendError(null)],
      ['a 5xx', () => sendError(503)],
      ['a timeout (408)', () => sendError(408)],
      ['a non-Meta error', () => new Error('socket hang up')],
    ])(
      'an uncertain send (%s) is DELIVERY_UNKNOWN, never retried',
      async (_n, make) => {
        const h = setup();
        await muted(h);
        h.sendScript.push(make());
        await h.service.accept(staffText('s12'));
        expect(lastOutcome(h)).toMatchObject({ outcome: 'DELIVERY_UNKNOWN' });
        await expect(row(h, 's12')).resolves.toMatchObject({
          localState: 'UNKNOWN',
        });
        await h.service.onCustomerInbound(REF);
        expect(h.sent).toHaveLength(1);
      },
    );

    it.each([
      ['400 with a Graph code', () => sendError(400, 131009)],
      ['a 429 throttle', () => sendError(429, 130429)],
      ['a 401', () => sendError(401, 190)],
    ])(
      'Meta refusing synchronously (%s) is STALE / SEND_REFUSED',
      async (_n, make) => {
        const h = setup();
        await muted(h);
        h.sendScript.push(make());
        await h.service.accept(staffText('s13'));
        expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
        await expect(row(h, 's13')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'SEND_REFUSED',
        });
      },
    );

    describe('dedupe by messageId', () => {
      it('a second delivery of the same messageId (first insert) is never sent: STALE / DUPLICATE', async () => {
        const h = setup();
        await muted(h);
        await h.service.accept(staffText('d1', { messageId: 'msg-same' }));
        await h.service.accept(staffText('d2', { messageId: 'msg-same' }));
        expect(h.sent).toHaveLength(1);
        expect(h.outcomes.map((o) => o.deliveryId)).toEqual(['d1', 'd2']);
        expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
        await expect(row(h, 'd2')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'DUPLICATE',
          messageId: null,
        });
      });

      it('a duplicate row found again on replay (messageId null on a row that has one) is never sent', async () => {
        const h = setup();
        await muted(h);
        await h.store.insertDelivery(
          staffText('d3', { messageId: 'msg-owner' }),
        );
        const dup = staffText('d4', { messageId: 'msg-owner' });
        const inserted = await h.store.insertDelivery(dup);
        expect(inserted.duplicateOf).toBe('d3');
        // The consumer re-reads the page after a crash: only the replay sees it.
        await h.service.accept(dup);
        expect(h.sent).toEqual([]);
        await expect(row(h, 'd4')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'DUPLICATE',
        });
      });

      it('the duplicate is not sent even when the conversation is HUMAN on its epoch', async () => {
        const h = setup();
        await muted(h);
        await h.service.accept(staffText('d5', { messageId: 'm5' }));
        h.sendScript.push('wamid.NEVER');
        await h.service.accept(staffText('d6', { messageId: 'm5' }));
        expect(h.sendScript).toEqual(['wamid.NEVER']);
      });

      it('the same deliveryId accepted twice is sent once', async () => {
        const h = setup();
        await muted(h);
        await h.service.accept(staffText('d7'));
        await h.service.accept(staffText('d7'));
        expect(h.sent).toHaveLength(1);
        expect(h.outcomes).toHaveLength(1);
      });
    });

    describe('media', () => {
      it.each([
        ['IMAGE', 'image/jpeg', 'foto.jpg'],
        ['IMAGE', 'image/png', 'foto.png'],
        ['DOCUMENT', 'application/pdf', 'cotizacion.pdf'],
      ] as const)(
        '%s %s: downloads by mediaId, uploads from disk with the caption and cleans up',
        async (type, mimeType, filename) => {
          const h = setup();
          await muted(h);
          downloaded(h, { mimeType });
          h.sendScript.push('wamid.MEDIA');
          await h.service.accept(
            staffMedia('m1', {
              type,
              mimeType,
              filename,
              mediaId: 'media-abc',
              caption: 'Su pedido',
            }),
          );
          expect(h.downloads).toEqual(['media-abc']);
          expect(h.mediaSends).toEqual([
            {
              to: SENDER,
              filePath: '/tmp/staff-file',
              mimeType,
              filename,
              caption: 'Su pedido',
              origin: 'STAFF',
            },
          ]);
          expect(h.sent).toEqual([]);
          expect(h.cleanups).toEqual(['file']);
          expect(h.events.indexOf('cleanup:file')).toBeGreaterThan(
            h.events.indexOf(`media:${mimeType}`),
          );
          expect(lastOutcome(h)).toMatchObject({
            outcome: 'PROVIDER_ACCEPTED',
            providerMessageId: 'wamid.MEDIA',
          });
        },
      );

      it('a null caption sends no caption at all', async () => {
        const h = setup();
        await muted(h);
        downloaded(h);
        await h.service.accept(staffMedia('m2', { caption: null }));
        expect(h.mediaSends).toHaveLength(1);
        expect('caption' in h.mediaSends[0]).toBe(false);
      });

      it('image/webp goes as a document (Meta image messages are JPEG/PNG only), never as an image', async () => {
        const h = setup();
        await muted(h);
        downloaded(h, { mimeType: 'image/webp' });
        await h.service.accept(
          staffMedia('m3', {
            type: 'IMAGE',
            mimeType: 'image/webp',
            filename: 'foto.webp',
          }),
        );
        expect(h.mediaSends).toEqual([
          expect.objectContaining({
            mimeType: 'image/webp',
            filename: 'foto.webp',
            asDocument: true,
            origin: 'STAFF',
          }),
        ]);
      });

      it('a DOCUMENT that is not a PDF also goes as a document', async () => {
        const h = setup();
        await muted(h);
        downloaded(h, { mimeType: 'image/png' });
        await h.service.accept(
          staffMedia('m4', { type: 'DOCUMENT', mimeType: 'image/png' }),
        );
        expect(h.mediaSends[0]).toMatchObject({ asDocument: true });
      });

      it('jpeg/png/pdf are not flagged as documents beyond their own type', async () => {
        const h = setup();
        await muted(h);
        downloaded(h);
        await h.service.accept(staffMedia('m5'));
        expect('asDocument' in h.mediaSends[0]).toBe(false);
      });

      it('MEDIA_NOT_FOUND is STALE / MEDIA_NOT_FOUND, nothing is sent', async () => {
        const h = setup();
        await muted(h);
        h.downloadScript.push({ kind: 'MEDIA_NOT_FOUND' });
        await h.service.accept(staffMedia('m6'));
        expect(h.mediaSends).toEqual([]);
        expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
        await expect(row(h, 'm6')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'MEDIA_NOT_FOUND',
        });
      });

      it('a file over the cap is a definite non-send: STALE / SEND_REFUSED', async () => {
        const h = setup();
        await muted(h);
        h.downloadScript.push({ kind: 'MEDIA_TOO_LARGE' });
        await h.service.accept(staffMedia('m7'));
        expect(h.mediaSends).toEqual([]);
        await expect(row(h, 'm7')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'SEND_REFUSED',
        });
      });

      it.each([
        [
          'a transient backend failure',
          {
            kind: 'RETRYABLE',
            cause: 'http_5xx',
            status: 503,
            retryAfterSeconds: null,
          },
        ],
        ['a local disk error', { kind: 'LOCAL_IO_ERROR' }],
        ['a credential problem', { kind: 'UNAUTHORIZED' }],
      ] as const)(
        '%s while downloading is retried (row stays RECEIVED, nothing ACKed)',
        async (_n, result) => {
          const h = setup();
          await muted(h);
          h.downloadScript.push(result);
          await expect(h.service.accept(staffMedia('m8'))).rejects.toThrow();
          expect(h.outcomes).toEqual([]);
          expect(h.mediaSends).toEqual([]);
          await expect(row(h, 'm8')).resolves.toMatchObject({
            localState: 'RECEIVED',
          });
          downloaded(h);
          await h.service.accept(staffMedia('m8'));
          expect(h.mediaSends).toHaveLength(1);
        },
      );

      it('does not download for an item that is STALE by epoch or duplicate', async () => {
        const h = setup();
        await muted(h);
        await h.service.accept(staffMedia('m9', { handoffEpoch: 2 }));
        expect(h.downloads).toEqual([]);
      });

      it.each([
        ['accepted', undefined, 'PROVIDER_ACCEPTED'],
        ['window closed', sendError(400, 131047), 'DEFERRED_WINDOW_CLOSED'],
        ['uncertain', sendError(null), 'DELIVERY_UNKNOWN'],
        ['refused', sendError(400, 131009), 'STALE'],
        ['upload failed', sendError(null, null, 'upload'), 'STALE'],
      ] as const)(
        'the temp file is cleaned up when the send is %s',
        async (_n, script, outcome) => {
          const h = setup();
          await muted(h);
          downloaded(h);
          if (script !== undefined) h.sendScript.push(script);
          await h.service.accept(staffMedia('m10'));
          expect(lastOutcome(h)).toMatchObject({ outcome });
          expect(h.cleanups).toEqual(['file']);
        },
      );

      it('an upload-stage failure (nothing reached the customer) is STALE / SEND_REFUSED, even with a 5xx or no status', async () => {
        for (const status of [null, 503]) {
          const h = setup();
          await muted(h);
          h.sendScript.push(sendError(status, null, 'upload'));
          await h.service.accept(staffMedia('m11'));
          await expect(row(h, 'm11')).resolves.toMatchObject({
            localState: 'STALE',
            decision: 'SEND_REFUSED',
          });
        }
      });

      it('a deferred media message is downloaded again on replay and cleaned up each time', async () => {
        const h = setup();
        await muted(h);
        h.sendScript.push(sendError(400, 131047));
        await h.service.accept(staffMedia('m12'));
        await h.service.onCustomerInbound(REF);
        expect(h.downloads).toHaveLength(2);
        expect(h.cleanups).toHaveLength(2);
        expect(h.mediaSends).toHaveLength(2);
        await expect(row(h, 'm12')).resolves.toMatchObject({
          localState: 'SENT',
        });
      });

      it('a replay under an ended epoch downloads nothing', async () => {
        const h = setup();
        await muted(h);
        h.sendScript.push(sendError(400, 131047));
        await h.service.accept(staffMedia('m13'));
        await h.mode.applyEnded(SENDER, 3);
        await h.service.onCustomerInbound(REF);
        expect(h.downloads).toHaveLength(1);
      });
    });

    it('messages of one conversation go out in the order they are accepted (seq order from the feed)', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(staffText('o1', { seq: 18, text: 'uno' }));
      await h.service.accept(staffText('o2', { seq: 19, text: 'dos' }));
      expect(texts(h)).toEqual(['uno', 'dos']);
    });

    it('never logs the phone or a wamid', async () => {
      const h = setup();
      await muted(h);
      downloaded(h);
      const cases: Array<[Error | string | undefined, string]> = [
        ['wamid.SECRET1', 'l1'],
        [sendError(400, 131047), 'l2'],
        [sendError(null), 'l3'],
        [sendError(400, 131009), 'l4'],
        [sendError(null, null, 'upload'), 'l5'],
      ];
      for (const [script, id] of cases) {
        if (script !== undefined) h.sendScript.push(script);
        downloaded(h);
        await h.service.accept(staffMedia(id));
      }
      await h.service.accept(staffText('l6', { handoffEpoch: 9 }));
      await h.service.onCustomerInbound(REF);
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(line).not.toContain(SENDER);
        expect(line).not.toContain('wamid.SECRET1');
      }
    });
  });

  describe('template.requested (T5)', () => {
    it('sends the approved template as TEMPLATE with no variables and reports the wamid', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push('wamid.TPL1');
      await h.service.accept(templateRequested('t1'));
      expect(h.templates).toEqual([
        {
          to: SENDER,
          templateName: 'seguimiento_pedido',
          languageCode: 'es_MX',
          bodyParameters: [],
          origin: 'TEMPLATE',
        },
      ]);
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.TPL1',
      });
      await expect(row(h, 't1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'TEMPLATE_SENT',
      });
    });

    it('uses the language code of the item', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(templateRequested('t2', { languageCode: 'en' }));
      expect(h.templates[0]).toMatchObject({ languageCode: 'en' });
    });

    it('is sent even when the 24 h window is closed (that is what a template is for)', async () => {
      const h = setup();
      await muted(h);
      h.window.open = false;
      await h.service.accept(templateRequested('t3'));
      expect(h.templates).toHaveLength(1);
    });

    it.each([
      ['an older epoch', 2],
      ['a newer epoch', 4],
    ])('%s is STALE, nothing is sent', async (_n, epoch) => {
      const h = setup();
      await muted(h);
      await h.service.accept(templateRequested('t4', { handoffEpoch: epoch }));
      expect(h.templates).toEqual([]);
      await expect(row(h, 't4')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'STALE_EPOCH',
      });
    });

    it('same epoch but BOT again is STALE / SESSION_NOT_ACTIVE', async () => {
      const h = setup();
      await muted(h);
      await h.mode.applyEnded(SENDER, 3);
      await h.service.accept(templateRequested('t5'));
      expect(h.templates).toEqual([]);
      await expect(row(h, 't5')).resolves.toMatchObject({
        decision: 'SESSION_NOT_ACTIVE',
      });
    });

    it('an uncertain send is DELIVERY_UNKNOWN (never retried)', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(null));
      await h.service.accept(templateRequested('t6'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'DELIVERY_UNKNOWN' });
      await h.service.onCustomerInbound(REF);
      expect(h.templates).toHaveLength(1);
    });

    it('Meta refusing synchronously is STALE / SEND_REFUSED', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 132001));
      await h.service.accept(templateRequested('t7'));
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 't7')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SEND_REFUSED',
      });
    });

    it('is never DEFERRED, not even for 131047 (the backend answers 422 to it)', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 131047));
      await h.service.accept(templateRequested('t8'));
      expect(h.outcomes.map((o) => o.body.outcome)).not.toContain(
        'DEFERRED_WINDOW_CLOSED',
      );
      await expect(row(h, 't8')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SEND_REFUSED',
      });
    });

    it('a duplicate messageId is never sent: STALE / DUPLICATE', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(templateRequested('t9', { messageId: 'same' }));
      await h.service.accept(templateRequested('t10', { messageId: 'same' }));
      expect(h.templates).toHaveLength(1);
      await expect(row(h, 't10')).resolves.toMatchObject({
        decision: 'DUPLICATE',
      });
    });

    it('a retried template (new messageId and deliveryId) after a refusal is a new item and is sent', async () => {
      const h = setup();
      await muted(h);
      h.sendScript.push(sendError(400, 132001));
      await h.service.accept(templateRequested('t11'));
      await h.service.accept(templateRequested('t12'));
      expect(h.templates).toHaveLength(2);
      await expect(row(h, 't12')).resolves.toMatchObject({
        localState: 'SENT',
      });
    });
  });

  // ------------------------------------------------------------- T6

  describe('re-read the mode right before every live send (L10 a)', () => {
    const flipToBot = (h: Harness) => () => h.mode.applyEnded(SENDER, 3);
    const flipToNewer = (h: Harness) => () =>
      h.mode.applyStarted(SENDER, 4, 'req-newer');

    it('greeting: an ended applied after planning cancels it (STALE / SESSION_NOT_ACTIVE), no greeting recorded', async () => {
      const h = setup();
      h.window.hook = flipToBot(h);
      await h.service.accept(started('g1'));
      expect(h.sent).toEqual([]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'STALE' });
      await expect(row(h, 'g1')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_NOT_ACTIVE',
      });
      expect(h.events).not.toContain('greeted');
    });

    it('greeting: a newer epoch applied after planning cancels it (STALE / STALE_EPOCH)', async () => {
      const h = setup();
      h.window.hook = flipToNewer(h);
      await h.service.accept(started('g2'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 'g2')).resolves.toMatchObject({
        decision: 'STALE_EPOCH',
      });
    });

    it('reassignment notice: cancelled when the session ended meanwhile', async () => {
      const h = setup();
      await muted(h);
      h.window.hook = flipToBot(h);
      await h.service.accept(reassigned('g3'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 'g3')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_NOT_ACTIVE',
      });
    });

    it('farewell: a newer session started after planning cancels it, but the ENDED ack and the replay still run', async () => {
      const h = setup();
      await muted(h);
      h.window.hook = flipToNewer(h);
      await h.service.accept(ended('g4'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 'g4')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'STALE_EPOCH',
      });
      expect(h.acks.map((a) => a.state)).toEqual(['ENDED']);
      expect(h.events).toContain('replay:pending');
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 4,
      });
    });

    it('farewell: still BOT on that epoch is sent (the guard expects BOT after an ended)', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(ended('g5'));
      expect(texts(h)).toEqual([FAREWELL]);
    });

    it('resume notice: cancelled when a newer session started after planning', async () => {
      const h = setup();
      await muted(h);
      await h.mode.markGreeted(SENDER, 3);
      h.window.hook = flipToNewer(h);
      await h.service.accept(
        ended('g6', {
          reason: 'START_TIMEOUT',
          farewell: false,
          resumeNotice: true,
        }),
      );
      expect(h.sent).toEqual([]);
      await expect(row(h, 'g6')).resolves.toMatchObject({
        decision: 'STALE_EPOCH',
      });
    });

    it('staff text: an ended landing right after the planning read is never sent', async () => {
      const h = setup();
      await muted(h);
      h.afterGetState.push(flipToBot(h));
      await h.service.accept(staffText('g7'));
      expect(h.sent).toEqual([]);
      await expect(row(h, 'g7')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'SESSION_NOT_ACTIVE',
      });
    });

    it('staff media: the session ending during the download cancels the upload, the file is still cleaned up', async () => {
      const h = setup();
      await muted(h);
      downloaded(h);
      h.afterGetState.push(flipToNewer(h));
      await h.service.accept(staffMedia('g8'));
      expect(h.mediaSends).toEqual([]);
      expect(h.cleanups).toEqual(['file']);
      await expect(row(h, 'g8')).resolves.toMatchObject({
        decision: 'STALE_EPOCH',
      });
    });

    it('template: cancelled when the session ended meanwhile', async () => {
      const h = setup();
      await muted(h);
      h.afterGetState.push(flipToBot(h));
      await h.service.accept(templateRequested('g9'));
      expect(h.templates).toEqual([]);
      await expect(row(h, 'g9')).resolves.toMatchObject({
        decision: 'SESSION_NOT_ACTIVE',
      });
    });

    it('rule 10: a conversation still muted on that epoch is never ACKed STALE by the guard', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(staffText('g10'));
      expect(texts(h)).toHaveLength(1);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'PROVIDER_ACCEPTED' });
    });

    it('an unreadable mode at the guard sends nothing and the item is retried, then sent once', async () => {
      const h = setup();
      await muted(h);
      h.afterGetState.push(
        () => Promise.resolve(),
        () => Promise.reject(new Error('mode read failed')),
      );
      const item = staffText('g11');
      await expect(h.service.accept(item)).rejects.toThrow(/mode read failed/);
      expect(h.sent).toEqual([]);
      expect(h.outcomes).toEqual([]);
      await expect(row(h, 'g11')).resolves.toMatchObject({
        localState: 'RECEIVED',
      });
      await h.service.accept(item);
      expect(texts(h)).toHaveLength(1);
    });
  });

  describe('finishLive never throws (L10 b)', () => {
    it('a replay that rejects is logged and the item stays decided', async () => {
      const h = setup();
      await muted(h);
      jest
        .spyOn(h.service, 'onCustomerInbound')
        .mockRejectedValue(new Error('replay exploded'));
      await expect(h.service.accept(ended('f1'))).resolves.toBeUndefined();
      await expect(row(h, 'f1')).resolves.toMatchObject({
        localState: 'SENT',
        decision: 'FAREWELL',
      });
      expect(logs.some((line) => /replay.*failed/i.test(line))).toBe(true);
      expect(logs.join('\n')).not.toContain(SENDER);
    });
  });

  describe('markGreeted after an accepted greeting (L10 c)', () => {
    it('one failure is retried immediately and the greeting is recorded', async () => {
      const h = setup();
      h.greetScript.push(new Error('db blip'));
      await h.service.accept(started('m1'));
      expect(h.events.filter((e) => e === 'greeted')).toHaveLength(2);
      await expect(handoff(h)).resolves.toMatchObject({ greetedEpoch: 3 });
    });

    it('two failures: logged at error level, the item is not failed, no further retry', async () => {
      const h = setup();
      h.greetScript.push(new Error('db down'), new Error('db down'));
      const error = jest.mocked(Logger.prototype.error);
      error.mockClear();
      await expect(h.service.accept(started('m2'))).resolves.toBeUndefined();
      expect(h.events.filter((e) => e === 'greeted')).toHaveLength(2);
      expect(texts(h)).toEqual([GREETING]);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/greeting.*not recorded/i),
      );
      expect(logs.join('\n')).not.toContain(SENDER);
    });

    it('a greeting that was never accepted is not recorded and not retried', async () => {
      const h = setup();
      h.sendScript.push(new Error('socket hang up'));
      await h.service.accept(started('m3'));
      expect(h.events).not.toContain('greeted');
    });
  });

  describe('a refused session-ack STARTED (L10 d)', () => {
    it('NOT_FOUND: back to BOT at that epoch at once, onAckRefused, no greeting, held rows replayed', async () => {
      const h = setup();
      await muted(h, 2);
      await h.service.accept(clarification('d0'));
      h.ackScript.push({ kind: 'NOT_FOUND' });
      await h.service.accept(started('d1'));
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 3,
      });
      expect(h.refused).toEqual([REF]);
      expect(texts(h)).toEqual([
        'Le comparto la respuesta del equipo:\nSí, lo tenemos en azul.',
      ]);
      expect(lastOutcome(h)).toMatchObject({ outcome: 'PROVIDER_ACCEPTED' });
      await expect(row(h, 'd1')).resolves.toMatchObject({
        decision: 'STALE_EPOCH',
      });
    });

    it('STALE_EPOCH whose body says BOT: back to BOT at the backend epoch', async () => {
      const h = setup();
      h.ackScript.push({
        kind: 'STALE_EPOCH',
        currentEpoch: 4,
        mode: 'BOT',
        sessionState: null,
      });
      await h.service.accept(started('d2'));
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'BOT',
        epoch: 4,
      });
      expect(h.refused).toEqual([REF]);
      expect(h.sent).toEqual([]);
    });

    it('STALE_EPOCH whose body says HUMAN (a newer session): stays HUMAN, reconcile decides, no replay', async () => {
      const h = setup();
      h.ackScript.push({
        kind: 'STALE_EPOCH',
        currentEpoch: 5,
        mode: 'HUMAN',
        sessionState: 'ACTIVE',
      });
      h.events.length = 0;
      await h.service.accept(started('d3'));
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
      expect(h.refused).toEqual([REF]);
      expect(h.events).not.toContain('replay:pending');
    });

    it('SESSION_NOT_ENDING: not proof, stays HUMAN, onAckRefused', async () => {
      const h = setup();
      h.ackScript.push({ kind: 'SESSION_NOT_ENDING' });
      await h.service.accept(started('d4'));
      await expect(handoff(h)).resolves.toMatchObject({
        mode: 'HUMAN',
        epoch: 3,
      });
      expect(h.refused).toEqual([REF]);
    });

    it('a retryable ack failure is not a refusal: no revert, no onAckRefused', async () => {
      const h = setup();
      h.ackScript.push(failure('RETRYABLE'));
      await expect(h.service.accept(started('d5'))).rejects.toThrow();
      expect(h.refused).toEqual([]);
      await expect(handoff(h)).resolves.toMatchObject({ mode: 'HUMAN' });
    });

    it('an onAckRefused that throws never fails the item', async () => {
      const h = setup({ refuseThrows: true });
      h.ackScript.push({ kind: 'NOT_FOUND' });
      await expect(h.service.accept(started('d6'))).resolves.toBeUndefined();
      await expect(handoff(h)).resolves.toMatchObject({ mode: 'BOT' });
    });

    it('without the port the service still reverts when the answer proves it', async () => {
      const h = setup({ noRefuse: true });
      h.ackScript.push({ kind: 'NOT_FOUND' });
      await h.service.accept(started('d7'));
      await expect(handoff(h)).resolves.toMatchObject({ mode: 'BOT' });
    });
  });

  describe('maintenance replays wait for the farewell (rule 6 order)', () => {
    it('a replayHeld tick that lands between the durable BOT and the farewell releases nothing', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(clarification('o1'));
      let during: number | undefined;
      h.window.hook = async () => {
        h.window.hook = undefined;
        during = await h.service.replayHeld();
        expect(h.sent).toEqual([]);
      };
      await h.service.accept(ended('o2'));
      expect(during).toBe(0);
      expect(texts(h)).toEqual([
        FAREWELL,
        'Le comparto la respuesta del equipo:\nSí, lo tenemos en azul.',
      ]);
    });

    it('a customer-inbound replay in that gap releases nothing either', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(clarification('o3'));
      h.window.hook = async () => {
        h.window.hook = undefined;
        await h.service.onCustomerInbound(REF);
        expect(h.sent).toEqual([]);
      };
      await h.service.accept(ended('o4'));
      expect(texts(h)[0]).toBe(FAREWELL);
      expect(texts(h)).toHaveLength(2);
    });

    it('once the ended is decided, the next tick releases the held row (no stuck hold)', async () => {
      const h = setup();
      await muted(h);
      await h.service.accept(clarification('o5'));
      await h.mode.applyEnded(SENDER, 3);
      await expect(h.service.replayHeld()).resolves.toBe(1);
      expect(texts(h)).toHaveLength(1);
    });
  });
});
