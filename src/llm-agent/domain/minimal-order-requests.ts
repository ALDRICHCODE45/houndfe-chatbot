/**
 * Deterministic readings of two customer messages the minimal route answers
 * without the model once an order exists (S5 order summary, S6 payment
 * question). Whole-message, accent-free and conservative: anything unclear
 * keeps going to the model.
 */

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const MAX_LENGTH = 100;

/** A previous order, not the current one: that is what getLastOrder serves. */
const PREVIOUS_ORDER =
  /\b(?:anterior(?:es)?|pasad[oa]s?|previ[oa]s?|ultim[oa]s?|vez pasada|de siempre|lo mismo|otra vez|repet\w*)\b/;

const SUMMARY_NOUN = String.raw`(?:pedido|compra|orden|carrito)`;
/** «mi resumen», «el resumen de mi pedido», «resumen de mi compra». */
const SUMMARY_WORD = new RegExp(
  String.raw`\b(?:mi\s+resumen|resumen\s+(?:de|del)\s+(?:mi|el|su)\s+${SUMMARY_NOUN})\b|^(?:el\s+)?resumen$`,
);
/**
 * «ver mi pedido», «muéstrame mi pedido». Not «revisar mi compra» (the
 * reviewCheckout flow) nor the cart («muéstrame mi carrito» is getCart).
 */
const SEE_ORDER =
  /\b(?:ver|ve|veo|muestra(?:me)?|mostrar(?:me)?|ensena(?:me)?|ensenar(?:me)?)\s+(?:el|mi|su)\s+(?:pedido|orden)\b/;

/**
 * The customer asks to see the CURRENT order: its pending summary, the cart
 * or the order just placed ("mi resumen", "ver mi pedido"). Asking for a
 * previous order ("pedido anterior", "la última vez") is not this request.
 */
export function isOrderSummaryRequest(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return false;
  const rest = normalize(text);
  if (rest === '' || PREVIOUS_ORDER.test(rest)) return false;
  return SUMMARY_WORD.test(rest) || SEE_ORDER.test(rest);
}

const PAYMENT_QUESTION: readonly RegExp[] = [
  /\bcomo\s+(?:\w+\s+){0,2}(?:pago|pagar|pagarlo|se paga|se puede pagar)\b/,
  /\bclabe\b/,
  /\b(?:numero de cuenta|datos? bancari\w*|cuenta bancaria)\b/,
  /\ba que cuenta\b/,
  /\bcuenta\s+(?:para|de)\s+(?:pagar|transferir|deposit\w*|transferencia)\b/,
  /\bdatos?\s+(?:de|para)\s+(?:pago|pagar|la transferencia|transferencia|transferir)\b/,
  /\b(?:forma|formas|metodo|metodos)\s+de\s+pago\b/,
  /\b(?:quiero|prefiero|deseo|voy a)\s+pagar\b/,
  /^(?:pagar\s+)?(?:por|con)?\s*transferencia$/,
];

/**
 * Retest S3 (N19): the customer says they still owe part of the order or
 * want to pay another amount («me faltó pagar el resto», «la diferencia»,
 * «otro pago»). Such a message gets the bank details even while a receipt
 * is in review.
 */
const PAY_MORE: readonly RegExp[] = [
  /\b(?:el|lo)\s+(?:resto|restante|faltante)\b/,
  /\blo\s+que\s+(?:me\s+|le\s+|te\s+)?falt\w*\b/,
  /\bfalt\w*\s+(?:por\s+)?(?:pagar|depositar|transferir|abonar)\b/,
  /\bla\s+diferencia\b/,
  /\b(?:otro|segundo)\s+(?:pago|deposito|abono)\b/,
  /\b(?:otra|segunda)\s+(?:transferencia|cantidad)\b/,
  /\botro\s+monto\b/,
  /\b(?:pagar|depositar|transferir|abonar)\s+(?:mas|lo\s+demas)\b/,
  /\bcomplet\w*\s+(?:el|mi|su)\s+pago\b/,
];

export function isPayRemainderRequest(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return false;
  const rest = normalize(text);
  return rest !== '' && PAY_MORE.some((pattern) => pattern.test(rest));
}

/** A payment-method or "how do I pay" message after an order exists. */
export function isPaymentQuestion(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return false;
  const rest = normalize(text);
  return rest !== '' && PAYMENT_QUESTION.some((pattern) => pattern.test(rest));
}
