import { Inject, Injectable } from '@nestjs/common';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { AgentMessage } from '../../conversation/domain/conversation-store';
import { InboundMessage } from '../domain/inbound-message';
import { WHATSAPP_SENDER } from '../domain/whatsapp-sender.port';
import type { WhatsappSenderPort } from '../domain/whatsapp-sender.port';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';

/**
 * WebhookDispatcherService (agent-aware)
 *
 * For each normalized inbound text message:
 *   1. delegate to AgentRunner.handle({ senderId, text })
 *      (the runner owns idle-check, in-memory history truncation,
 *      cost-guard, and UPSERT-persistence of user + assistant turns).
 *   2. send the assistant reply via WhatsappSenderPort.
 *
 * The dispatcher is now a thin orchestrator: no direct conversation
 * store calls, no reply templating. The agent runner is the single
 * writer for the per-sender transcript.
 *
 * No proactive sends anywhere — outbound traffic only flows inside
 * this inbound-driven path.
 */
@Injectable()
export class WebhookDispatcherService {
  constructor(
    private readonly agentRunner: AgentRunner,
    @Inject(WHATSAPP_SENDER)
    private readonly whatsappSender: WhatsappSenderPort,
  ) {}

  async dispatch(event: WebhookEventDto): Promise<void> {
    const messages = normalizeInboundMessages(event);

    for (const message of messages) {
      const { reply } = await this.agentRunner.handle({
        senderId: message.senderId,
        text: message.text,
      });

      await this.whatsappSender.sendText({
        to: message.senderId,
        text: reply,
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

// Re-export the AgentMessage type for any downstream consumers that
// import this module for convenience. (Pure type-only re-export.)
export type { AgentMessage };