import { Logger } from '@nestjs/common';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type {
  AskPlan,
  OutOfHoursPolicy,
  ReplyOutcome,
} from '../domain/out-of-hours-policy';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Unit 14 T3 at the dispatcher: the scheduling policy answers a clear ask
 * (offer) and the customer's next message (slot choice) BEFORE the LLM turn,
 * the reply is styled and mode-checked like every talk-to-human reply.
 */
const SENDER = '5215550001111';
const OPS = '5215500000000';

const event = (messages: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages } }] }],
  }) as WebhookEventDto;

const text = (id: string, body: string) => ({
  id,
  from: SENDER,
  timestamp: '1731427200',
  type: 'text',
  text: { body },
});

const OFFER =
  'Ahorita nuestro equipo no está disponible (abrimos mañana a las 9:00 a. m.). ¿Quiere que una persona le atienda en alguno de estos horarios?\n1. mañana a las 9:00 a. m.\nResponda con el número.';

function setup(
  options: {
    human?: boolean;
    plan?: AskPlan | Error;
    reply?: ReplyOutcome | Error;
    withHandleReply?: boolean;
    noTeam?: boolean;
    style?: { register: 'tu' | 'usted'; emojis: boolean; tone: string };
  } = {},
) {
  const sender = {
    sendText: jest.fn(() =>
      Promise.resolve({ providerMessageId: 'wamid.out' }),
    ),
    sendTemplate: jest.fn(),
    sendImage: jest.fn(),
    sendInteractive: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    customerStyle: jest.fn(
      () =>
        options.style ?? { register: 'usted', emojis: false, tone: 'neutral' },
    ),
    tryHandle: jest.fn(() =>
      Promise.resolve({ kind: 'handled', reply: 'respuesta del agente' }),
    ),
  };
  const dedup = {
    claim: jest.fn(() => Promise.resolve<string | null>('claim-token')),
    release: jest.fn(() => Promise.resolve()),
    purgeBefore: jest.fn(() => Promise.resolve(0)),
    markSeen: jest.fn(() => Promise.resolve()),
  };
  const handoff = {
    isOpsSender: (id: string) => id === OPS,
    resolveReply: jest.fn(),
  };
  const store = {
    get: jest.fn(() =>
      Promise.resolve({
        senderId: SENDER,
        lastMessageAt: '2026-01-01T00:00:00.000Z',
        data: {},
      }),
    ),
  };
  const handoffMode = {
    isHumanMode: jest.fn(() => Promise.resolve(options.human === true)),
  };
  const requestTalkToHuman = jest.fn(() =>
    Promise.resolve({
      kind: 'registered' as const,
      requestId: 'r-1',
      merged: false,
      businessHours: null,
    }),
  );
  const planAsk = jest.fn(() =>
    options.plan instanceof Error
      ? Promise.reject(options.plan)
      : Promise.resolve<AskPlan>(options.plan ?? { kind: 'default' }),
  );
  const handleReply = jest.fn(() =>
    options.reply instanceof Error
      ? Promise.reject(options.reply)
      : Promise.resolve<ReplyOutcome>(options.reply ?? { kind: 'pass' }),
  );
  const policy: OutOfHoursPolicy = {
    outOfHoursReply: () => Promise.resolve('texto fijo'),
    planAsk,
    ...(options.withHandleReply === false ? {} : { handleReply }),
  };
  const service = new WebhookDispatcherService(
    { handle: jest.fn() } as unknown as AgentRunner,
    sender,
    dedup,
    { remember: jest.fn(), isKnown: () => false },
    handoff as unknown as HumanHandoffService,
    store as unknown as ConversationStore,
    { admit: jest.fn() } as unknown as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    undefined,
    undefined,
    undefined,
    handoffMode,
    { onCustomerInbound: jest.fn(() => Promise.resolve()) },
    options.noTeam === true ? undefined : { requestTalkToHuman },
    policy,
  );
  return {
    service,
    sender,
    agent,
    dedup,
    handoffMode,
    requestTalkToHuman,
    planAsk,
    handleReply,
  };
}

