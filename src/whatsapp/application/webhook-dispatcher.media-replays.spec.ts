import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * S2: a customer sticker, video or location reopens the 24 h window like
 * text does, so it triggers the same fire-and-forget replays (HUMAN →
 * deferred staff messages, BOT → pending deliveries) with no bot reply.
 */
const SENDER = '5215550001111';
const OPS = '5215500000000';

const event = (messages: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages } }] }],
  }) as WebhookEventDto;

const base = (id: string, from = SENDER) => ({
  id,
  from,
  timestamp: '1719000000',
});

const sticker = (id: string, from = SENDER) => ({
  ...base(id, from),
  type: 'sticker',
  sticker: { id: 'media-s', mime_type: 'image/webp' },
});
const video = (id: string, from = SENDER) => ({
  ...base(id, from),
  type: 'video',
  video: { id: 'media-v', mime_type: 'video/mp4' },
});
const location = (id: string, from = SENDER) => ({
  ...base(id, from),
  type: 'location',
  location: { latitude: 19.4, longitude: -99.1 },
});
const audio = (id: string) => ({
  ...base(id),
  type: 'audio',
  audio: { id: 'media-a', mime_type: 'audio/ogg', voice: true },
});

const KINDS = [
  ['sticker', sticker],
  ['video', video],
  ['location', location],
] as const;

function setup(
  options: {
    human?: boolean;
    modeError?: Error;
    inbound?: 'never' | 'reject' | 'throw';
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
    customerStyle: jest.fn(() => ({
      register: 'usted',
      emojis: false,
      tone: 'neutral',
    })),
    tryHandle: jest.fn(() => Promise.resolve({ reply: 'Hola' })),
  };
  const runner = { handle: jest.fn() };
  const handoff = {
    isOpsSender: (id: string) => id === OPS,
    resolveReply: jest.fn(),
  };
  const dedup = {
    claim: jest.fn(() => Promise.resolve<string | null>('claim-token')),
    release: jest.fn(() => Promise.resolve()),
    purgeBefore: jest.fn(() => Promise.resolve(0)),
    markSeen: jest.fn(() => Promise.resolve()),
  };
  const fail = () => {
    if (options.inbound === 'throw') throw new Error('sync boom');
    if (options.inbound === 'reject')
      return Promise.reject(new Error('async boom'));
    if (options.inbound === 'never') return new Promise<void>(() => undefined);
    return Promise.resolve();
  };
  const humanRequests = {
    onCustomerInbound: jest.fn((ref: string) => {
      void ref;
      return fail();
    }),
    onHumanCustomerInbound: jest.fn((ref: string) => {
      void ref;
      return fail();
    }),
  };
  const ingress = { admit: jest.fn() };
  const productImage = { recognize: jest.fn() };
  const handoffMode = {
    isHumanMode: jest.fn(() =>
      options.modeError !== undefined
        ? Promise.reject(options.modeError)
        : Promise.resolve(options.human === true),
    ),
  };
  const service = new WebhookDispatcherService(
    runner as unknown as AgentRunner,
    sender,
    dedup,
    { remember: jest.fn(), isKnown: () => false },
    handoff as unknown as HumanHandoffService,
    {
      get: jest.fn(() => Promise.resolve(null)),
    } as unknown as ConversationStore,
    ingress as unknown as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    productImage as never,
    undefined,
    undefined,
    handoffMode,
    humanRequests,
  );
  return {
    service,
    sender,
    agent,
    runner,
    dedup,
    ingress,
    productImage,
    humanRequests,
    handoffMode,
  };
}

type Harness = ReturnType<typeof setup>;

const expectNoBotReply = (h: Harness) => {
  expect(h.sender.sendText).not.toHaveBeenCalled();
  expect(h.sender.sendImage).not.toHaveBeenCalled();
  expect(h.sender.sendInteractive).not.toHaveBeenCalled();
  expect(h.sender.sendTemplate).not.toHaveBeenCalled();
  expect(h.agent.tryHandle).not.toHaveBeenCalled();
  expect(h.agent.prepareCustomer).not.toHaveBeenCalled();
  expect(h.runner.handle).not.toHaveBeenCalled();
  expect(h.ingress.admit).not.toHaveBeenCalled();
  expect(h.productImage.recognize).not.toHaveBeenCalled();
};

