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
  /**
   * Optional normalized media envelope for `type: 'image'` and
   * `type: 'document'` inbound messages. Present only when the payload
   * is structurally valid (id + mime present and type matches payload).
   */
  media?: InboundMedia;
}

/**
 * Immutable optional media envelope for image/document inbound messages.
 * All fields are narrow and optional except `kind`, `providerMediaId`,
 * and `declaredMimeType` which are always populated for a valid envelope.
 */
export interface InboundMedia {
  readonly kind: 'image' | 'document';
  readonly providerMediaId: string;
  readonly declaredMimeType: string;
  readonly caption?: string;
  readonly filename?: string;
  readonly sha256?: string;
}
