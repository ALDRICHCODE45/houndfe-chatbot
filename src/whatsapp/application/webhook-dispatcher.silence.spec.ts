import { Logger } from '@nestjs/common';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { ProductImageRecognitionService } from '../../product-image/application/product-image-recognition.service';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Live conversation T6, contract rule 2 (total silence while HUMAN): the
 * dispatcher reads the mode at the gate AND again right before every bot
 * send, so a claim that lands between the gate and the send (the TOCTOU of
 * L3) never lets the bot speak. Each path below passes the gate (BOT) and
 * then sees HUMAN at its send.
 */
const SENDER = '5215550001111';
const OPS = '5215500000000';

const event = (messages: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages } }] }],
  }) as WebhookEventDto;

const text = (id: string, from = SENDER) => ({
  id,
  from,
  timestamp: '1719000000',
  type: 'text',
  text: { body: 'hola' },
});
const image = (id: string) => ({
  id,
  from: SENDER,
  timestamp: '1719000000',
  type: 'image',
  image: { id: 'media-1', mime_type: 'image/jpeg' },
});
const pdf = (id: string) => ({
  id,
  from: SENDER,
  timestamp: '1719000000',
  type: 'document',
  document: { id: 'media-2', mime_type: 'application/pdf' },
});
const audio = (id: string) => ({
  id,
  from: SENDER,
  timestamp: '1719000000',
  type: 'audio',
  audio: { id: 'media-a', mime_type: 'audio/ogg; codecs=opus', voice: true },
});

type ModeStep = boolean | Error;

function setup(
  options: {
    /** Successive isHumanMode answers; the last one repeats. */
    modes?: ModeStep[];
    pendingMarker?: boolean;
    opsResolved?: boolean;
    admit?: { kind: string };
    reply?: Record<string, unknown>;
  } = {},
) {
  const order: string[] = [];
  const sender = {
    sendText: jest.fn(() => {
      order.push('send');
      return Promise.resolve({ providerMessageId: 'wamid.out' });
    }),
    sendTemplate: jest.fn(),
    sendImage: jest.fn(() => {
      order.push('image');
      return Promise.resolve({ providerMessageId: 'wamid.img' });
    }),
    sendInteractive: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    customerStyle: jest.fn(() => ({ register: 'usted', emojis: false })),
    tryHandle: jest.fn(() =>
      Promise.resolve({
        kind: 'handled',
        reply: 'Hola',
        ...options.reply,
      }),
    ),
  };
  const runner = {
    handle: jest.fn(() => {
      order.push('runner');
      return Promise.resolve({ reply: 'Retomamos' });
    }),
  };
  const dedup = {
    claim: jest.fn(() => Promise.resolve<string | null>('claim-token')),
    release: jest.fn(() => Promise.resolve()),
    purgeBefore: jest.fn(() => Promise.resolve(0)),
    markSeen: jest.fn((id: string) => {
      order.push(`seen ${id}`);
      return Promise.resolve();
    }),
  };
  const handoff = {
    isOpsSender: (id: string) => id === OPS,
    resolveReply: jest.fn(() =>
      Promise.resolve(
        options.opsResolved
          ? {
              kind: 'resolved',
              customerId: SENDER,
              syntheticUserText: 'agent said yes',
            }
          : { kind: 'no_pending', reply: 'ref?' },
      ),
    ),
  };
  const store = {
    get: jest.fn(() =>
      Promise.resolve({
        senderId: SENDER,
        lastMessageAt: '2026-01-01T00:00:00.000Z',
        data: {
          ...(options.pendingMarker
            ? {
                pendingHumanRequest: {
                  requestId: 'abc123def456',
                  ref: 'HF-abc123def456',
                  createdAt: 'x',
                  customerNotifiedAt: 'x',
                },
              }
            : {}),
        },
      }),
    ),
  };
  const ingress = {
    admit: jest.fn(() =>
      Promise.resolve(options.admit ?? { kind: 'reserved' }),
    ),
  };
  const productImage = {
    recognize: jest.fn(() =>
      Promise.resolve({ kind: 'unavailable', reason: 'error' }),
    ),
  };
  const steps: ModeStep[] = [...(options.modes ?? [false])];
  const handoffMode = {
    isHumanMode: jest.fn((senderId: string) => {
      order.push(`mode ${senderId}`);
      const step = steps.length > 1 ? steps.shift()! : steps[0];
      return step instanceof Error
        ? Promise.reject(step)
        : Promise.resolve(step);
    }),
  };
  const service = new WebhookDispatcherService(
    runner as unknown as AgentRunner,
    sender,
    dedup,
    { remember: jest.fn(), isKnown: () => false },
    handoff as unknown as HumanHandoffService,
    store as unknown as ConversationStore,
    ingress as unknown as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    productImage as unknown as ProductImageRecognitionService,
    { recordInbound: jest.fn(() => Promise.resolve()) },
    undefined,
    handoffMode,
    { onCustomerInbound: jest.fn(() => Promise.resolve()) },
  );
  return {
    service,
    order,
    sender,
    agent,
    runner,
    dedup,
    ingress,
    productImage,
    handoffMode,
  };
}

