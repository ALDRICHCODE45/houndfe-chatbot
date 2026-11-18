/**
 * Retest 2026-11-18 S4 (N15): checkout start and the delivery-or-pickup
 * question.
 *
 * `isCheckoutStartRequest` recognizes ONLY a bare request to buy («quiero
 * comprar», «Seguir con la compra», «quiero hacer mi pedido»), optionally
 * with a leading «sí/ok» and a trailing «por favor». A message that already
 * says how the customer wants the order («quiero comprar para recoger en
 * tienda», «envíamelo a mi casa») or names a product («quiero comprar
 * croquetas») is not a bare request: it keeps today's route. Pure, no I/O.
 */

/** Usted copy; tú via customer-style. */
export const MINIMAL_FULFILMENT_QUESTION =
  '¿Se lo enviamos a su dirección o prefiere recogerlo en tienda?';

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LEAD = '(?:(?:si|ok|okay|va|bueno|listo|perfecto|claro|ya|entonces) )*';
const TAIL =
  '(?: (?:por favor|porfa|porfis|porfavor|ya|ahora|entonces|gracias))*';
const WANT = '(?:(?:yo )?(?:quiero|quisiera|deseo|me gustaria|voy a) )';
const OBJECT = '(?:(?:lo|la|los|las) )';
const ACTION =
  '(?:comprar(?:lo|la|los|las)?|hacer (?:mi|el) pedido|realizar (?:mi|el) pedido|(?:seguir|continuar|proceder) con (?:la|mi) compra|finalizar (?:la|mi) compra|terminar (?:la|mi) compra)';
const CHECKOUT_START = new RegExp(
  `^${LEAD}(?:${WANT}?${ACTION}|${OBJECT}${WANT}comprar|seguimos con (?:la|mi) compra)${TAIL}$`,
);

/** True for a bare request to start buying the current cart. */
export function isCheckoutStartRequest(text: string): boolean {
  return CHECKOUT_START.test(normalize(text));
}
