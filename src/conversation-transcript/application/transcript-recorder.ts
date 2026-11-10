import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { InboundMessage } from '../../whatsapp/domain/inbound-message';
import {
  CONVERSATION_TRANSCRIPT,
  type ConversationTranscriptStore,
  type TranscriptMedia,
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
 */
@Injectable()
export class TranscriptRecorder implements OutboundTranscriptRecorder {
  private readonly logger = new Logger(TranscriptRecorder.name);
  private readonly now: () => Date;

  constructor(
    @Inject(CONVERSATION_TRANSCRIPT)
    private readonly store: ConversationTranscriptStore,
    @Optional() @Inject(TRANSCRIPT_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** A normalized customer inbound; `rawType` is Meta's `message.type`. */
  async recordInbound(
    message: InboundMessage,
    rawType?: string,
  ): Promise<void> {
    const media = message.media;
    await this.append(message.messageId, () =>
      this.store.append({
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
      }),
    );
  }

  async recordOutbound(entry: OutboundTranscriptEntry): Promise<void> {
    await this.append(entry.providerMessageId, () =>
      this.store.append({
        senderId: entry.to,
        waMessageId: entry.providerMessageId,
        direction: 'OUT',
        author: 'BOT',
        type: entry.type,
        text: entry.text ?? null,
        media: entry.media ?? null,
        details: entry.details ?? null,
        observedAt: this.now(),
      }),
    );
  }

  private async append(
    waMessageId: string,
    write: () => Promise<boolean>,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(
        `transcript write failed for ${waMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function inboundType(message: InboundMessage): string {
  if (message.media !== undefined) return message.media.kind;
  return message.interactiveReplyId === undefined ? 'text' : 'interactive';
}
