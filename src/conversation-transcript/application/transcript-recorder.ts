import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import {
  conversationRefFor,
  isConversationRef,
} from '../../backend-outbox/domain/backend-outbox';
import type { InboundMessage } from '../../whatsapp/domain/inbound-message';
import {
  CONVERSATION_TRANSCRIPT,
  InvalidTranscriptMessageError,
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
  /** When Meta accepted the send; becomes the row's providerTimestamp. */
  acceptedAt?: Date;
}

/** What the sender adapter needs; kept narrow so fakes stay trivial. */
export interface OutboundTranscriptRecorder {
  recordOutbound(entry: OutboundTranscriptEntry): Promise<void>;
}

/**
 * S1 writer for the durable transcript.
 *
 * Inbound: a store or outbox failure THROWS, so the dispatcher fails the
 * webhook delivery before any claim or reply and Meta redelivers it; a
 * customer message is never lost from the transcript. A message that can
 * never be stored (a sender that is not a wa_id, an invalid field) only
 * warns: a redelivery would fail the same way forever.
 *
 * Outbound: best effort. Meta already accepted the message, so a failure
 * only warns and is not retried (that row and its mirror are lost).
 *
 * S1→S2: with the backend outbox, every row actually inserted is enqueued
 * as one MESSAGE_MIRROR in the same transaction, so a mirror is never lost
 * or duplicated; a failed enqueue rolls the row back too. The sender is
 * checked against the outbox `conversationRef` format up front, so a valid
 * transcript row is never rolled back by an invalid mirror.
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
    const media = inboundMedia(message);
    // T2: the mirror text of a tapped reply is the title the customer saw.
    const text =
      message.interactiveReplyId !== undefined &&
      message.interactiveReplyTitle !== undefined
        ? message.interactiveReplyTitle
        : message.text;
    await this.append('IN', message.senderId, message.messageId, (onInserted) =>
      this.store.append(
        {
          senderId: message.senderId,
          waMessageId: message.messageId,
          direction: 'IN',
          author: 'CUSTOMER',
          type: rawType ?? inboundType(message),
          text,
          media,
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
    await this.append('OUT', entry.to, entry.providerMessageId, (onInserted) =>
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
          providerTimestamp: (entry.acceptedAt ?? this.now()).toISOString(),
          observedAt: this.now(),
        },
        onInserted,
      ),
    );
  }

  private async append(
    direction: 'IN' | 'OUT',
    senderId: string,
    waMessageId: string,
    write: (onInserted?: TranscriptInsertHook) => Promise<boolean>,
  ): Promise<void> {
    if (!isConversationRef(conversationRefFor(senderId))) {
      this.logger.warn(
        `transcript record rejected for ${waMessageId}: sender is not a WhatsApp wa_id`,
      );
      return;
    }
    try {
      await write(this.mirrorHook());
    } catch (error) {
      if (
        direction === 'IN' &&
        !(error instanceof InvalidTranscriptMessageError)
      )
        throw error;
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

/** Contract `messages:batch` `type` values. */
export type MirrorContractType =
  | 'TEXT'
  | 'IMAGE'
  | 'STICKER'
  | 'DOCUMENT'
  | 'AUDIO'
  | 'TEMPLATE'
  | 'UNSUPPORTED';

/** Contract `kind` of an UNSUPPORTED message. */
export type MirrorUnsupportedKind = 'VIDEO' | 'LOCATION' | 'OTHER';

const CONTRACT_TYPE_BY_PROVIDER_TYPE: Readonly<
  Record<string, MirrorContractType>
> = {
  text: 'TEXT',
  // A tapped reply and an interactive OUT both mirror as TEXT (S5 #2, #3).
  interactive: 'TEXT',
  button: 'TEXT',
  image: 'IMAGE',
  sticker: 'STICKER',
  document: 'DOCUMENT',
  audio: 'AUDIO',
  template: 'TEMPLATE',
};

