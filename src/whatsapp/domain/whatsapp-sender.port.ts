/** DI token for outbound WhatsApp message sending. */
export const WHATSAPP_SENDER = Symbol('WHATSAPP_SENDER');

/** Normalized text-only outbound message for the current slice. */
export interface OutboundText {
  to: string;
  text: string;
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

/** Port abstraction for outbound WhatsApp text delivery. */
export interface WhatsappSenderPort {
  sendText(message: OutboundText): Promise<SendResult>;
}
