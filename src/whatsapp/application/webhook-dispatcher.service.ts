import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import type { AgentMessage } from '../../conversation/domain/conversation-store';
import { InboundMessage } from '../domain/inbound-message';
import { WHATSAPP_SENDER } from '../domain/whatsapp-sender.port';
import type { WhatsappSenderPort } from '../domain/whatsapp-sender.port';
import { RECENT_OUTBOUND } from '../domain/recent-outbound.store';
import type { RecentOutboundStore } from '../domain/recent-outbound.store';
import { WEBHOOK_DEDUP } from '../domain/webhook-dedup.store';
import type { WebhookDedupStore } from '../domain/webhook-dedup.store';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';

/**
 * WebhookDispatcherService (agent-aware)
 *
 * For each normalized inbound text message:
 *   1. skip echoes of the bot's own outbound messages (RECENT_OUTBOUND)
 *   2. skip re-deliveries of already-processed messages (WEBHOOK_DEDUP)
 *   3. delegate to AgentRunner.handle({ senderId, text })
 *      (the runner owns idle-check, in-memory history truncation,
 *      cost-guard, and UPSERT-persistence of user + assistant turns).
 *   4. send the assistant reply via WhatsappSenderPort.
 *   5. remember the outbound wamid (echo filter) and mark the message
 *      seen (dedup) — only AFTER a successful send, so a failed send
 *      still lets a Meta re-delivery retry it.
 *
 * No proactive sends anywhere — outbound traffic only flows inside
 * this inbound-driven path.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly agentRunner: AgentRunner,
    @Inject(WHATSAPP_SENDER)
    private readonly whatsappSender: WhatsappSenderPort,
    @Inject(WEBHOOK_DEDUP)
    private readonly dedup: WebhookDedupStore,
    @Inject(RECENT_OUTBOUND)
    private readonly recentOutbound: RecentOutboundStore,
  ) {}

  async dispatch(event: WebhookEventDto): Promise<void> {
    const messages = normalizeInboundMessages(event);

    for (const message of messages) {
      // Echo of a message the bot itself sent — never answer ourselves.
      if (this.recentOutbound.isKnown(message.messageId)) {
        this.logger.log(
          `skip echo ${message.messageId} from ${message.senderId}`,
        );
        continue;
      }

      // Meta re-delivery of a message already answered — never answer twice.
      if (await this.dedup.isDuplicate(message.messageId)) {
        this.logger.log(
          `skip duplicate ${message.messageId} from ${message.senderId}`,
        );
        continue;
      }

      this.logger.log(
        `process ${message.messageId} from ${message.senderId} (${message.text.length} chars)`,
      );

      try {
        const { reply } = await this.agentRunner.handle({
          senderId: message.senderId,
          text: message.text,
        });

        const { providerMessageId } = await this.whatsappSender.sendText({
          to: message.senderId,
          text: reply,
        });

        this.recentOutbound.remember(providerMessageId);

        // A dedup-write failure must NOT turn a successful send into a
        // failed webhook delivery (that would force Meta to re-deliver and
        // the customer would get the reply twice).
        try {
          await this.dedup.markSeen(message.messageId);
        } catch (error) {
          this.logger.warn(
            `markSeen failed for ${message.messageId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } catch (error) {
        this.logger.error(
          `failed to process ${message.messageId} from ${message.senderId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
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
