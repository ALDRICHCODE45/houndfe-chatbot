import {
  PAYMENT_METHODS,
  paymentMethodById,
  type PaymentMethod,
} from './payment-methods';

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
const REORDER_CONFIRM = 'reorder_confirm';
const REORDER_CHANGE = 'reorder_change';
const PICK_VARIANT = 'pick_variant';
const PICK_PRODUCT = 'pick_product';
const PAYMENT_METHOD = 'pay';
const CART_CONTINUE = 'cart_continue';
const CART_ADD_MORE = 'cart_add';
const FULFIL_DELIVERY = 'fulfil_delivery';
const FULFIL_PICKUP = 'fulfil_pickup';
const BACKORDER = 'backorder';
const BACKORDER_CANCEL = 'backorder_cancel';
// Restock backorder T5b: the notice's Confirm button and the reschedule pair
// (the reference is the BACKORDER id; one segment, no action).
const BACKORDER_CONFIRM = 'backorder_confirm';
const BACKORDER_RESCHEDULE = 'backorder_reschedule';
const BACKORDER_RESCHEDULE_DECLINE = 'backorder_reschedule_decline';
const BACKORDER_REFERENCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Customer text a confirm button stands for (the gates' affirmative). */
export const INTERACTIVE_CONFIRM_TEXT = 'SÍ';
/** Restock backorder S1: what the «No, gracias» button stands for. */
export const INTERACTIVE_BACKORDER_DECLINE_TEXT = 'No, gracias';
/** Restock backorder S8: what the «No» button of the cancel question stands for. */
export const INTERACTIVE_BACKORDER_KEEP_TEXT = 'No';
/** Restock backorder T5b: what the notice's Confirm button stands for. */
export const INTERACTIVE_BACKORDER_CONFIRM_TEXT = 'Confirmo mi pedido apartado';
/** Restock backorder T5b: «No, gracias» under the reschedule question. */
export const INTERACTIVE_BACKORDER_RESCHEDULE_DECLINE_TEXT = 'No, gracias';
/** Change intents: never an affirmative for the confirmation gates. */
export const INTERACTIVE_ORDER_CHANGE_TEXT = 'Quiero cambiar algo';
export const INTERACTIVE_CHECKOUT_CHANGE_TEXT = 'Quiero corregir mis datos';
/** «Seguir con la compra» is the customer asking to buy (starts checkout). */
export const INTERACTIVE_CART_CONTINUE_TEXT = 'Quiero comprar';
/** Retest S4 (N15): the two answers to the delivery-or-pickup question. */
export const INTERACTIVE_FULFIL_DELIVERY_TEXT = 'Envío a domicilio';
export const INTERACTIVE_FULFIL_PICKUP_TEXT = 'Recoger en tienda';

/** What a tapped button or list row means, from its id. */
export type InteractiveReplyIntent =
  | {
      kind: 'order_confirm' | 'checkout_confirm';
      /** Summary the button belonged to; `null` for a bare legacy id. */
      reference: string | null;
    }
  | { kind: 'order_change' | 'checkout_change' }
  /** S2 reorder offer; the reference is always required. */
  | { kind: 'reorder_confirm'; reference: string }
  | { kind: 'reorder_change' }
  | { kind: 'pick'; choice: 'variant' | 'product'; reference: string }
  /** Payment-step method button; the reference is the placed sale id. */
  | { kind: 'payment_method'; method: string; reference: string }
  /** Cart-summary buttons; the reference identifies the cart they were sent with. */
  | { kind: 'cart_continue' | 'cart_add_more'; reference: string }
  /** Retest S4: delivery-or-pickup answer, bound to the cart it was asked for. */
  | { kind: 'fulfilment'; mode: 'delivery' | 'pickup'; reference: string }
  /**
   * Restock backorder S1: the buttons under the estimate message; the
   * reference is the RESTOCK decision id the offer was sent for.
   */
  | {
      kind: 'backorder';
      action: 'schedule' | 'decline';
      reference: string;
    }
  /**
   * Restock backorder S8: the cancel question's buttons (`yes` / `no`) and the
   * pick among several backorders (`pick`); the reference is the BACKORDER id
   * (self-contained: the answer is re-verified against the customer's list).
   */
  | {
      kind: 'backorder_cancel';
      action: 'yes' | 'no' | 'pick';
      reference: string;
    }
  /**
   * Restock backorder T5b: the arrival / reminder notice's Confirm button and
   * the reschedule question's buttons after an expiry; the reference is the
   * BACKORDER id (re-verified against the customer's own backorders).
   */
  | {
      kind:
        | 'backorder_confirm'
        | 'backorder_reschedule'
        | 'backorder_reschedule_decline';
      reference: string;
    };

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
    case REORDER_CHANGE:
      return tail === null ? { kind: head } : null;
    case REORDER_CONFIRM:
      return tail === null ? null : { kind: head, reference: tail };
    case CART_CONTINUE:
    case CART_ADD_MORE:
      return tail === null
        ? null
        : {
            kind: head === CART_CONTINUE ? 'cart_continue' : 'cart_add_more',
            reference: tail,
          };
    case FULFIL_DELIVERY:
    case FULFIL_PICKUP:
      return tail === null
        ? null
        : {
            kind: 'fulfilment',
            mode: head === FULFIL_PICKUP ? 'pickup' : 'delivery',
            reference: tail,
          };
    case BACKORDER: {
      // Tail is `<schedule|decline>:<decisionId>`; both parts are required.
      const split = tail === null ? -1 : tail.indexOf(':');
      if (tail === null || split <= 0) return null;
      const action = tail.slice(0, split);
      const reference = tail.slice(split + 1);
      if (
        (action !== 'schedule' && action !== 'decline') ||
        !BACKORDER_REFERENCE.test(reference)
      )
        return null;
      return { kind: 'backorder', action, reference };
    }
    case BACKORDER_CANCEL: {
      // Tail is `<yes|no|pick>:<backorderId>`; both parts are required.
      const split = tail === null ? -1 : tail.indexOf(':');
      if (tail === null || split <= 0) return null;
      const action = tail.slice(0, split);
      const reference = tail.slice(split + 1);
      if (
        (action !== 'yes' && action !== 'no' && action !== 'pick') ||
        !BACKORDER_REFERENCE.test(reference)
      )
        return null;
      return { kind: 'backorder_cancel', action, reference };
    }
    case BACKORDER_CONFIRM:
    case BACKORDER_RESCHEDULE:
    case BACKORDER_RESCHEDULE_DECLINE:
      return tail !== null && BACKORDER_REFERENCE.test(tail)
        ? { kind: head, reference: tail }
        : null;
    case PAYMENT_METHOD: {
      // Tail is `<method>:<saleId>`; both parts are required.
      const split = tail === null ? -1 : tail.indexOf(':');
      if (tail === null || split <= 0 || split === tail.length - 1) return null;
      const method = tail.slice(0, split);
      return paymentMethodById(method) === null
        ? null
        : { kind: 'payment_method', method, reference: tail.slice(split + 1) };
    }
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
    case 'reorder_confirm':
      return INTERACTIVE_CONFIRM_TEXT;
    case 'backorder':
      // The title «Sí, apártamelo» reads as a tú imperative to the style
      // detector, which would turn every usted customer who taps it into a
      // tú customer: the inbound text is the neutral affirmative instead.
      return intent.action === 'schedule'
        ? INTERACTIVE_CONFIRM_TEXT
        : INTERACTIVE_BACKORDER_DECLINE_TEXT;
    case 'backorder_cancel':
      // A yes is the neutral affirmative; a no is «No»; a pick keeps its
      // folio title (it only selects which backorder the question is about).
      if (intent.action === 'yes') return INTERACTIVE_CONFIRM_TEXT;
      return intent.action === 'no'
        ? INTERACTIVE_BACKORDER_KEEP_TEXT
        : fallback;
    case 'backorder_confirm':
      return INTERACTIVE_BACKORDER_CONFIRM_TEXT;
    case 'backorder_reschedule':
      return INTERACTIVE_CONFIRM_TEXT;
    case 'backorder_reschedule_decline':
      return INTERACTIVE_BACKORDER_RESCHEDULE_DECLINE_TEXT;
    case 'order_change':
    case 'reorder_change':
      return INTERACTIVE_ORDER_CHANGE_TEXT;
    case 'checkout_change':
      return INTERACTIVE_CHECKOUT_CHANGE_TEXT;
    case 'cart_continue':
      return INTERACTIVE_CART_CONTINUE_TEXT;
    case 'fulfilment':
      return intent.mode === 'pickup'
        ? INTERACTIVE_FULFIL_PICKUP_TEXT
        : INTERACTIVE_FULFIL_DELIVERY_TEXT;
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

/** Short body of the order-summary buttons (usted; styled by the sender). */
export const ORDER_BUTTONS_PROMPT = '¿Confirma su pedido?';

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

/**
 * Buttons under the payment offer: one per offered payment method (default:
 * today's list; «Pagar en tienda» only for a pickup order with pay in store
 * on), bound to the placed sale. Titles are the same in usted and tú.
 */
export function paymentMethodButtons(
  saleId: string,
  prompt: string,
  methods: readonly PaymentMethod[] = PAYMENT_METHODS,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: methods.slice(0, INTERACTIVE_LIMITS.buttons).map((method) => ({
      id: `${PAYMENT_METHOD}:${method.id}:${saleId}`,
      title: method.title,
    })),
    prompt,
  };
}