describe('WebhookDispatcherService media inbound replays (S2)', () => {
  it.each(KINDS)(
    'HUMAN: a customer %s replays the deferred staff messages once, with no reply',
    async (_kind, build) => {
      const h = setup({ human: true });
      await h.service.dispatch(event([build('wamid.h1')]));
      expect(h.humanRequests.onHumanCustomerInbound).toHaveBeenCalledTimes(1);
      expect(h.humanRequests.onHumanCustomerInbound).toHaveBeenCalledWith(
        `wa:${SENDER}`,
      );
      expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
      expectNoBotReply(h);
    },
  );

  it.each(KINDS)(
    'BOT: a customer %s replays the pending deliveries once, with no reply',
    async (_kind, build) => {
      const h = setup();
      await h.service.dispatch(event([build('wamid.b1')]));
      expect(h.humanRequests.onCustomerInbound).toHaveBeenCalledTimes(1);
      expect(h.humanRequests.onCustomerInbound).toHaveBeenCalledWith(
        `wa:${SENDER}`,
      );
      expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
      expectNoBotReply(h);
    },
  );

  it.each(KINDS)(
    'a %s keeps the mirror-only dedup behaviour (no claim, no markSeen)',
    async (_kind, build) => {
      for (const human of [true, false]) {
        const h = setup({ human });
        await h.service.dispatch(event([build('wamid.d1')]));
        expect(h.dedup.claim).not.toHaveBeenCalled();
        expect(h.dedup.markSeen).not.toHaveBeenCalled();
      }
    },
  );

  it('each media message of a batch triggers its own replay', async () => {
    const h = setup();
    await h.service.dispatch(
      event([sticker('wamid.m1'), video('wamid.m2'), location('wamid.m3')]),
    );
    expect(h.humanRequests.onCustomerInbound).toHaveBeenCalledTimes(3);
  });

  it.each(KINDS)(
    'a %s from the ops phone triggers no replay (not a customer)',
    async (_kind, build) => {
      const h = setup();
      await h.service.dispatch(event([build('wamid.o1', OPS)]));
      expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
      expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
      expect(h.handoffMode.isHumanMode).not.toHaveBeenCalled();
      expectNoBotReply(h);
    },
  );

  it('an unreadable mode fails closed: no replay, no reply, and the message is not rejected', async () => {
    const h = setup({ modeError: new Error('db down') });
    await expect(
      h.service.dispatch(event([sticker('wamid.e1')])),
    ).resolves.toBeUndefined();
    expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
    expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
    expectNoBotReply(h);
  });

  it.each(['never', 'reject', 'throw'] as const)(
    'a replay hook that %ss never breaks the message',
    async (inbound) => {
      for (const human of [true, false]) {
        const h = setup({ inbound, human });
        await expect(
          h.service.dispatch(event([video('wamid.f1')])),
        ).resolves.toBeUndefined();
        await new Promise((resolve) => setImmediate(resolve));
        expectNoBotReply(h);
      }
    },
  );

  describe('audio (own path, unchanged)', () => {
    it('BOT: a voice note replays the pending deliveries once', async () => {
      const h = setup();
      await h.service.dispatch(event([audio('wamid.a1')]));
      expect(h.humanRequests.onCustomerInbound).toHaveBeenCalledTimes(1);
      expect(h.humanRequests.onHumanCustomerInbound).not.toHaveBeenCalled();
    });

    it('HUMAN: a voice note replays the deferred staff messages once', async () => {
      const h = setup({ human: true });
      await h.service.dispatch(event([audio('wamid.a2')]));
      expect(h.humanRequests.onHumanCustomerInbound).toHaveBeenCalledTimes(1);
      expect(h.humanRequests.onCustomerInbound).not.toHaveBeenCalled();
      expect(h.sender.sendText).not.toHaveBeenCalled();
    });
  });
});
