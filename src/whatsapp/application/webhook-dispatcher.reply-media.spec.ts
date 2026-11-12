import { Logger } from '@nestjs/common';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * S3: a reply carrying a product photo sends the image BEFORE the text; an
 * image failure never loses the text reply.
 */
const SENDER = '5215550001111';
const IMAGE = {
  kind: 'image' as const,
  url: 'https://cdn.example.test/products/kong.jpg',
  caption: 'Kong Classic',
};

const textEvent = (body: string): WebhookEventDto => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: 'wamid.in',
                from: SENDER,
                timestamp: '1719000000',
                type: 'text',
                text: { body },
              },
            ],
          },
        },
      ],
    },
  ],
});

function setup(decision: Record<string, unknown>) {
  const order: string[] = [];
  const sender = {
    sendText: jest.fn(async () => {
      order.push('text');
      return { providerMessageId: 'wamid.text' };
    }),
    sendTemplate: jest.fn(),
    sendImage: jest.fn(async () => {
      order.push('image');
      return { providerMessageId: 'wamid.image' };
    }),
  };
  const onSent = jest.fn(() => order.push('onSent'));
  const agent = {
    tryHandle: jest.fn(async () => ({ kind: 'handled', onSent, ...decision })),
  };
  const recentOutbound = { remember: jest.fn(), isKnown: () => false };
  const dedup = {
    claim: jest.fn(async () => 'claim-token'),
    release: jest.fn(async () => undefined),
    purgeBefore: jest.fn(async () => 0),
    markSeen: jest.fn(async () => undefined),
  };
  const service = new WebhookDispatcherService(
    {} as AgentRunner,
    sender,
    dedup,
    recentOutbound,
    { isOpsSender: () => false } as unknown as HumanHandoffService,
    { get: jest.fn(async () => null) } as unknown as ConversationStore,
    {} as ReceiptIngressService,
    agent as unknown as MinimalCatalogAgentService,
  );
  return { service, sender, order, onSent, recentOutbound, dedup };
}

describe('WebhookDispatcherService reply media (S3)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the product photo first, then the text', async () => {
    const h = setup({ reply: 'Encontré el Kong Classic.', media: [IMAGE] });
    await h.service.dispatch(textEvent('busco un kong'));

    expect(h.sender.sendImage).toHaveBeenCalledWith({
      to: SENDER,
      link: IMAGE.url,
      caption: 'Kong Classic',
    });
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Encontré el Kong Classic.',
    });
    expect(h.order).toEqual(['image', 'text', 'onSent']);
    // Both outbound ids are remembered so neither echo is re-processed.
    expect(h.recentOutbound.remember).toHaveBeenCalledWith('wamid.image');
    expect(h.recentOutbound.remember).toHaveBeenCalledWith('wamid.text');
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.in');
  });

  it('still sends the text when the image send fails, with a warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = setup({ reply: 'Encontré el Kong Classic.', media: [IMAGE] });
    h.sender.sendImage.mockRejectedValueOnce(new Error('Media upload error'));

    await h.service.dispatch(textEvent('busco un kong'));

    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Encontré el Kong Classic.',
    });
    expect(h.order).toEqual(['text', 'onSent']);
    expect(h.recentOutbound.remember).not.toHaveBeenCalledWith('wamid.image');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reply image failed'),
    );
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).not.toContain(SENDER);
    expect(logged).toContain('wa:…1111');
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.in');
  });

  it('sends no image when the reply carries none', async () => {
    const h = setup({ reply: 'Hola' });
    await h.service.dispatch(textEvent('hola'));

    expect(h.sender.sendImage).not.toHaveBeenCalled();
    expect(h.order).toEqual(['text', 'onSent']);
  });

  it('sends only the text with a sender that cannot send images', async () => {
    const h = setup({ reply: 'Encontré el Kong Classic.', media: [IMAGE] });
    delete (h.sender as Partial<typeof h.sender>).sendImage;

    await h.service.dispatch(textEvent('busco un kong'));

    expect(h.order).toEqual(['text', 'onSent']);
  });
});