type Harness = ReturnType<typeof setup>;

const expectDropped = (h: Harness, messageId: string) => {
  expect(h.sender.sendText).not.toHaveBeenCalled();
  expect(h.sender.sendImage).not.toHaveBeenCalled();
  expect(h.sender.sendInteractive).not.toHaveBeenCalled();
  expect(h.dedup.markSeen).toHaveBeenCalledWith(messageId);
};

describe('WebhookDispatcherService silence while HUMAN (T6, rule 2)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('a claim landing between the gate and the send', () => {
    it('pending-marker canned reply: dropped, marked seen', async () => {
      const h = setup({ modes: [false, true], pendingMarker: true });
      await h.service.dispatch(event([text('wamid.p1')]));
      expectDropped(h, 'wamid.p1');
    });

    it('audio prompt (T2): dropped, marked seen', async () => {
      const h = setup({ modes: [false, true] });
      await h.service.dispatch(event([audio('wamid.a1')]));
      expectDropped(h, 'wamid.a1');
    });

    it('receipt guidance: dropped, marked seen (the receipt itself was admitted)', async () => {
      const h = setup({
        modes: [false, true],
        admit: { kind: 'sender-active' },
      });
      await h.service.dispatch(event([pdf('wamid.r1')]));
      expect(h.ingress.admit).toHaveBeenCalledTimes(1);
      expectDropped(h, 'wamid.r1');
    });

    it('product-photo fallback reply: dropped, marked seen', async () => {
      const h = setup({ modes: [false, true] });
      await h.service.dispatch(event([image('wamid.i1')]));
      expectDropped(h, 'wamid.i1');
    });

    it('ops-resolved resume turn: the runner ran but its reply is dropped', async () => {
      const h = setup({ modes: [false, true], opsResolved: true });
      await h.service.dispatch(event([text('wamid.o1', OPS)]));
      expect(h.runner.handle).toHaveBeenCalledTimes(1);
      expectDropped(h, 'wamid.o1');
    });

    it('the reply to the ops phone itself is not a customer send and is never gated', async () => {
      const h = setup({ modes: [true] });
      await h.service.dispatch(event([text('wamid.o2', OPS)]));
      expect(h.sender.sendText).toHaveBeenCalledTimes(1);
      expect(h.handoffMode.isHumanMode).not.toHaveBeenCalled();
    });
  });

  describe('mid-turn replies re-check before EACH send', () => {
    const withImage = { media: [{ url: 'https://cdn.example.com/p.jpg' }] };

    it('BOT throughout: image then text, one mode read before each send', async () => {
      const h = setup({ modes: [false], reply: withImage });
      await h.service.dispatch(event([text('wamid.m1')]));
      expect(h.order).toEqual([
        `mode ${SENDER}`, // gate
        `mode ${SENDER}`, // before the image
        'image',
        `mode ${SENDER}`, // before the text
        'send',
        'seen wamid.m1',
      ]);
    });

    it('HUMAN lands after the photo: the text is dropped', async () => {
      const h = setup({ modes: [false, false, true], reply: withImage });
      await h.service.dispatch(event([text('wamid.m2')]));
      expect(h.sender.sendImage).toHaveBeenCalledTimes(1);
      expect(h.sender.sendText).not.toHaveBeenCalled();
      expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.m2');
    });

    it('HUMAN before the photo: neither is sent', async () => {
      const h = setup({ modes: [false, true], reply: withImage });
      await h.service.dispatch(event([text('wamid.m3')]));
      expectDropped(h, 'wamid.m3');
    });

    it('a reply without media still reads the mode once before the text', async () => {
      const h = setup({ modes: [false] });
      await h.service.dispatch(event([text('wamid.m4')]));
      expect(h.handoffMode.isHumanMode).toHaveBeenCalledTimes(2);
    });
  });

  describe('fails closed', () => {
    it.each([
      ['pending-marker reply', { pendingMarker: true }, text('wamid.f1')],
      ['audio prompt', {}, audio('wamid.f2')],
      ['product-photo fallback', {}, image('wamid.f3')],
    ] as const)(
      '%s: an unreadable mode at the send sends nothing and lets Meta redeliver',
      async (_name, options, message) => {
        const h = setup({
          ...options,
          modes: [false, new Error('db down')],
        });
        await expect(h.service.dispatch(event([message]))).rejects.toThrow(
          'db down',
        );
        expect(h.sender.sendText).not.toHaveBeenCalled();
        expect(h.dedup.markSeen).not.toHaveBeenCalled();
      },
    );
  });

  it('logs carry neither the phone nor a wamid when a reply is dropped', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((line) => void lines.push(String(line)));
    const h = setup({ modes: [false, true], pendingMarker: true });
    await h.service.dispatch(event([text('wamid.l1')]));
    const out = lines.join('\n');
    expect(out).toContain('handoff HUMAN');
    expect(out).not.toContain(SENDER);
    expect(out).not.toContain('wamid.l1');
  });
});
