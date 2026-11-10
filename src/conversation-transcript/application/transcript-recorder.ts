import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import type { InboundMessage } from '../../whatsapp/domain/inbound-message';
import {
  CONVERSATION_TRANSCRIPT,
  type ConversationTranscriptStore,
  type TranscriptInsertHook,
  type TranscriptMedia,
  type TranscriptMessage,
} from '../domain/transcript.port';

/** DI token the WhatsApp sender records accepted outbound messages through. */
export const OUTBOUND_TRANSCRIPT_RECORDER = Symbol(
  'OUTBOUND_TRANSCRIPT_RECORDER',
);

/** Clock seam; production uses the wall clock. */
export const TRANSCRIPT_CLOCK = Symbol('TRANSCRIPT_CLOCK');

/** One message Meta accepted from the bot, as the sender adapter saw it. */
export interface OutboundTranscriptEntry {
  /** Raw recipient wa_id (before any sandbox rewrite). */
  to: string;
  providerMessageId: string;
  type: string;
  text?: string | null;
  media?: TranscriptMedia | null;
  details?: Record<string, unknown> | null;
}

/** What the sender adapter needs; kept narrow so fakes stay trivial. */
export interface OutboundTranscriptRecorder {
  recordOutbound(entry: OutboundTranscriptEntry): Promise<void>;
}

/**
 * S1 best-effort writer for the durable transcript. Recording never throws:
 * a store failure or an invalid message only warns, so the customer reply
 * is never blocked or broken by the transcript.
 *
 * S1→S2: with the backend outbox, every row actually inserted is enqueued
 * as one MESSAGE_MIRROR in the same transaction, so a mirror is never lost
 * or duplicated; a failed enqueue rolls the row back too, and Meta's
 * re-delivery (inbound) records both again.
 */
@Injectable()
export class TranscriptRecorder implements OutboundTranscriptRecorder {
  private readonly logger = new Logger(TranscriptRecorder.name);
  private readonly now: () => Date;

  constructor(
    @Inject(CONVERSATION_TRANSCRIPT)
    private readonly store: ConversationTranscriptStore,
    @Optional() @Inject(TRANSCRIPT_CLOCK) now?: () => Date,
    // Explicit token: a `Pick<>` type would emit `Object` as DI metadata.
    @Optional()
    @Inject(BackendOutboxService)
    private readonly outbox?: Pick<BackendOutboxService, 'enqueue'>,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** A normalized customer inbound; `rawType` is Meta's `message.type`. */
  async recordInbound(
    message: InboundMessage,
    rawType?: string,
  ): Promise<void> {
    const media = message.media;
    await this.append(message.messageId, (onInserted) =>
      this.store.append(
        {
          senderId: message.senderId,
          waMessageId: message.messageId,
          direction: 'IN',
          author: 'CUSTOMER',
          type: rawType ?? inboundType(message),
          text: message.text,
          media:
            media === undefined
              ? null
              : {
                  providerMediaId: media.providerMediaId,
                  mimeType: media.declaredMimeType,
                  filename: media.filename,
                },
          details:
            message.interactiveReplyId === undefined
              ? null
              : { replyId: message.interactiveReplyId },
          providerTimestamp: message.timestamp,
          observedAt: this.now(),
        },
        onInserted,
      ),
    );
  }

  async recordOutbound(entry: OutboundTranscriptEntry): Promise<void> {
    await this.append(entry.providerMessageId, (onInserted) =>
      this.store.append(
        {
          senderId: entry.to,
          waMessageId: entry.providerMessageId,
          direction: 'OUT',
          author: 'BOT',
          type: entry.type,
          text: entry.text ?? null,
          media: entry.media ?? null,
          details: entry.details ?? null,
          observedAt: this.now(),
        },
        onInserted,
      ),
    );
  }

  private async append(
    waMessageId: string,
    write: (onInserted?: TranscriptInsertHook) => Promise<boolean>,
  ): Promise<void> {
    try {
      await write(this.mirrorHook());
    } catch (error) {
      this.logger.warn(
        `transcript write failed for ${waMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private mirrorHook(): TranscriptInsertHook | undefined {
    const outbox = this.outbox;
    if (outbox === undefined) return undefined;
    return async (row, client) => {
      await outbox.enqueue(
        {
          conversationRef: conversationRefFor(row.senderId),
          kind: 'MESSAGE_MIRROR',
          idempotencyKey: `mirror:${row.waMessageId}`,
          payload: mirrorPayload(row),
        },
        { client },
      );
    };
  }
}

/**
 * Contract `messages:batch` item from the stored row. `media` is the
 * provider reference as stored; the HTTP adapter uploads it and sends
 * `mediaId` instead. Null fields are omitted.
 */
export function mirrorPayload(row: TranscriptMessage): Record<string, unknown> {
  return {
    waMessageId: row.waMessageId,
    direction: row.direction,
    author: row.author,
    type: row.type,
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.media === null ? {} : { media: row.media }),
    ...(row.providerTimestamp === null
      ? {}
      : { providerTimestamp: row.providerTimestamp }),
    observedAt: row.observedAt,
  };
}

function inboundType(message: InboundMessage): string {
  if (message.media !== undefined) return message.media.kind;
  return message.interactiveReplyId === undefined ? 'text' : 'interactive';
}
