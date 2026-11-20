/**
 * Restock backorder S8: deterministic reading of two typed customer messages
 * about a SCHEDULED restock order («pedido por reposición»): cancel it, or
 * ask how it is going. Pure, whole-message, accent-free and conservative:
 * anything unclear is `null` and the turn keeps its other routes.
 *
 * Two strengths of wording:
 *
 *   - `explicit: true`: the message names the restock/apartado order
 *     («por reposición», «lo que aparté», «pedido agendado», a `BO-` folio).
 *     The caller may act on it whenever the customer has an active backorder.
 *   - `explicit: false`: only generic wording («ya no quiero el pedido»,
 *     «¿cómo va mi pedido?»). The caller must also rule out every other order
 *     or purchase in progress (cart, pending summary, placed sale) before it
 *     answers, because a placed-order or cart message reads the same.
 *
 * Never a request: a bare «cancela» / «no» (the confirmation gates own it),
 * cart removal («quita…», «elimina…»), a product the customer no longer wants
 * («ya no quiero las croquetas»), a negation («no quiero cancelar»), a policy
 * question about generic wording, or a previous order.
 */
export type BackorderRequest = {
  readonly kind: 'cancel' | 'status';
  readonly explicit: boolean;
};

const MAX_LENGTH = 140;

/** Lower case, no accents; punctuation becomes `|` so a clause never leaks. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[,;.:!?¿¡]+/g, ' | ')
    .replace(/[^\p{L}\p{N}|]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A previous order, not the current one. */
const PREVIOUS_ORDER =
  /\b(?:anterior(?:es)?|pasad[oa]s?|previ[oa]s?|ultim[oa]s?|vez pasada|de siempre)\b/;

/** The customer names the restock / apartado order. */
const EXPLICIT: readonly RegExp[] = [
  /\b(?:por|de|en|a)\s+(?:la\s+)?reposicion\b/,
  /\b(?:lo|el|la|los|las)\s+(?:pedido\s+)?que\s+(?:\w+\s+){0,2}?(?:aparte|apartaste|apartaron|apartamos|aparto|agende|agendaste|agendaron|agendamos|programe|programaron|reserve|reservaron)\b/,
  /\b(?:pedido|orden)\s+(?:apartad[oa]|agendad[oa]|programad[oa])\b/,
  /\b(?:lo|el|mi|su)\s+(?:apartad[oa]|agendad[oa]|programad[oa])\b/,
  /\bbo\s*\d{3,}\b/,
];

const CANCEL_VERB: readonly RegExp[] = [
  /\b(?:cancel\w*|anul\w*)\b/,
  /\bya\s+no\s+(?:lo\s+|la\s+|me\s+)?(?:quiero|necesito|voy\s+a\s+querer|interesa)\b/,
  /\bno\s+(?:lo\s+|la\s+)?(?:quiero|voy\s+a\s+querer|necesito)\s+(?:ya|mas)\b/,
];
/** «no quiero cancelar», «no cancele»: within the same clause. */
const CANCEL_NEGATED = /\bno\s+(?:\w+\s+){0,2}(?:cancel\w*|anul\w*)\b/;

const STATUS_PHRASE: readonly RegExp[] = [
  /\bcomo\s+(?:va|vamos|sigue|esta|anda|queda)\b/,
  /\ben\s+que\s+(?:va|paso|queda|estatus)\b/,
  /\bya\s+(?:llego|llegaron|esta\s+listo|esta\s+lista)\b/,
  /\bcuando\s+(?:llega|llegan|llegara|llegaran|me\s+llega|va\s+a\s+llegar)\b/,
  /\b(?:estatus|status|seguimiento)\b/,
  /\bque\s+paso\s+con\b/,
  /\bpara\s+cuando\b/,
];

/**
 * «ver mi pedido por reposición», «dime lo que aparté»: a request to SEE it.
 * Only with explicit wording: a bare «ver mi pedido» is the order summary.
 */
const STATUS_VIEW =
  /\b(?:ver|veo|ve|muestra(?:me)?|mostrar(?:me)?|ensena(?:me)?|dime|informacion|info)\b/;

/** «el pedido», «mi pedido»: the generic noun. */
const GENERIC_ORDER = /\b(?:el|mi|su|ese|este|nuestro)\s+pedido\b/;

/**
 * Classifies a typed message; `null` when it is not a cancel or status
 * request about a scheduled restock order.
 */
export function classifyBackorderRequest(
  text: unknown,
): BackorderRequest | null {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return null;
  const rest = normalize(text);
  if (rest === '') return null;
  const explicit = EXPLICIT.some((pattern) => pattern.test(rest));
  const generic = GENERIC_ORDER.test(rest);
  if (
    CANCEL_VERB.some((pattern) => pattern.test(rest)) &&
    !CANCEL_NEGATED.test(rest)
  ) {
    if (explicit) return { kind: 'cancel', explicit: true };
    // Generic wording is a command, never a question about policy, and never
    // a previous order.
    if (generic && !/[?¿]/.test(text) && !PREVIOUS_ORDER.test(rest))
      return { kind: 'cancel', explicit: false };
    return null;
  }
  if (STATUS_PHRASE.some((pattern) => pattern.test(rest))) {
    if (explicit) return { kind: 'status', explicit: true };
    if (generic && !PREVIOUS_ORDER.test(rest))
      return { kind: 'status', explicit: false };
  }
  if (explicit && STATUS_VIEW.test(rest))
    return { kind: 'status', explicit: true };
  return null;
}

/** The `BO-000012` folio a message names (3+ digits), or `null`. */
export function backorderFolioIn(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return null;
  const match = /\bbo\s*(\d{3,})\b/.exec(normalize(text));
  return match === null ? null : `BO-${match[1].padStart(6, '0')}`;
}
