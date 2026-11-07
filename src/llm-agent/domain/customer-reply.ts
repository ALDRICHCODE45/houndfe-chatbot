/**
 * S3: the structured reply the customer route returns. `reply` is the text
 * (also what the session history stores); `media` goes out BEFORE it.
 *
 * Extension point: interactive buttons/lists (S4) are a new optional field
 * here (e.g. `interactive?`), sent by the dispatcher in place of plain text.
 */
export type CustomerReplyImage = {
  kind: 'image';
  /** Public https JPEG/PNG (see `isSendableProductImageUrl`). */
  url: string;
  /** Product name only: no variant, no price. */
  caption?: string;
};

/** Union of attachable media; only images for now. */
export type CustomerReplyMedia = CustomerReplyImage;

export interface CustomerReply {
  reply: string;
  media?: readonly CustomerReplyMedia[];
}

/** WhatsApp image messages accept only JPEG/PNG. */
const SENDABLE_IMAGE_PATH = /\.(?:jpe?g|png)$/i;
const CAPTION_MAX = 200;

/**
 * True for an absolute `https://` URL whose PATH ends in .jpg/.jpeg/.png
 * (query and fragment ignored). Anything else (null, http, webp, gif, no
 * extension) is sent as text only. Size (>5 MB) is unknown here: a Meta
 * rejection is handled by the sender failure path.
 */
export function isSendableProductImageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && SENDABLE_IMAGE_PATH.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** Short, single-line caption from a product name. */
export function productImageCaption(name: string): string | undefined {
  const caption = name.replace(/\s+/g, ' ').trim().slice(0, CAPTION_MAX);
  return caption === '' ? undefined : caption;
}

/**
 * Product photos known to this conversation and the ones already sent.
 * Server-owned, JSON-serializable and bounded; carried turn to turn in the
 * session like the cart context.
 */
export type ProductImageContext = {
  /** productId → photo, from catalog reads. */
  known: Record<string, { url: string; name: string }>;
  /** productIds whose photo was already attached once. */
  sent: string[];
};

const KNOWN_MAX = 50;
const SENT_MAX = 100;

export function emptyProductImageContext(): ProductImageContext {
  return { known: {}, sent: [] };
}

/** Bounded copy keeping the most recent entries. */
export function boundProductImageContext(
  context: ProductImageContext,
): ProductImageContext {
  return {
    known: Object.fromEntries(Object.entries(context.known).slice(-KNOWN_MAX)),
    sent: context.sent.slice(-SENT_MAX),
  };
}
