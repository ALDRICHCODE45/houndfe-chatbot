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
  /**
   * S4: id of the tapped reply button or list row (`text` then holds what it
   * stands for: "SÍ", a change intent, or the row title).
   */
  interactiveReplyId?: string;
  /**
   * T2: the title of the tapped button or list row exactly as the customer
   * saw it (`text` may stand for something else, e.g. "SÍ"). The mirror
   * records this one.
   */
  interactiveReplyTitle?: string;
  /**
   * T2: audio, sticker, video or location. Recorded and mirrored for the
   * human inbox, never given to the agent, receipt ingress or vision (`text`
   * is empty and `media` stays unset).
   */
  mirrorOnly?: InboundMirrorOnly;
  /**
   * S1: the sender's WhatsApp contact profile name (`contacts[].profile.name`
   * for this wa_id), when Meta sent a non-blank one. Customer-controlled text.
   */
  profileName?: string;
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

/**
 * T2: a customer message the bot cannot process but staff must see. The Meta
 * media id and mime type are kept for audio and sticker so the media pipeline
 * can download them; video and location are markers only.
 */
export interface InboundMirrorOnly {
  readonly type: 'audio' | 'sticker' | 'video' | 'location';
  readonly providerMediaId?: string;
  readonly mimeType?: string;
  /** Audio only: Meta flags a recorded voice note with `voice: true`. */
  readonly voice?: boolean;
}
