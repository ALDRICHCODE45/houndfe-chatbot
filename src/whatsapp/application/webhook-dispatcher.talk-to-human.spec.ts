import { Logger } from '@nestjs/common';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { HumanRequestCreateService } from '../../human-requests/application/human-request-create.service';
import {
  TALK_TO_HUMAN_IN_HOURS_REPLY,
  TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
  type OutOfHoursPolicy,
} from '../domain/out-of-hours-policy';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * T8 / S6: a clear "quiero hablar con una persona" creates a TALK_TO_HUMAN
 * request WITHOUT the LLM turn and answers the approved copy. HUMAN mode is
 * still muted by the gate (nothing new happens).
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

type Outcome = Awaited<
  ReturnType<HumanRequestCreateService['requestTalkToHuman']>
>;

function setup(
  options: {
    human?: boolean;
    outcome?: Outcome | Error;
    policy?: OutOfHoursPolicy;
    noTeam?: boolean;
    pendingMarker?: boolean;
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
  const runner = { handle: jest.fn() };
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
        data: options.pendingMarker
          ? {
              pendingHumanRequest: {
                requestId: 'abc123def456',
                ref: 'HF-abc123def456',
                createdAt: 'x',
                customerNotifiedAt: 'x',
              },
            }
          : {},
      }),
    ),
  };
  const handoffMode = {
    isHumanMode: jest.fn(() => Promise.resolve(options.human === true)),
  };
  const outcome: Outcome | Error = options.outcome ?? {
    kind: 'registered',
    requestId: 'r-1',
    merged: false,
    businessHours: null,
  };
  const requestTalkToHuman = jest.fn(() =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome),
  );
  const remember = jest.fn();
  const service = new WebhookDispatcherService(
    runner as unknown as AgentRunner,
    sender,
    dedup,
    { remember, isKnown: () => false },
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
    options.policy,
  );
  return {
    service,
    sender,
    agent,
    dedup,
    requestTalkToHuman,
    handoffMode,
    remember,
  };
}

