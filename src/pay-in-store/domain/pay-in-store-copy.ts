import type { CheckoutPickupLocation } from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  atTime,
  formatClock,
  formatDay,
  zonedParts,
} from '../../scheduling/domain/slot-time';
import { bold, storeLines } from '../../llm-agent/domain/whatsapp-format';

/**
 * Pay in store (odd/tasks/pay-in-store.md S3): the exact customer copy, in
 * usted (the tú variants are curated pairs in `customer-style.ts`). Times
 * are rendered in America/Mexico_City.
 */

export const PAY_IN_STORE_TIME_ZONE = 'America/Mexico_City';

/** Any other failure of the PATCH (fixed text, S3). */
export const PAY_IN_STORE_FAILED_REPLY =
  'No pude apartar su pedido en este momento; puede pagar por transferencia o intentarlo de nuevo en unos minutos.';

const withoutFinalDot = (text: string): string =>
  text.trim().replace(/\.+$/, '');

/**
 * The Meta utility templates of the sale.pickup_* notices sent outside the
 * 24 h window (odd/tasks/pay-in-store-templates.md S4; revised bodies in its L3).
 */
export const PAY_IN_STORE_TEMPLATES = {
  languageCode: 'es_MX',
  /** {{1}} folio, {{2}} deadline («hoy a las …»), {{3}} store. */
  reminder: 'apartado_recordatorio',
  /** {{1}} folio. */
  expired: 'apartado_vencido',
  /** {{1}} folio, {{2}} «el {fecha y hora}», {{3}} store. */
  updated: 'apartado_plazo_actualizado',
} as const;

/** The feed item's `branchName` when usable, else `null`. */
const branchNameText = (
  branchName: string | null | undefined,
): string | null =>
  typeof branchName === 'string' && branchName.trim() !== ''
    ? withoutFinalDot(branchName)
    : null;

/** "Sucursal Centro: Av. Juárez 123, Centro" (no final dot). */
const placeText = (location: CheckoutPickupLocation): string =>
  withoutFinalDot(
    location.address === null
      ? location.name
      : `${location.name}: ${withoutFinalDot(location.address.formatted)}`,
  );

/**
 * `{tienda}`: name, address and hours of the pickup branch, the same
 * pieces the order-created reply shows ("Sucursal Centro: Av. Juárez 123,
 * Centro. Horario: Lunes a sábado: 09:00–18:00"), without the final dot
 * (the sentence adds it). Null parts are omitted. Unknown location → the
 * feed item's `branchName` (templates S2), else "la tienda".
 */
export function payInStoreStoreText(
  location: CheckoutPickupLocation | null | undefined,
  branchName?: string | null,
): string {
  if (location === null || location === undefined)
    return branchNameText(branchName) ?? 'la tienda';
  const place = placeText(location);
  return withoutFinalDot(
    location.hours === null
      ? place
      : `${place}. Horario: ${location.hours.summary}`,
  );
}

/**
 * Template {{3}} (S4): branch name + address of the stored pickup location
 * (no hours: the template sentence is short); fallback `branchName`, then
 * "la tienda".
 */
export function payInStoreTemplateStoreText(
  location: CheckoutPickupLocation | null | undefined,
  branchName: string | null | undefined,
): string {
  if (location === null || location === undefined)
    return branchNameText(branchName) ?? 'la tienda';
  return placeText(location);
}

/** `{fecha y hora}`: "jueves 19 de noviembre a las 12:30 p. m." */
export function payInStoreDateTime(
  instant: string,
  timeZone = PAY_IN_STORE_TIME_ZONE,
): string {
  const date = new Date(instant);
  const { day } = zonedParts(date, timeZone);
  const names = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'long',
    month: 'long',
  }).formatToParts(date);
  const weekday =
    names.find((part) => part.type === 'weekday')?.value.toLowerCase() ?? '';
  const month =
    names.find((part) => part.type === 'month')?.value.toLowerCase() ?? '';
  return `${weekday} ${day} de ${month} ${atTime(formatClock(date, timeZone))}`;
}

/** «su pedido *B-1*» (message formatting S2: bold folio) / «su pedido». */
const order = (folio: string | null): string =>
  folio === null || folio === '' ? 'su pedido' : `su pedido ${bold(folio)}`;

/**
 * Message formatting S2: the store of the hold reply on its own lines, the
 * shared store block (F3b-fix H3): the bold branch name closing the
 * «Páselo…» sentence, then the address and the bold «Horario:» line (null
 * parts omitted). Unknown location → `fallbackName` (the feed item's
 * branch), else «la tienda.». Backend values are `plain`.
 */
function heldStoreLines(
  location: CheckoutPickupLocation | null | undefined,
  fallbackName?: string | null,
): string[] {
  return storeLines(
    'Páselo a recoger y pagar en ',
    location ?? { name: fallbackName ?? '', address: null, hours: null },
  );
}

