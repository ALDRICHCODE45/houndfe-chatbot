import { Logger } from '@nestjs/common';
import type { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type {
  WebhookEventDto,
  WebhookMessageDto,
} from '../presentation/dto/webhook-event.dto';
import {
  WebhookDispatcherService,
  normalizeInboundMessages,
} from './webhook-dispatcher.service';

/**
 * S4: replies with buttons/lists go out as one interactive message (after
 * any photo); a sender without `sendInteractive`, or a failed interactive
 * send, falls back to the same text. Tapped replies are normalized into the
 * text the existing gates understand.
 */
const SENDER = '5215550001111';
const BUTTONS = {
  type: 'buttons' as const,
  buttons: [
    { id: 'order_confirm:ref-1', title: '✅ Confirmar pedido' },
    { id: 'order_change', title: '✏️ Cambiar algo' },
  ],
  prompt: '¿Confirma su pedido?',
};
const IMAGE = {
  kind: 'image' as const,
  url: 'https://cdn.example.test/products/kong.jpg',
  caption: 'Kong Classic',
};

const event = (message: Partial<WebhookMessageDto>): WebhookEventDto => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: '123456789012345' },
            messages: [
              {
                id: 'wamid.in',
                from: SENDER,
                timestamp: '1719000000',
                ...message,
              },
            ],
          },
        },
      ],
    },
  ],
});
const textEvent = (body: string) => event({ type: 'text', text: { body } });

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
    sendInteractive: jest.fn(async () => {
      order.push('interactive');
      return {
        providerMessageId: 'wamid.interactive',
        providerMessageIds: ['wamid.long', 'wamid.interactive'],
      };
    }),
  };
  const onSent = jest.fn(() => order.push('onSent'));
  const agent = {
    tryHandle: jest.fn(async () => ({ kind: 'handled', onSent, ...decision })),
  };
  const recentOutbound = { remember: jest.fn(), isKnown: () => false };
  const dedup = {
    isDuplicate: jest.fn(async () => false),
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
  return { service, sender, agent, order, onSent, recentOutbound, dedup };
}

describe('WebhookDispatcherService interactive replies (S4)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends photo → interactive (text as body) → arms, remembering every id', async () => {
    const h = setup({
      reply: 'Resumen de su pedido: …',
      media: [IMAGE],
      interactive: BUTTONS,
    });
    await h.service.dispatch(textEvent('quiero hacer mi pedido'));

    expect(h.order).toEqual(['image', 'interactive', 'onSent']);
    expect(h.sender.sendText).not.toHaveBeenCalled();
    expect(h.sender.sendInteractive).toHaveBeenCalledWith({
      to: SENDER,
      body: 'Resumen de su pedido: …',
      interactive: { type: 'buttons', buttons: BUTTONS.buttons },
      shortBody: '¿Confirma su pedido?',
    });
    for (const id of ['wamid.image', 'wamid.long', 'wamid.interactive'])
      expect(h.recentOutbound.remember).toHaveBeenCalledWith(id);
    expect(h.dedup.markSeen).toHaveBeenCalledWith('wamid.in');
  });

  it('passes a list with its button text and rows', async () => {
    const list = {
      type: 'list' as const,
      buttonText: 'Ver opciones',
      rows: [
        { id: 'pick_variant:a', title: '10 kg — $219' },
        { id: 'pick_variant:b', title: '20 kg — $389' },
      ],
    };
    const h = setup({ reply: '¿Qué presentación desea?', interactive: list });
    await h.service.dispatch(textEvent('agrégala'));
    expect(h.sender.sendInteractive).toHaveBeenCalledWith({
      to: SENDER,
      body: '¿Qué presentación desea?',
      interactive: list,
    });
  });

  it('falls back to the same plain text when the sender cannot send interactive messages', async () => {
    const h = setup({ reply: 'Resumen de su pedido: …', interactive: BUTTONS });
    delete (h.sender as Partial<typeof h.sender>).sendInteractive;
    await h.service.dispatch(textEvent('quiero hacer mi pedido'));
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Resumen de su pedido: …',
    });
    expect(h.order).toEqual(['text', 'onSent']);
  });

  it('falls back to the same plain text when the interactive send fails, with a warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = setup({ reply: 'Resumen de su pedido: …', interactive: BUTTONS });
    h.sender.sendInteractive.mockRejectedValueOnce(new Error('131009'));
    await h.service.dispatch(textEvent('quiero hacer mi pedido'));
    expect(h.sender.sendText).toHaveBeenCalledWith({
      to: SENDER,
      text: 'Resumen de su pedido: …',
    });
    expect(h.order).toEqual(['text', 'onSent']);
    expect(h.recentOutbound.remember).toHaveBeenCalledWith('wamid.text');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('interactive reply failed'),
    );
  });

  it('a failed fallback text still fails the webhook (Meta re-delivers)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = setup({ reply: 'Resumen', interactive: BUTTONS });
    h.sender.sendInteractive.mockRejectedValueOnce(new Error('down'));
    h.sender.sendText.mockRejectedValueOnce(new Error('down'));
    await expect(h.service.dispatch(textEvent('x'))).rejects.toThrow('down');
    expect(h.onSent).not.toHaveBeenCalled();
    expect(h.dedup.markSeen).not.toHaveBeenCalled();
  });

  it('forwards a tapped button id and its gate text to the agent', async () => {
    const h = setup({ reply: 'Listo' });
    await h.service.dispatch(
      event({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: {
            id: 'order_confirm:ref-1',
            title: '✅ Confirmar pedido',
          },
        },
      }),
    );
    expect(h.agent.tryHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: SENDER,
        text: 'SÍ',
        interactiveReplyId: 'order_confirm:ref-1',
      }),
    );
  });

  it('a plain text turn carries no interactive id', async () => {
    const h = setup({ reply: 'Hola' });
    await h.service.dispatch(textEvent('hola'));
    expect(h.agent.tryHandle.mock.calls[0]).not.toHaveProperty(
      '0.interactiveReplyId',
    );
  });
});

