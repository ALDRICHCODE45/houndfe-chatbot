import { ConfigService } from '@nestjs/config';
import {
  CONVERSATION_STORE,
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  SendResult,
  WHATSAPP_SENDER,
  WhatsappSenderPort,
} from '../domain/whatsapp-sender.port';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

describe('WebhookDispatcherService', () => {
  let store: jest.Mocked<ConversationStore>;
  let sender: jest.Mocked<WhatsappSenderPort>;
  let service: WebhookDispatcherService;

  beforeEach(() => {
    store = {
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    sender = {
      sendText: jest.fn<Promise<SendResult>, [Parameters<WhatsappSenderPort['sendText']>[0]]>(),
    };
    sender.sendText.mockResolvedValue({ providerMessageId: 'wamid.reply' });

    service = new WebhookDispatcherService(store, sender);
  });

  it('normalizes inbound text events and sends an echo reply', async () => {
    store.get.mockResolvedValue(null);
    store.create.mockResolvedValue({
      senderId: '5215550001111',
      lastMessageAt: '2024-06-21T20:00:00.000Z',
      data: {},
    });

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '5215550001111' }],
                messages: [
                  {
                    id: 'wamid.inbound',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'hola mundo' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(store.create).toHaveBeenCalledWith('5215550001111', {
      lastMessageAt: '2024-06-21T20:00:00.000Z',
      data: {
        lastInboundMessageId: 'wamid.inbound',
        lastInboundText: 'hola mundo',
      },
    });
    expect(sender.sendText).toHaveBeenCalledWith({
      to: '5215550001111',
      text: 'Echo: hola mundo',
    });
  });

  it('updates existing conversation state using the inbound timestamp', async () => {
    const existing: ConversationState = {
      senderId: '5215550001111',
      lastMessageAt: '2024-06-21T18:00:00.000Z',
      data: {
        previous: true,
      },
    };
    store.get.mockResolvedValue(existing);
    store.update.mockResolvedValue({
      ...existing,
      lastMessageAt: '2024-06-21T20:00:00.000Z',
      data: {
        previous: true,
        lastInboundMessageId: 'wamid.inbound-2',
        lastInboundText: 'seguimos',
      },
    });

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.inbound-2',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'seguimos' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(store.update).toHaveBeenCalledWith('5215550001111', {
      lastMessageAt: '2024-06-21T20:00:00.000Z',
      data: {
        previous: true,
        lastInboundMessageId: 'wamid.inbound-2',
        lastInboundText: 'seguimos',
      },
    });
  });

  it('ignores unsupported webhook payloads without throwing or sending', async () => {
    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: 'wamid.status' }],
              },
            },
          ],
        },
      ],
    };

    await expect(service.dispatch(event)).resolves.toBeUndefined();
    expect(store.get).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});
