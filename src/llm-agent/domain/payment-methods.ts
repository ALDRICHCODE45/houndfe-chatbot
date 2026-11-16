/**
 * Payment methods the bot offers after an order is placed. One list drives
 * the offer buttons, the button ids and the free-text answer to the offer, so
 * a new method (e.g. Mercado Pago) is one entry here plus its handler.
 */
export interface PaymentMethod {
  /** Stable id used in the button id; never shown to the customer. */
  id: string;
  /** Button title (≤ 20 chars, same in usted and tú). */
  title: string;
  /** Lowercase, accent-free words a customer may answer with. */
  aliases: readonly string[];
}

export const PAYMENT_METHODS: readonly PaymentMethod[] = Object.freeze([
  { id: 'transfer', title: 'Transferencia', aliases: ['transferencia'] },
]);

export function paymentMethodById(id: string): PaymentMethod | null {
  return PAYMENT_METHODS.find((method) => method.id === id) ?? null;
}

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** "transferencia", "por transferencia", "pagar con transferencia"… */
const LEAD_IN =
  /^(?:(?:quiero|prefiero|deseo|voy a|me gustaria)\s+)?(?:(?:pagar|pago)\s+)?(?:(?:por|con|mediante|en)\s+)?(?:la\s+)?/;

/** The method a whole-message answer names, else `null`. */
export function matchPaymentMethod(text: unknown): PaymentMethod | null {
  if (typeof text !== 'string' || text.length > 80) return null;
  const rest = normalize(text).replace(LEAD_IN, '');
  return PAYMENT_METHODS.find((m) => m.aliases.includes(rest)) ?? null;
}