/** The contract type for Meta's lowercase type; unknown ones are UNSUPPORTED. */
export function mirrorContractType(providerType: string): MirrorContractType {
  return Object.prototype.hasOwnProperty.call(
    CONTRACT_TYPE_BY_PROVIDER_TYPE,
    providerType,
  )
    ? CONTRACT_TYPE_BY_PROVIDER_TYPE[providerType]
    : 'UNSUPPORTED';
}

/** The contract `kind` for an UNSUPPORTED provider type. */
export function mirrorUnsupportedKind(
  providerType: string,
): MirrorUnsupportedKind {
  if (providerType === 'video') return 'VIDEO';
  if (providerType === 'location') return 'LOCATION';
  return 'OTHER';
}

/** The option titles an interactive OUT offered (details.options). */
function offeredOptions(
  details: Record<string, unknown> | null,
): string[] | null {
  const options = details?.options;
  if (!Array.isArray(options)) return null;
  const titles = (options as unknown[]).filter(
    (option): option is string => typeof option === 'string' && option !== '',
  );
  return titles.length === 0 ? null : titles;
}

/** Unit 10: the staff reply an OUT text message delivered, if any. */
function sentStaffReplyId(
  row: TranscriptMessage,
  contractType: MirrorContractType,
): string | null {
  const id = row.details?.staffReplyId;
  return row.direction === 'OUT' &&
    row.type === 'text' &&
    contractType === 'TEXT' &&
    typeof id === 'string' &&
    id !== ''
    ? id
    : null;
}

/**
 * Contract `messages:batch` item from the stored row. Fields only get added
 * over time (rows already in the outbox keep their `media` object and Meta's
 * lowercase `type`). `media` is the provider reference as stored; the HTTP
 * adapter uploads it and sends `mediaId` instead. Null fields are omitted.
 *
 * Added: `contractType` (the contract `type`), `unsupportedKind` (video,
 * location, other; UNSUPPORTED only) and `options` (the titles an interactive
 * OUT offered, rendered by the delivery adapter as "Opciones: A · B").
 * Rows written before these fields lack them; the adapter derives them with
 * `mirrorContractType` / `mirrorUnsupportedKind`.
 */
export function mirrorPayload(row: TranscriptMessage): Record<string, unknown> {
  const contractType = mirrorContractType(row.type);
  const options = offeredOptions(row.details);
  const staffReplyId = sentStaffReplyId(row, contractType);
  return {
    waMessageId: row.waMessageId,
    direction: row.direction,
    author: row.author,
    type: row.type,
    contractType,
    ...(contractType === 'UNSUPPORTED'
      ? { unsupportedKind: mirrorUnsupportedKind(row.type) }
      : {}),
    ...(row.text === null ? {} : { text: row.text }),
    ...(options === null ? {} : { options }),
    ...(staffReplyId === null ? {} : { staffReplyId }),
    ...(row.media === null ? {} : { media: row.media }),
    ...(row.providerTimestamp === null
      ? {}
      : { providerTimestamp: row.providerTimestamp }),
    observedAt: row.observedAt,
  };
}

/** Provider media reference of an inbound: image/document or audio/sticker. */
function inboundMedia(message: InboundMessage): TranscriptMedia | null {
  const media = message.media;
  if (media !== undefined)
    return {
      providerMediaId: media.providerMediaId,
      mimeType: media.declaredMimeType,
      filename: media.filename,
    };
  const mirrorOnly = message.mirrorOnly;
  if (mirrorOnly?.providerMediaId === undefined) return null;
  return {
    providerMediaId: mirrorOnly.providerMediaId,
    mimeType: mirrorOnly.mimeType,
  };
}

function inboundType(message: InboundMessage): string {
  if (message.media !== undefined) return message.media.kind;
  if (message.mirrorOnly !== undefined) return message.mirrorOnly.type;
  return message.interactiveReplyId === undefined ? 'text' : 'interactive';
}
