/** DI token for outbound WhatsApp message sending. */
export const WHATSAPP_SENDER = Symbol('WHATSAPP_SENDER');

/**
 * Who a send is on behalf of. `BOT` (default) is mirrored to the backend as a
 * BOT message. `STAFF` (a person's relayed message) and `TEMPLATE` (a
 * backend-requested template) are NEVER mirrored: the backend already has
 * them and only gets the wamid in the delivery outcome. They are still kept
 * in the local transcript, tagged with their origin.
 */
export type OutboundOrigin = 'BOT' | 'STAFF' | 'TEMPLATE';

/** Mixed into every outbound message kind. */
export interface OutboundOriginOption {
  /** Default `BOT`. */
  origin?: OutboundOrigin;
}

/** Normalized text-only outbound message for the current slice. */
export interface OutboundText extends OutboundOriginOption {
  to: string;
  text: string;
  /**
   * Unit 10: the `replyId` of a staff clarification reply this text delivers.
   * Never sent to Meta; recorded with the transcript row so the mirror can
   * attribute the message to the staff member.
   */
  staffReplyId?: string;
}

/**
 * Image message by public link (Graph API `type: 'image'`). Meta accepts
 * only JPEG/PNG up to 5 MB; a rejected image is a send failure.
 */
export interface OutboundImage extends OutboundOriginOption {
  to: string;
  /** Absolute `https://` URL Meta downloads the image from. Exactly one of
   *  `link` and `mediaId`. */
  link?: string;
  /** Meta media id of an image already uploaded (see `sendMediaFile`). */
  mediaId?: string;
  /** Short caption (product name only, no prices). */
  caption?: string;
}

/** Document message (Graph API `type: 'document'`), by link or media id. */
export interface OutboundDocument extends OutboundOriginOption {
  to: string;
  /** Exactly one of `link` (`https://`) and `mediaId`. */
  link?: string;
  mediaId?: string;
  /** Name the customer sees; required by Meta for a useful download. */
  filename: string;
  caption?: string;
}

/** Mime types accepted for a media file sent from disk. */
export const OUTBOUND_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/**
 * A local file uploaded to Meta (streamed from disk) and then sent by the
 * returned media id: `image/*` as an image, `application/pdf` as a document.
 */
export interface OutboundMediaFile extends OutboundOriginOption {
  to: string;
  filePath: string;
  /** One of `OUTBOUND_MEDIA_MIME_TYPES`. */
  mimeType: string;
  /** Document name (default `documento.pdf`); ignored for images. */
  filename?: string;
  caption?: string;
}

/** The media id Meta assigned to the upload, next to the wamid. */
export interface MediaSendResult extends SendResult {
  providerMediaId: string;
}

/** S4 reply buttons (Graph API `interactive.type: 'button'`). */
export interface OutboundInteractiveButtons {
  type: 'buttons';
  /** 1-3; titles over 20 chars are shortened. */
  buttons: ReadonlyArray<{ id: string; title: string }>;
}

/** S4 single-section list (Graph API `interactive.type: 'list'`). */
export interface OutboundInteractiveList {
  type: 'list';
  /** Button that opens the list; shortened to 20 chars. */
  buttonText: string;
  /** 1-10; title ≤ 24, description ≤ 72 (longer ones are shortened). */
  rows: ReadonlyArray<{ id: string; title: string; description?: string }>;
  sectionTitle?: string;
}

/**
 * Interactive message. A `body` over Meta's 1024 chars is sent first as a
 * plain text message, followed by the controls with `shortBody`.
 */
export interface OutboundInteractive {
  to: string;
  body: string;
  interactive: OutboundInteractiveButtons | OutboundInteractiveList;
  shortBody?: string;
}

/** Every message Meta accepted for one interactive send, in send order. */
export interface InteractiveSendResult extends SendResult {
  providerMessageIds: string[];
}

/**
 * Pre-approved template message (Meta WhatsApp Manager). Only for sends
 * outside the 24h customer service window, where free-form text is refused.
 */
export interface OutboundTemplate extends OutboundOriginOption {
  to: string;
  /** Lowercase `[a-z0-9_]+`, at most 512 chars. */
  templateName: string;
  /** Approved template language, e.g. `es_MX`. */
  languageCode: string;
  /**
   * Ordered `{{1}}..{{n}}` body values (may be empty): each non-empty, trimmed, at most 1024
   * chars, no newlines/tabs and no more than 4 consecutive spaces.
   */
  bodyParameters: string[];
}

/** Minimal send acknowledgement returned by the provider adapter. */
export interface SendResult {
  providerMessageId: string;
}

/** Error raised when a caller tries to send anything other than text. */
export class UnsupportedOutboundError extends Error {
  constructor(
    message = 'Only outbound text messages are supported in this slice',
  ) {
    super(message);
    this.name = 'UnsupportedOutboundError';
  }
}

/** Error raised when a template message would be rejected by Meta. */
export class InvalidOutboundTemplateError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid outbound template message: ${reason}`);
    this.name = 'InvalidOutboundTemplateError';
  }
}

/** Port abstraction for outbound WhatsApp text, image and template delivery. */
export interface WhatsappSenderPort {
  sendText(message: OutboundText): Promise<SendResult>;
  sendTemplate(message: OutboundTemplate): Promise<SendResult>;
  /**
   * Optional so text-only adapters and fakes keep working; callers send the
   * text alone when it is absent.
   */
  sendImage?(message: OutboundImage): Promise<SendResult>;
  /** Unit 11. Optional like `sendImage`. */
  sendDocument?(message: OutboundDocument): Promise<SendResult>;
  /** Unit 11: upload a local file, then send it by media id. */
  sendMediaFile?(message: OutboundMediaFile): Promise<MediaSendResult>;
  /**
   * S4. Optional like `sendImage`; callers send the plain text when it is
   * absent or fails.
   */
  sendInteractive?(
    message: OutboundInteractive,
  ): Promise<InteractiveSendResult>;
}
