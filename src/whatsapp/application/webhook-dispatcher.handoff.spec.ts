import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { ProductImageRecognitionService } from '../../product-image/application/product-image-recognition.service';
import type { InboundMessage } from '../domain/inbound-message';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * S7: while the conversation is in HUMAN mode the bot never calls the agent
 * and never speaks; the inbound is only recorded (mirrored) and marked seen.
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
  image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'mi pago' },
});
const document = (id: string) => ({
  id,
  from: SENDER,
  timestamp: '1719000000',
  type: 'document',
  document: { id: 'media-2', mime_type: 'application/pdf' },
});

function setup(
  options: {
    human?: boolean;
    handoffError?: Error;
    pendingMarker?: boolean;
    awaitingPayment?: boolean;
  } = {},
) {
  const order: string[] = [];
  const sender = {
    sendText: jest.fn(() => {
      order.push('send');
      return Promise.resolve({ providerMessageId: 'wamid.out' });
    }),
    sendTemplate: jest.fn(),
    sendImage: jest.fn(),
    sendInteractive: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    customerStyle: jest.fn(() => undefined),
    tryHandle: jest.fn(() => {
      order.push('turn');
      return Promise.resolve({ kind: 'handled', reply: 'Hola' });
    }),
  };
  const runner = { handle: jest.fn() };
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
      Promise.resolve({ kind: 'no_pending', reply: 'ref?' }),
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
          ...(options.awaitingPayment
            ? { minimalCart: { placedSale: { saleId: 's' } } }
            : {}),
        },
      }),
    ),
  };
  const ingress = {
    admit: jest.fn(() => Promise.resolve({ kind: 'reserved' })),
  };
  const productImage = {
    recognize: jest.fn(() =>
      Promise.resolve({ kind: 'unavailable', reason: 'error' }),
    ),
  };
  const recorder = {
    recordInbound: jest.fn((message: InboundMessage) => {
      order.push(`record ${message.messageId}`);
      return Promise.resolve();
    }),
  };
  const handoffMode = {
    isHumanMode: jest.fn((senderId: string) => {
      order.push(`mode ${senderId}`);
      return options.handoffError
        ? Promise.reject(options.handoffError)
        : Promise.resolve(options.human === true);
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
    recorder,
    undefined,
    handoffMode,
  );
  return {
    service,
    order,
    sender,
    agent,
    runner,
    dedup,
    store,
    ingress,
    productImage,
    recorder,
    handoffMode,
  };
}

const expectSilent = (h: ReturnType<typeof setup>) => {
  expect(h.agent.tryHandle).not.toHaveBeenCalled();
  expect(h.runner.handle).not.toHaveBeenCalled();
  expect(h.sender.sendText).not.toHaveBeenCalled();
  expect(h.sender.sendImage).not.toHaveBeenCalled();
  expect(h.sender.sendInteractive).not.toHaveBeenCalled();
  expect(h.sender.sendTemplate).not.toHaveBeenCalled();
};

describe('WebhookDispatcherService handoff gate (S7)', () => {
  it('HUMAN: a text never reaches the agent, sends nothing, is recorded and marked seen', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.h1')]));
    expectSilent(h);
    expect(h.order).toEqual([
      'record wamid.h1',
      `mode ${SENDER}`,
      'seen wamid.h1',
    ]);
  });

  it('HUMAN: an image (even a receipt awaiting payment) gets no bot reply', async () => {
    const h = setup({ human: true, awaitingPayment: true });
    await h.service.dispatch(event([image('wamid.h2')]));
    expectSilent(h);
    expect(h.ingress.admit).not.toHaveBeenCalled();
    expect(h.productImage.recognize).not.toHaveBeenCalled();
    expect(h.recorder.recordInbound).toHaveBeenCalledTimes(1);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.h2');
  });

  it('HUMAN: a PDF document gets no receipt reply', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([document('wamid.h3')]));
    expectSilent(h);
    expect(h.ingress.admit).not.toHaveBeenCalled();
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.h3');
  });

  it('HUMAN wins over the pending-marker canned reply', async () => {
    const h = setup({ human: true, pendingMarker: true });
    await h.service.dispatch(event([text('wamid.h4')]));
    expectSilent(h);
  });

  it('HUMAN: the gate runs before the profile warm-up and state read', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.h5')]));
    expect(h.agent.prepareCustomer).not.toHaveBeenCalled();
    expect(h.store.get).not.toHaveBeenCalled();
  });

  it('BOT: the customer turn runs exactly as before', async () => {
    const h = setup({ human: false });
    await h.service.dispatch(event([text('wamid.b1')]));
    expect(h.order).toEqual([
      'record wamid.b1',
      `mode ${SENDER}`,
      'turn',
      'send',
      'seen wamid.b1',
    ]);
  });

  it('the ops phone is never gated (it is not a customer conversation)', async () => {
    const h = setup({ human: true });
    await h.service.dispatch(event([text('wamid.ops', OPS)]));
    expect(h.handoffMode.isHumanMode).not.toHaveBeenCalled();
    expect(h.sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('fails closed: an unreadable mode sends nothing and lets Meta redeliver', async () => {
    const h = setup({ handoffError: new Error('db down') });
    await expect(
      h.service.dispatch(event([text('wamid.err')])),
    ).rejects.toThrow('db down');
    expectSilent(h);
    expect(h.dedup.markSeen).not.toHaveBeenCalled();
  });
});
