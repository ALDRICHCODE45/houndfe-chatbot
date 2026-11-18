import type { CheckoutPickupLocation } from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  atTime,
  formatClock,
  formatDay,
  zonedParts,
} from '../../scheduling/domain/slot-time';

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
 * `{tienda}`: name, address and hours of the pickup branch, the same
 * pieces the order-created reply shows ("Sucursal Centro: Av. Juárez 123,
 * Centro. Horario: Lunes a sábado: 09:00–18:00"), without the final dot
 * (the sentence adds it). Unknown → "la tienda"; null parts are omitted.
 */
export function payInStoreStoreText(
  location: CheckoutPickupLocation | null | undefined,
): string {
  if (location === null || location === undefined) return 'la tienda';
  const place =
    location.address === null
      ? location.name
      : `${location.name}: ${withoutFinalDot(location.address.formatted)}`;
  return withoutFinalDot(
    location.hours === null
      ? place
      : `${place}. Horario: ${location.hours.summary}`,
  );
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

/** A clause that may end in "p. m." gets no second dot. */
const endSentence = (text: string): string =>
  text.endsWith('.') ? text : `${text}.`;

const order = (folio: string | null): string =>
  folio === null || folio === '' ? 'su pedido' : `su pedido ${folio}`;

/** The tap answer once the backend holds the order (S3). */
export function payInStoreHeldReply(input: {
  folio: string | null;
  holdUntil: string;
  location: CheckoutPickupLocation | null | undefined;
}): string {
  return (
    `${endSentence(`Listo, le apartamos ${order(input.folio)} hasta el ${payInStoreDateTime(input.holdUntil)}`)} ` +
    `Páselo a recoger y pagar en ${payInStoreStoreText(input.location)}. ` +
    'Si no pasa antes de esa fecha, el pedido se cancela.'
  );
}

/**
 * sale.pickup_reminder: "hasta hoy a las {hora}" ("a la 1:…" at 1 o'clock,
 * follow-ups S5). The reminder fires 3 h
 * before the deadline, normally the same local day; a deadline on another
 * day says "mañana" / the date instead of a wrong "hoy".
 */
export function pickupReminderText(input: {
  folio: string | null;
  holdUntil: string;
  location: CheckoutPickupLocation | null | undefined;
  now: Date;
}): string {
  const day = formatDay(input.holdUntil, PAY_IN_STORE_TIME_ZONE, input.now);
  // Follow-ups S5: «a la 1:00» (singular) / «a las 2:00».
  const at = atTime(formatClock(input.holdUntil, PAY_IN_STORE_TIME_ZONE));
  return (
    `${endSentence(`Le recordamos que ${order(input.folio)} está apartado hasta ${day} ${at}`)} ` +
    `Páselo a recoger y pagar en ${payInStoreStoreText(input.location)}.`
  );
}

/** sale.pickup_expired: the order was cancelled. */
export function pickupExpiredText(folio: string | null): string {
  const subject = order(folio).replace(/^su/, 'Su');
  return (
    `${subject} se canceló porque venció el plazo para recogerlo y pagarlo en tienda. ` +
    'Si todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.'
  );
}

/** sale.pickup_extended: staff moved the deadline. */
export function pickupExtendedText(input: {
  folio: string | null;
  holdUntil: string;
}): string {
  return endSentence(
    `Le ampliamos el plazo de ${order(input.folio)}: ahora puede recogerlo y pagarlo hasta el ${payInStoreDateTime(input.holdUntil)}`,
  );
}
