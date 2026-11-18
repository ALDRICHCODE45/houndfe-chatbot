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

const TRANSFER: PaymentMethod = Object.freeze({
  id: 'transfer',
  title: 'Transferencia',
  aliases: Object.freeze(['transferencia']),
});

/** Pay in store (S3): pickup orders only, behind PAY_IN_STORE_ENABLED. */
export const PAY_IN_STORE_METHOD: PaymentMethod = Object.freeze({
  id: 'in_store',
  title: 'Pagar en tienda',
  aliases: Object.freeze(['tienda', 'sucursal']),
});

/** The default offer (every order): today's single method. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = Object.freeze([
  TRANSFER,
]);

/** Every method a button id may name (an offer shows a subset). */
const KNOWN_METHODS: readonly PaymentMethod[] = Object.freeze([
  TRANSFER,
  PAY_IN_STORE_METHOD,
]);

/** The methods offered for one placed order. */
export function paymentMethodsFor(options: {
  payInStore: boolean;
}): readonly PaymentMethod[] {
  return options.payInStore ? KNOWN_METHODS : PAYMENT_METHODS;
}

export function paymentMethodById(id: string): PaymentMethod | null {
  return KNOWN_METHODS.find((method) => method.id === id) ?? null;
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

/** The offered method a whole-message answer names, else `null`. */
export function matchPaymentMethod(
  text: unknown,
  methods: readonly PaymentMethod[] = PAYMENT_METHODS,
): PaymentMethod | null {
  if (typeof text !== 'string' || text.length > 80) return null;
  const rest = normalize(text).replace(LEAD_IN, '');
  return methods.find((m) => m.aliases.includes(rest)) ?? null;
}