describe('normalizeInboundMessages interactive replies (S4)', () => {
  const one = (message: Partial<WebhookMessageDto>) =>
    normalizeInboundMessages(event(message));

  it.each([
    ['order_confirm:ref-1', '✅ Confirmar pedido', 'SÍ'],
    ['checkout_confirm:ref-2', '✅ Sí, son correctos', 'SÍ'],
    ['order_change', '✏️ Cambiar algo', 'Quiero cambiar algo'],
    ['checkout_change', '✏️ Corregir datos', 'Quiero corregir mis datos'],
    ['something_else', 'Otra cosa', 'Otra cosa'],
  ])('button_reply %s → "%s" text', (id, title, text) => {
    expect(
      one({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id, title } },
      }),
    ).toEqual([
      {
        senderId: SENDER,
        text,
        messageId: 'wamid.in',
        timestamp: new Date(1719000000 * 1000).toISOString(),
        receivingPhoneNumberId: '123456789012345',
        interactiveReplyId: id,
      },
    ]);
  });

  it('list_reply → the row title with its id', () => {
    expect(
      one({
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: 'pick_variant:abc',
            title: '20 kg — $389',
            description: 'Arena',
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        text: '20 kg — $389',
        interactiveReplyId: 'pick_variant:abc',
      }),
    ]);
  });

  it('legacy quick-reply template `button` → its text, no interactive id', () => {
    const [message] = one({
      type: 'button',
      button: { text: 'Sí', payload: 'YES' },
    });
    expect(message).toEqual(
      expect.objectContaining({ senderId: SENDER, text: 'Sí' }),
    );
    expect(message).not.toHaveProperty('interactiveReplyId');
  });

  it.each<[string, Partial<WebhookMessageDto>]>([
    [
      'reply without id',
      {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { title: 'A' } },
      },
    ],
    [
      'unknown interactive type',
      { type: 'interactive', interactive: { type: 'nfm_reply' } },
    ],
    [
      'unknown id without title',
      {
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'x' } },
      },
    ],
    ['empty legacy button', { type: 'button', button: { text: '' } }],
  ])('drops a %s', (_label, message) => {
    expect(one(message)).toEqual([]);
  });
});
