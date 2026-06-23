/**
 * Normalized inbound message envelope produced from Meta webhook payloads.
 *
 * The webhook controller/dispatcher slice will map provider-specific payloads
 * into this shape so downstream application code stays provider-agnostic.
 */
export interface InboundMessage {
  senderId: string;
  text: string;
  messageId: string;
  timestamp: string;
}
