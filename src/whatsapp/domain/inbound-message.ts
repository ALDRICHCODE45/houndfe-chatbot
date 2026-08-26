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
  /**
   * Meta `value.metadata.phone_number_id` — the receiving WhatsApp Business
   * number. Defensive + observable only; the ops discriminator stays
   * `isOpsSender(from)` per ADR-22 (both customer and ops inbounds arrive
   * at the same bot number).
   */
  receivingPhoneNumberId?: string;
}
