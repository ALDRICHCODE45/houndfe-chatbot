import type { BackorderBot } from '../../backorders/domain/backorder';

/**
 * Restock backorder S1/S2/S14: the exact customer copy of the answering turn,
 * in usted (the tú variants are curated phrase pairs in `customer-style.ts`).
 * Server-owned data only: names, folio, price and dates come from the
 * backend's backorder, never from the model.
 */

export const BACKORDER_TIME_ZONE = 'America/Mexico_City';

export const BACKORDER_DECLINE_REPLY = 'Entendido. ¡Que esté muy bien!';
/** S14: no count was stated when asking. */
export const BACKORDER_ASK_QUANTITY_REPLY = '¿Cuántas piezas le aparto?';
export const BACKORDER_ASK_NAME_REPLY = '¿A nombre de quién lo agendo?';
/** Nothing could be scheduled, and trying again may work. */
export const BACKORDER_RETRY_REPLY =
  'No pude agendar su pedido en este momento. Intente de nuevo en unos minutos.';
/** Nothing could be scheduled, and the same request would fail again. */
export const BACKORDER_FAILED_REPLY = 'No pude agendar su pedido por ahora.';

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "27 de noviembre" in Mexico City time; with the year when it is not this one. */
export function backorderDate(iso: string, now: Date): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BACKORDER_TIME_ZONE,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const thisYear = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: BACKORDER_TIME_ZONE,
      year: 'numeric',
    }).format(now),
  );
  const date = `${part('day')} de ${MONTHS[part('month') - 1]}`;
  return part('year') === thisYear ? date : `${date} de ${part('year')}`;
}

const label = (backorder: Pick<BackorderBot, 'productName' | 'variantName'>) =>
  backorder.variantName === null
    ? backorder.productName
    : `${backorder.productName} (${backorder.variantName})`;

/**
 * S1/S2: the confirmation states the folio, the count, the product and the
 * reference price. The 24 h reservation is NOT mentioned (it ships with the
 * backend's arrival matching). A past estimate has no date to promise.
 */
export function backorderScheduledReply(
  backorder: Pick<
    BackorderBot,
    | 'folio'
    | 'quantity'
    | 'productName'
    | 'variantName'
    | 'referencePriceCents'
    | 'estimatedAt'
  >,
  now: Date,
): string {
  const date =
    Date.parse(backorder.estimatedAt) > now.getTime()
      ? backorderDate(backorder.estimatedAt, now)
      : null;
  return (
    `Listo, quedó agendado su pedido ${backorder.folio}: ${backorder.quantity} × ` +
    `${label(backorder)} a ${mxn(backorder.referencePriceCents)} c/u. ` +
    `Le aviso en cuanto llegue${date === null ? '' : ` (aprox. el ${date})`}; ` +
    'no paga nada hasta entonces.'
  );
}

/** 409 STOCK_AVAILABLE_NOW: the stock came back while the customer decided. */
export function backorderAvailableNowReply(productName: string): string {
  return (
    `¡Buenas noticias! Ya tenemos ${productName} disponible. ` +
    '¿Cuántas piezas le agrego al carrito?'
  );
}

/** 409 BACKORDER_DUPLICATE: an active backorder already exists. */
export function backorderDuplicateReply(
  backorder: Pick<BackorderBot, 'folio' | 'productName' | 'variantName'> | null,
): string {
  return backorder === null
    ? 'Ya tiene agendado ese producto. Le aviso en cuanto llegue.'
    : `Ya tiene agendado su pedido ${backorder.folio} de ${label(backorder)}. Le aviso en cuanto llegue.`;
}