describe('WebhookDispatcherService scheduling (unit 14 T3)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the ask', () => {
    it('an offer plan is sent as the reply; no create, no LLM', async () => {
      const h = setup({ plan: { kind: 'reply', text: OFFER } });
      await h.service.dispatch(
        event([text('wamid.a1', 'quiero hablar con una persona')]),
      );
      expect(h.planAsk).toHaveBeenCalledWith({
        senderId: SENDER,
        inboundAt: '2024-11-12T16:00:00.000Z',
        triggerWaMessageId: 'wamid.a1',
      });
      expect(h.requestTalkToHuman).not.toHaveBeenCalled();
      expect(h.agent.tryHandle).not.toHaveBeenCalled();
      expect(h.sender.sendText).toHaveBeenCalledWith({
        to: SENDER,
        text: OFFER,
      });
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.a1');
    });

    it('a tú customer gets the offer in tú (day/time pieces untouched)', async () => {
      const h = setup({
        plan: { kind: 'reply', text: OFFER },
        style: { register: 'tu', emojis: false, tone: 'casual' },
      });
      await h.service.dispatch(event([text('wamid.a2', 'quiero un asesor')]));
      const sent = h.sender.sendText.mock.calls[0] as unknown as [
        { text: string },
      ];
      expect(sent[0].text).toContain(
        '¿Quieres que una persona te atienda en alguno de estos horarios?',
      );
      expect(sent[0].text).toContain('Responde con el número.');
      expect(sent[0].text).toContain('1. mañana a las 9:00 a. m.');
    });

    it('HUMAN mid-turn after the offer was stored: the send is dropped, message marked seen', async () => {
      const h = setup({ plan: { kind: 'reply', text: OFFER } });
      h.handoffMode.isHumanMode
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      await h.service.dispatch(event([text('wamid.a3', 'un asesor')]));
      expect(h.sender.sendText).not.toHaveBeenCalled();
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.a3');
    });
  });

  describe('the answer to an offer', () => {
    it('is asked BEFORE the LLM turn and its reply is sent (styled), without the agent', async () => {
      const h = setup({
        reply: {
          kind: 'reply',
          text: 'Listo, quedó agendado para mañana a las 9:00 a. m. A esa hora una persona del equipo le escribe por aquí.',
        },
        style: { register: 'tu', emojis: false, tone: 'casual' },
      });
      await h.service.dispatch(event([text('wamid.r1', '1')]));
      expect(h.handleReply).toHaveBeenCalledWith({
        senderId: SENDER,
        text: '1',
        inboundAt: '2024-11-12T16:00:00.000Z',
        messageId: 'wamid.r1',
      });
      expect(h.agent.tryHandle).not.toHaveBeenCalled();
      const sent = h.sender.sendText.mock.calls[0] as unknown as [
        { text: string },
      ];
      expect(sent[0].text).toContain('te escribe por aquí');
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.r1');
    });

    it('pass: the normal agent turn runs', async () => {
      const h = setup({ reply: { kind: 'pass' } });
      await h.service.dispatch(
        event([text('wamid.r2', 'hola, ¿tienen croquetas?')]),
      );
      expect(h.handleReply).toHaveBeenCalledTimes(1);
      expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
    });

    it('a throwing policy never blocks the message: the agent turn runs', async () => {
      const h = setup({ reply: new Error(`boom ${SENDER}`) });
      await h.service.dispatch(event([text('wamid.r3', 'hola')]));
      expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
    });

    it('works without the team service (the policy is independent)', async () => {
      const h = setup({
        noTeam: true,
        reply: { kind: 'reply', text: 'Listo.' },
      });
      await h.service.dispatch(event([text('wamid.r4', '2')]));
      expect(h.sender.sendText).toHaveBeenCalledWith({
        to: SENDER,
        text: 'Listo.',
      });
    });

    it('a clear talk-to-human ask is handled as an ask, not as an answer', async () => {
      const h = setup({ plan: { kind: 'reply', text: OFFER } });
      await h.service.dispatch(
        event([text('wamid.r5', 'quiero hablar con una persona')]),
      );
      expect(h.handleReply).not.toHaveBeenCalled();
    });

    it('HUMAN mode: the policy is not even asked (nothing is booked or sent)', async () => {
      const h = setup({ human: true, reply: { kind: 'reply', text: 'x' } });
      await h.service.dispatch(event([text('wamid.r6', '1')]));
      expect(h.handleReply).not.toHaveBeenCalled();
      expect(h.planAsk).not.toHaveBeenCalled();
      expect(h.sender.sendText).not.toHaveBeenCalled();
      expect(h.agent.tryHandle).not.toHaveBeenCalled();
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.r6');
    });

    it('the mode is re-checked before the reply: HUMAN after the booking drops the text', async () => {
      const h = setup({ reply: { kind: 'reply', text: 'Listo, agendado.' } });
      h.handoffMode.isHumanMode
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      await h.service.dispatch(event([text('wamid.r7', '1')]));
      expect(h.handleReply).toHaveBeenCalledTimes(1);
      expect(h.sender.sendText).not.toHaveBeenCalled();
      expect(h.agent.tryHandle).not.toHaveBeenCalled();
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.r7');
    });

    it('only plain customer text reaches the policy (media / interactive do not)', async () => {
      const h = setup({ reply: { kind: 'reply', text: 'x' } });
      await h.service.dispatch(
        event([
          {
            id: 'wamid.i1',
            from: SENDER,
            timestamp: '1731427200',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'opt-1', title: '1' },
            },
          },
          {
            id: 'wamid.m1',
            from: SENDER,
            timestamp: '1731427200',
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg' },
          },
        ]),
      );
      expect(h.handleReply).not.toHaveBeenCalled();
    });

    it('a policy without handleReply (older provider) changes nothing', async () => {
      const h = setup({ withHandleReply: false });
      await h.service.dispatch(event([text('wamid.r8', 'hola')]));
      expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
    });
  });
});