/**
 * Restock backorder S8: «Sí, cancelar» / «No» under «¿Cancelo su pedido …?»,
 * bound to the backorder. Titles are the same in usted and tú.
 */
export function backorderCancelButtons(
  backorderId: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      { id: `${BACKORDER_CANCEL}:yes:${backorderId}`, title: 'Sí, cancelar' },
      {
        id: `${BACKORDER_CANCEL}:no:${backorderId}`,
        title: INTERACTIVE_BACKORDER_KEEP_TEXT,
      },
    ],
    prompt,
  };
}

/**
 * Restock backorder S8: which of several active backorders to cancel. Up to
 * three are reply buttons titled by folio; four to ten (the cap) are a list
 * with the count and product as the row description. `null` below two.
 */
export function backorderCancelPick(
  options: ReadonlyArray<{ id: string; folio: string; description: string }>,
  prompt: string,
): CustomerReplyInteractive | null {
  if (options.length < 2) return null;
  const usable = options.slice(0, INTERACTIVE_LIMITS.rows);
  if (usable.length <= INTERACTIVE_LIMITS.buttons)
    return {
      type: 'buttons',
      buttons: usable.map((option) => ({
        id: `${BACKORDER_CANCEL}:pick:${option.id}`,
        title: fitInteractiveText(option.folio, INTERACTIVE_LIMITS.buttonTitle),
      })),
      prompt,
    };
  return {
    type: 'list',
    buttonText: 'Ver pedidos',
    rows: usable.map((option) => ({
      id: `${BACKORDER_CANCEL}:pick:${option.id}`,
      title: fitInteractiveText(option.folio, INTERACTIVE_LIMITS.rowTitle),
      description: fitInteractiveText(
        option.description,
        INTERACTIVE_LIMITS.rowDescription,
      ),
    })),
    prompt,
  };
}

