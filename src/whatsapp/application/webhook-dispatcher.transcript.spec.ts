import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { InboundMessage } from '../domain/inbound-message';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { TranscriptRecorder } from '../../conversation-transcript/application/transcript-recorder';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/** S1: every normalized customer inbound is recorded before the reply. */
const SENDER = '5215550001111';
const OPS = '5215500000000';

const event = (messages: unknown[]): WebhookEventDto =>
  ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages } }] }],
  }) as WebhookEventDto;

const textMessage = (id: string, from = SENDER) => ({
  id,
  from,
  timestamp: '1719000000',
  type: 'text',
  text: { body: 'hola' },
});

function setup(
  options: {
    recordInbound?: (
      message: InboundMessage,
      rawType?: string,
    ) => Promise<void>;
    duplicate?: boolean;
    echo?: boolean;
  } = {},
) {
  const order: string[] = [];
  const recorded: Array<{ message: InboundMessage; rawType?: string }> = [];
  const recorder = {
    recordInbound: jest.fn(
      options.recordInbound ??
        ((message: InboundMessage, rawType?: string) => {
          order.push(`record ${message.messageId}`);
          recorded.push({ message, rawType });
          return Promise.resolve();
        }),
    ),
  };
  const sender = {
    sendText: jest.fn(() => {
      order.push('send');
      return Promise.resolve({ providerMessageId: 'wamid.out' });
    }),
    sendTemplate: jest.fn(),
  };
  const agent = {
    prepareCustomer: jest.fn(() => Promise.resolve()),
    tryHandle: jest.fn(() => {
      order.push('turn');
      return Promise.resolve({ kind: 'handled', reply: 'Hola' });
    }),
  };
  const handoff = {
    isOpsSender: (id: string) => id === OPS,
    resolveReply: jest.fn(() =>
      Promise.resolve({ kind: 'no_pending', reply: 'ref?' }),
    ),
  };
  const service = new WebhookDispatcherService(
    {} as AgentRunner,
    sender,
    {
      claim: jest.fn(() =>
        Promise.resolve(options.duplicate === true ? null : 'claim-token'),
      ),
      release: jest.fn(() => Promise.resolve()),
      purgeBefore: jest.fn(() => Promise.resolve(0)),
      markSeen: jest.fn(() => Promise.resolve()),
    },
    { remember: jest.fn(), isKnown: () => options.echo === true },
    handoff as unknown as HumanHandoffService,
    {
      get: jest.fn(() => Promise.resolve(null)),
    } as unknown as ConversationStore,
    {} as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
    undefined,
    recorder,
  );
  return { service, order, recorded, recorder, sender };
}

describe('WebhookDispatcherService transcript (S1)', () => {
  it('records the customer message before the turn and the reply', async () => {
    const h = setup();
    await h.service.dispatch(event([textMessage('wamid.in-1')]));
    expect(h.order).toEqual(['record wamid.in-1', 'turn', 'send']);
    expect(h.recorded[0].rawType).toBe('text');
    expect(h.recorded[0].message).toMatchObject({
      senderId: SENDER,
      messageId: 'wamid.in-1',
      text: 'hola',
      timestamp: '2024-06-21T20:00:00.000Z',
    });
  });

  it('passes the raw Meta type (legacy template button)', async () => {
    const h = setup();
    await h.service.dispatch(
      event([
        {
          id: 'wamid.btn',
          from: SENDER,
          timestamp: '1719000000',
          type: 'button',
          button: { text: 'Sí' },
        },
      ]),
    );
    expect(h.recorded[0].rawType).toBe('button');
  });

  it('records a re-delivered message too (append is idempotent)', async () => {
    const h = setup({ duplicate: true });
    await h.service.dispatch(event([textMessage('wamid.dup')]));
    expect(h.recorder.recordInbound).toHaveBeenCalledTimes(1);
    expect(h.sender.sendText).not.toHaveBeenCalled();
  });

  it('never records an echo of our own outbound or an ops reply', async () => {
    const echo = setup({ echo: true });
    await echo.service.dispatch(event([textMessage('wamid.echo')]));
    const ops = setup();
    await ops.service.dispatch(event([textMessage('wamid.ops', OPS)]));
    expect(echo.recorder.recordInbound).not.toHaveBeenCalled();
    expect(ops.recorder.recordInbound).not.toHaveBeenCalled();
  });

  it('a failing recorder never blocks the reply', async () => {
    const h = setup({
      recordInbound: () => Promise.reject(new Error('db down')),
    });
    const warn = jest
      .spyOn(h.service['logger'], 'warn')
      .mockImplementation(() => undefined);
    await h.service.dispatch(event([textMessage('wamid.in-2')]));
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Hola',
    });
    expect(String(warn.mock.calls[0][0])).toContain('db down');
  });
});

describe('WebhookDispatcherService transcript DI (S1)', () => {
  it('injects the recorder by its class token, not by an erased type', () => {
    const tokens = Reflect.getMetadata(
      'self:paramtypes',
      WebhookDispatcherService,
    ) as Array<{
      index: number;
      param: unknown;
    }>;
    expect(tokens).toContainEqual({ index: 9, param: TranscriptRecorder });
  });
});
