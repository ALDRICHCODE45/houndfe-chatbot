/** DI token for outbound WhatsApp message sending. */
export const WHATSAPP_SENDER = Symbol('WHATSAPP_SENDER');

/** Normalized text-only outbound message for the current slice. */
export interface OutboundText {
  to: string;
  text: string;
}

/**
 * Pre-approved template message (Meta WhatsApp Manager). Only for sends
 * outside the 24h customer service window, where free-form text is refused.
 */
export interface OutboundTemplate {
  to: string;
  /** Lowercase `[a-z0-9_]+`, at most 512 chars. */
  templateName: string;
  /** Approved template language, e.g. `es_MX`. */
  languageCode: string;
  /**
   * Ordered `{{1}}..{{n}}` body values: each non-empty, trimmed, at most 1024
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

/** Port abstraction for outbound WhatsApp text and template delivery. */
export interface WhatsappSenderPort {
  sendText(message: OutboundText): Promise<SendResult>;
  sendTemplate(message: OutboundTemplate): Promise<SendResult>;
}