/**
 * S2 (N1): buttons under the server-owned cart summary, bound to the cart
 * they were sent with. Titles are the same in usted and tú.
 */
export function cartNextStepButtons(
  reference: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      { id: `${CART_CONTINUE}:${reference}`, title: 'Seguir con la compra' },
      { id: `${CART_ADD_MORE}:${reference}`, title: 'Agregar algo más' },
    ],
    prompt,
  };
}

/**
 * Retest S4 (N15): «Envío a domicilio» / «Recoger en tienda» under the
 * delivery-or-pickup question, bound to the cart it was asked for. Titles
 * are the same in usted and tú.
 */
export function fulfilmentChoiceButtons(
  reference: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      {
        id: `${FULFIL_DELIVERY}:${reference}`,
        title: INTERACTIVE_FULFIL_DELIVERY_TEXT,
      },
      {
        id: `${FULFIL_PICKUP}:${reference}`,
        title: INTERACTIVE_FULFIL_PICKUP_TEXT,
      },
    ],
    prompt,
  };
}

/**
 * S2: buttons under the server-owned reorder offer, bound to its reference.
 * Titles are in usted; the caller applies the customer's register.
 */
export function reorderConfirmationButtons(
  reference: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      { id: `${REORDER_CONFIRM}:${reference}`, title: '✅ Sí, agréguelo' },
      { id: REORDER_CHANGE, title: '✏️ Cambiar algo' },
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

/**
 * Restock backorder T5b: «Sí, agendar» / «No, gracias» under the offer to
 * schedule an expired backorder again, bound to the backorder. Titles are the
 * same in usted and tú.
 */
export function backorderRescheduleButtons(
  backorderId: string,
  prompt: string,
): CustomerReplyInteractive {
  return {
    type: 'buttons',
    buttons: [
      { id: `${BACKORDER_RESCHEDULE}:${backorderId}`, title: 'Sí, agendar' },
      {
        id: `${BACKORDER_RESCHEDULE_DECLINE}:${backorderId}`,
        title: INTERACTIVE_BACKORDER_RESCHEDULE_DECLINE_TEXT,
      },
    ],
    prompt,
  };
}