/**
 * The tap answer once the backend holds the order (S3), in the message
 * formatting S2 layout: folio and deadline in bold, the store block, the
 * cancellation notice apart.
 */
export function payInStoreHeldReply(input: {
  folio: string | null;
  holdUntil: string;
  location: CheckoutPickupLocation | null | undefined;
}): string {
  const folio =
    input.folio === null || input.folio === ''
      ? 'su pedido'
      : `su pedido ${bold(input.folio)}`;
  return [
    `Listo, le apartamos ${folio} hasta el ${bold(payInStoreDateTime(input.holdUntil))}`,
    '',
    ...heldStoreLines(input.location),
    '',
    'Si no pasa antes de esa fecha, el pedido se cancela.',
  ].join('\n');
}

/**
 * sale.pickup_reminder: "hasta hoy a las {hora}" ("a la 1:…" at 1 o'clock,
 * follow-ups S5). The reminder fires 3 h
 * before the deadline, normally the same local day; a deadline on another
 * day says "mañana" / the date instead of a wrong "hoy". Message formatting
 * F3c: bold folio and deadline, then the shared store block (unknown
 * location → the feed item's branch name, else «la tienda.»).
 */
export function pickupReminderText(input: {
  folio: string | null;
  holdUntil: string;
  location: CheckoutPickupLocation | null | undefined;
  branchName?: string | null;
  now: Date;
}): string {
  const deadline = pickupReminderDeadline(input.holdUntil, input.now);
  return [
    `Le recordamos que ${order(input.folio)} está apartado hasta ${bold(deadline)}`,
    '',
    ...heldStoreLines(input.location, branchNameText(input.branchName)),
  ].join('\n');
}

/** The reminder deadline, «hoy a las 4:18 p. m.» / «mañana a las …» / the
 *  date (also template {{2}} of `apartado_recordatorio`). */
export function pickupReminderDeadline(holdUntil: string, now: Date): string {
  const day = formatDay(holdUntil, PAY_IN_STORE_TIME_ZONE, now);
  // Follow-ups S5: «a la 1:00» (singular) / «a las 2:00».
  const at = atTime(formatClock(holdUntil, PAY_IN_STORE_TIME_ZONE));
  return `${day} ${at}`;
}

/** sale.pickup_expired: the order was cancelled (F3c: the offer apart). */
export function pickupExpiredText(folio: string | null): string {
  const subject = order(folio).replace(/^su/, 'Su');
  return (
    `${subject} se canceló porque venció el plazo para recogerlo y pagarlo en tienda.\n\n` +
    'Si todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.'
  );
}

/** The direction of a staff deadline change (backend S2). */
export type PickupHoldDirection = 'EXTENDED' | 'SHORTENED';

/**
 * True when the deadline moved earlier: `direction` SHORTENED, or (no
 * direction, an older backend) a `previousHoldUntil` later than the new
 * deadline. Equal deadlines and missing data read as an extension.
 */
export function pickupHoldShortened(input: {
  holdUntil: string;
  previousHoldUntil?: string;
  direction?: PickupHoldDirection;
}): boolean {
  if (input.direction !== undefined) return input.direction === 'SHORTENED';
  if (input.previousHoldUntil === undefined) return false;
  return Date.parse(input.previousHoldUntil) > Date.parse(input.holdUntil);
}

/**
 * sale.pickup_extended: staff moved the deadline. Later → «Le ampliamos el
 * plazo …»; earlier → «Actualizamos el plazo …» (templates S3).
 */
export function pickupExtendedText(input: {
  folio: string | null;
  holdUntil: string;
  previousHoldUntil?: string;
  direction?: PickupHoldDirection;
}): string {
  const lead = pickupHoldShortened(input)
    ? 'Actualizamos el plazo de'
    : 'Le ampliamos el plazo de';
  // F3c: the bold deadline closes the sentence, as in the hold reply.
  return `${lead} ${order(input.folio)}: ahora puede recogerlo y pagarlo hasta el ${bold(payInStoreDateTime(input.holdUntil))}`;
}

/** «el {fecha y hora}» (also template {{2}} of
 *  `apartado_plazo_actualizado`). */
export function pickupNewDeadline(holdUntil: string): string {
  return `el ${payInStoreDateTime(holdUntil)}`;
}

/**
 * sale.pickup_expired_review (templates S2/S3): the hold expired with a
 * partial payment or a receipt in review, the sale is NOT cancelled and
 * staff will contact the customer.
 */
export function pickupExpiredReviewText(folio: string | null): string {
  return (
    `El plazo de ${order(folio)} venció.\n\n` +
    'Como tiene un pago registrado, alguien del equipo le va a contactar para cerrarlo.'
  );
}
