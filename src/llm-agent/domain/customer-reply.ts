/**
 * S3: the structured reply the customer route returns. `reply` is the text
 * (also what the session history stores); `media` goes out BEFORE it.
 *
 * S4: `interactive` attaches WhatsApp reply buttons or a list to the text;
 * the dispatcher sends it in place of plain text (the text still says how to
 * answer, so a plain-text fallback never loses the reply).
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

export type CustomerReplyButton = { id: string; title: string };
export type CustomerReplyListRow = {
  id: string;
  title: string;
  description?: string;
};

/**
 * S4: WhatsApp reply buttons (1-3, title ≤ 20) or a list (1-10 rows, title
 * ≤ 24, description ≤ 72, button text ≤ 20). `prompt` is the short body used
 * when the reply text exceeds Meta's 1024-char interactive body.
 */
export type CustomerReplyInteractive =
  | {
      type: 'buttons';
      buttons: readonly CustomerReplyButton[];
      prompt?: string;
    }
  | {
      type: 'list';
      buttonText: string;
      rows: readonly CustomerReplyListRow[];
      prompt?: string;
    };

export interface CustomerReply {
  reply: string;
  media?: readonly CustomerReplyMedia[];
  interactive?: CustomerReplyInteractive;
}

/** Meta interactive limits (Cloud API). */
export const INTERACTIVE_LIMITS = Object.freeze({
  body: 1024,
  buttons: 3,
  buttonTitle: 20,
  listButtonText: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  id: 200,
});

const ORDER_CONFIRM = 'order_confirm';
const ORDER_CHANGE = 'order_change';
const CHECKOUT_CONFIRM = 'checkout_confirm';
const CHECKOUT_CHANGE = 'checkout_change';
const PICK_VARIANT = 'pick_variant';
const PICK_PRODUCT = 'pick_product';

/** Customer text a confirm button stands for (the gates' affirmative). */
export const INTERACTIVE_CONFIRM_TEXT = 'SÍ';
/** Change intents: never an affirmative for the confirmation gates. */
export const INTERACTIVE_ORDER_CHANGE_TEXT = 'Quiero cambiar algo';
export const INTERACTIVE_CHECKOUT_CHANGE_TEXT = 'Quiero corregir mis datos';

/** What a tapped button or list row means, from its id. */
export type InteractiveReplyIntent =
  | {
      kind: 'order_confirm' | 'checkout_confirm';
      /** Summary the button belonged to; `null` for a bare legacy id. */
      reference: string | null;
    }
  | { kind: 'order_change' | 'checkout_change' }
  | { kind: 'pick'; choice: 'variant' | 'product'; reference: string };

/** Parse a reply id the bot issued; anything else (unknown, forged) is `null`. */
export function parseInteractiveReplyId(
  id: unknown,
): InteractiveReplyIntent | null {
  if (typeof id !== 'string' || id === '' || id.length > INTERACTIVE_LIMITS.id)
    return null;
  const colon = id.indexOf(':');
  const head = colon === -1 ? id : id.slice(0, colon);
  const tail = colon === -1 ? null : id.slice(colon + 1);
  if (tail === '') return null;
  switch (head) {
    case ORDER_CONFIRM:
    case CHECKOUT_CONFIRM:
      return { kind: head, reference: tail };
    case ORDER_CHANGE:
    case CHECKOUT_CHANGE:
      return tail === null ? { kind: head } : null;
    case PICK_VARIANT:
    case PICK_PRODUCT:
      return tail === null
        ? null
        : {
            kind: 'pick',
            choice: head === PICK_VARIANT ? 'variant' : 'product',
            reference: tail,
          };
    default:
      return null;
  }
}

/**
 * Inbound text for a tapped reply: a confirm is "SÍ", a change is a change
 * intent, a list pick or an unknown id is the row/button title.
 */
export function interactiveReplyText(id: unknown, title: unknown): string {
  const intent = parseInteractiveReplyId(id);
  const fallback = typeof title === 'string' ? title : '';
  switch (intent?.kind) {
    case 'order_confirm':
    case 'checkout_confirm':
      return INTERACTIVE_CONFIRM_TEXT;
    case 'order_change':
      return INTERACTIVE_ORDER_CHANGE_TEXT;
    case 'checkout_change':
      return INTERACTIVE_CHECKOUT_CHANGE_TEXT;
    default:
      return fallback;
  }
}

const graphemes = (text: string): string[] => {
  try {
    return [
      ...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(text),
    ].map((part) => part.segment);
  } catch {
    return [...text];
  }
};

/**
 * Single-line text of at most `max` UTF-16 units, cut on a grapheme boundary
 * (never splitting an emoji) with a trailing "…" when shortened.
 */
export function fitInteractiveText(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  let out = '';
  for (const part of graphemes(line)) {
    if (out.length + part.length + 1 > max) break;
    out += part;
  }
  return `${out.trimEnd()}…`;
}

/** Buttons under the server-owned order summary, bound to its reference. */
export function orderConfirmationButtons(
  reference: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      { id: `${ORDER_CONFIRM}:${reference}`, title: '✅ Confirmar pedido' },
      { id: ORDER_CHANGE, title: '✏️ Cambiar algo' },
    ],
    prompt,
  };
}

/** Buttons under the server-owned delivery-data summary. */
export function checkoutConfirmationButtons(
  reference: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      { id: `${CHECKOUT_CONFIRM}:${reference}`, title: '✅ Sí, son correctos' },
      { id: CHECKOUT_CHANGE, title: '✏️ Corregir datos' },
    ],
    prompt,
  };
}

/** One option of a server-owned product/presentation question. */
export type InteractiveChoiceOption = {
  /** Opaque cart selection reference the row resolves to. */
  reference: string;
  title: string;
  description?: string;
  /** Unambiguous customer text the pick stands for (full name/label). */
  text: string;
};

/**
 * The list a turn sent, stored with that turn only: a pick is honoured only
 * while it answers the bot's latest message.
 */
export type InteractiveChoiceContext = {
  options: Array<{ id: string; reference: string; text: string }>;
};

/** 2-10 options → a list plus the context to resolve the pick; else `null`. */
export function choiceList(
  choice: 'variant' | 'product',
  options: readonly InteractiveChoiceOption[],
  prompt: string,
): {
  interactive: CustomerReplyInteractive;
  context: InteractiveChoiceContext;
} | null {
  const prefix = choice === 'variant' ? PICK_VARIANT : PICK_PRODUCT;
  const usable = options
    .filter(
      (option) =>
        option.reference !== '' &&
        `${prefix}:${option.reference}`.length <= INTERACTIVE_LIMITS.id &&
        option.title.trim() !== '',
    )
    .slice(0, INTERACTIVE_LIMITS.rows);
  if (usable.length < 2) return null;
  const rows = usable.map((option) => {
    const description =
      option.description === undefined
        ? ''
        : fitInteractiveText(
            option.description,
            INTERACTIVE_LIMITS.rowDescription,
          );
    return {
      id: `${prefix}:${option.reference}`,
      title: fitInteractiveText(option.title, INTERACTIVE_LIMITS.rowTitle),
      ...(description === '' ? {} : { description }),
    };
  });
  return {
    interactive: { type: 'list', buttonText: 'Ver opciones', rows, prompt },
    context: {
      options: usable.map((option, index) => ({
        id: rows[index].id,
        reference: option.reference,
        text: option.text,
      })),
    },
  };
}

/** Short price for a row title: "$389" or "$389.50". */
export function shortMxn(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
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
