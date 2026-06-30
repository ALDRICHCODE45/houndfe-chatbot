import { Inject, Injectable } from '@nestjs/common';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
import { InboundMessage } from '../domain/inbound-message';
import { WHATSAPP_SENDER } from '../domain/whatsapp-sender.port';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { WhatsappSenderPort } from '../domain/whatsapp-sender.port';

@Injectable()
export class WebhookDispatcherService {
  constructor(
    @Inject(CONVERSATION_STORE)
    private readonly conversationStore: ConversationStore,
    @Inject(WHATSAPP_SENDER)
    private readonly whatsappSender: WhatsappSenderPort,
  ) {}

  async dispatch(event: WebhookEventDto): Promise<void> {
    const messages = normalizeInboundMessages(event);

    for (const message of messages) {
      const existing = await this.conversationStore.get(message.senderId);
      const data = {
        ...(existing?.data ?? {}),
        lastInboundMessageId: message.messageId,
        lastInboundText: message.text,
      };

      if (existing) {
        await this.conversationStore.update(message.senderId, {
          lastMessageAt: message.timestamp,
          data,
        });
      } else {
        await this.conversationStore.create(message.senderId, {
          lastMessageAt: message.timestamp,
          data,
        });
      }

      await this.whatsappSender.sendText({
        to: message.senderId,
        text: `Echo: ${message.text}`,
      });
    }
  }
}

function normalizeInboundMessages(event: WebhookEventDto): InboundMessage[] {
  const entry = event.entry ?? [];

  return entry.flatMap((item) =>
    (item.changes ?? []).flatMap((change) => {
      const value = change.value;
      const fallbackSenderId = value?.contacts?.[0]?.wa_id;

      return (value?.messages ?? []).flatMap((message) => {
        if (
          message.type !== 'text' ||
          typeof message.text?.body !== 'string' ||
          typeof message.id !== 'string' ||
          typeof message.timestamp !== 'string'
        ) {
          return [];
        }

        const senderId = message.from ?? fallbackSenderId;
        if (typeof senderId !== 'string' || senderId.length === 0) {
          return [];
        }

        return [
          {
            senderId,
            text: message.text.body,
            messageId: message.id,
            timestamp: normalizeTimestamp(message.timestamp),
          },
        ];
      });
    }),
  );
}

function normalizeTimestamp(timestamp: string): string {
  const seconds = Number(timestamp);

  if (!Number.isFinite(seconds)) {
    return timestamp;
  }

  return new Date(seconds * 1000).toISOString();
}