describe('WebhookDispatcherService talk to a person (T8 / S6)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a clear ask creates the request, answers in hours and never calls the LLM', async () => {
    const h = setup();
    await h.service.dispatch(
      event([text('wamid.t1', 'Quiero hablar con una persona')]),
    );
    expect(h.requestTalkToHuman).toHaveBeenCalledTimes(1);
    expect(h.requestTalkToHuman).toHaveBeenCalledWith({
      senderId: SENDER,
      text: 'Quiero hablar con una persona',
      inboundAt: '2024-11-12T16:00:00.000Z',
      triggerWaMessageId: 'wamid.t1',
    });
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: TALK_TO_HUMAN_IN_HOURS_REPLY,
    });
    expect(h.remember).toHaveBeenCalledWith('wamid.out');
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.t1');
  });

  it('out of hours: the out-of-hours text', async () => {
    const h = setup({
      outcome: {
        kind: 'registered',
        requestId: 'r-1',
        merged: false,
        businessHours: { openNow: false, nextOpenAt: null },
      },
    });
    await h.service.dispatch(event([text('wamid.t2', 'pásame con alguien')]));
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: TALK_TO_HUMAN_OUT_OF_HOURS_REPLY,
    });
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
  });

  it('out of hours goes through an injected OutOfHoursPolicy', async () => {
    const h = setup({
      outcome: {
        kind: 'registered',
        requestId: 'r-1',
        merged: false,
        businessHours: { openNow: false, nextOpenAt: null },
      },
      policy: { outOfHoursReply: () => Promise.resolve('texto de agenda') },
    });
    await h.service.dispatch(event([text('wamid.t3', 'un asesor')]));
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'texto de agenda',
    });
  });

  it('a tú customer gets the curated tú copy', async () => {
    const h = setup({
      style: { register: 'tu', emojis: false, tone: 'casual' },
    });
    await h.service.dispatch(event([text('wamid.t4', 'quiero un asesor')]));
    const sent = h.sender.sendText.mock.calls[0] as unknown as [
      { text: string },
    ];
    expect(sent[0].text).toBe(
      'Con gusto, ya le pedí a una persona del equipo que te atienda. En cuanto alguien esté disponible, te escribe por aquí.',
    );
  });

  it('a repeated ask merges into the same request and is answered again', async () => {
    const h = setup({
      outcome: {
        kind: 'registered',
        requestId: 'r-1',
        merged: true,
        businessHours: null,
      },
    });
    await h.service.dispatch(
      event([
        text('wamid.t5', 'quiero hablar con una persona'),
        text('wamid.t6', 'quiero hablar con una persona'),
      ]),
    );
    expect(h.requestTalkToHuman).toHaveBeenCalledTimes(2);
    expect(h.sender.sendText).toHaveBeenCalledTimes(2);
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
  });

  it('HUMAN mode: nothing new is created or sent (the gate mutes the bot)', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(
      event([text('wamid.t7', 'quiero hablar con una persona')]),
    );
    expect(h.requestTalkToHuman).not.toHaveBeenCalled();
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.t7');
  });

  it('the mode is re-checked before the reply: HUMAN mid-way drops it', async () => {
    const h = setup();
    h.handoffMode.isHumanMode
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await h.service.dispatch(
      event([text('wamid.t8', 'quiero hablar con una persona')]),
    );
    expect(h.requestTalkToHuman).toHaveBeenCalledTimes(1);
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.t8');
  });

  it('wins over the pending-marker canned reply', async () => {
    const h = setup({ pendingMarker: true });
    await h.service.dispatch(
      event([text('wamid.t9', 'quiero hablar con una persona')]),
    );
    expect(h.requestTalkToHuman).toHaveBeenCalledTimes(1);
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: TALK_TO_HUMAN_IN_HOURS_REPLY,
    });
  });

  it.each([
    'para cuántas personas es',
    'quiero factura como persona moral',
    'no quiero hablar con una persona',
    'quiero 2 bolsas de croquetas',
  ])('%j is not a talk-to-human ask: the agent turn runs', async (body) => {
    const h = setup();
    await h.service.dispatch(event([text('wamid.n1', body)]));
    expect(h.requestTalkToHuman).not.toHaveBeenCalled();
    expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
  });

  it('an interactive reply is never matched', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          id: 'wamid.i1',
          from: SENDER,
          timestamp: '1731427200',
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: 'opt-1', title: 'Un asesor' },
          },
        },
      ]),
    );
    expect(h.requestTalkToHuman).not.toHaveBeenCalled();
  });

  it('a failed create falls through to the agent turn (nothing was promised)', async () => {
    const h = setup({
      outcome: { kind: 'failed', reason: 'SUBTYPE_DISABLED' },
    });
    await h.service.dispatch(
      event([text('wamid.f1', 'quiero hablar con una persona')]),
    );
    expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
  });

  it('queued / open limit answer their fixed copy without the LLM', async () => {
    const h = setup({ outcome: { kind: 'queued' } });
    await h.service.dispatch(
      event([text('wamid.q1', 'quiero hablar con una persona')]),
    );
    expect(h.agent.tryHandle).not.toHaveBeenCalled();
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('without the team service (harness) the turn runs as before', async () => {
    const h = setup({ noTeam: true });
    await h.service.dispatch(
      event([text('wamid.h1', 'quiero hablar con una persona')]),
    );
    expect(h.agent.tryHandle).toHaveBeenCalledTimes(1);
  });

  it('a send failure releases the claim and rethrows (Meta redelivers; the create is idempotent by the backend dedupKey)', async () => {
    const h = setup();
    h.sender.sendText.mockRejectedValueOnce(new Error('meta down'));
    await expect(
      h.service.dispatch(
        event([text('wamid.e1', 'quiero hablar con una persona')]),
      ),
    ).rejects.toThrow('meta down');
    expect(h.dedup.release).toHaveBeenCalledWith('wamid.e1', 'claim-token');
  });

  it('never logs the phone number', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const h = setup();
    await h.service.dispatch(
      event([text('wamid.l1', 'quiero hablar con una persona')]),
    );
    const logged = [...log.mock.calls, ...warn.mock.calls]
      .map((call) => String(call[0]))
      .join('\n');
    expect(logged).not.toContain(SENDER);
  });
});
