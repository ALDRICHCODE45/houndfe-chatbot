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

// --- T6: replay of a decision whose backorder is no longer active ---------

/** «el 21 de noviembre a las 9:00 a. m.» in Mexico City time. */
export function backorderDateTime(iso: string, now: Date): string | null {
  const day = backorderDate(iso, now);
  const at = new Date(iso);
  if (day === null || Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BACKORDER_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(at);
  const part = (type: string) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const period = part('dayPeriod').toUpperCase() === 'PM' ? 'p. m.' : 'a. m.';
  return `el ${day} a las ${part('hour')}:${part('minute')} ${period}`;
}

/** The backorder states that still wait for the customer or for stock. */
export const isActiveBackorder = (backorder: Pick<BackorderBot, 'status'>) =>
  backorder.status === 'WAITING' || backorder.status === 'RESERVED';

/**
 * L11 note 2: a replayed create (200) can answer a backorder that is no
 * longer active. «Quedó agendado» would be false, so the reply states what
 * the backend says. Nothing is rescheduled here.
 */
export function backorderInactiveReply(
  backorder: Pick<BackorderBot, 'folio' | 'status'>,
): string {
  switch (backorder.status) {
    case 'CANCELLED':
      return `Su pedido ${backorder.folio} ya estaba cancelado, así que no está agendado.`;
    case 'EXPIRED':
      return `Su pedido ${backorder.folio} ya venció, así que no está agendado.`;
    case 'CONFIRMED':
      return `Su pedido ${backorder.folio} ya está confirmado.`;
    default:
      return BACKORDER_FAILED_REPLY;
  }
}

// --- T6 / S8: customer cancel and status from the chat ---------------------

export const BACKORDER_CANCEL_FAILED_REPLY = 'No pude cancelarlo por ahora.';
export const BACKORDER_STATUS_FAILED_REPLY =
  'No pude consultar su pedido por ahora.';
/** Short body of the pick list when the full text exceeds Meta's limit. */
export const BACKORDER_CANCEL_PICK_PROMPT = '¿Cuál pedido desea cancelar?';
export const BACKORDER_CANCEL_YES_TITLE = 'Sí, cancelar';
export const BACKORDER_CANCEL_NO_TITLE = 'No';

type Labelled = Pick<
  BackorderBot,
  'folio' | 'quantity' | 'productName' | 'variantName'
>;

/** S8: asked once, naming the backorder. */
export function backorderCancelQuestion(backorder: Labelled): string {
  return `¿Cancelo su pedido ${backorder.folio} de ${backorder.quantity} × ${label(backorder)}?`;
}

/** Short body of the confirm buttons when the question is too long. */
export function backorderCancelPrompt(backorder: Pick<Labelled, 'folio'>) {
  return `¿Cancelo su pedido ${backorder.folio}?`;
}

export function backorderCancelledReply(
  backorder: Pick<BackorderBot, 'folio'>,
): string {
  return `Listo, cancelé su pedido ${backorder.folio}.`;
}

export function backorderCancelKeptReply(
  backorder: Pick<BackorderBot, 'folio'>,
): string {
  return `Entendido, su pedido ${backorder.folio} sigue agendado.`;
}

/** 409 BACKORDER_NOT_CANCELLABLE for a state that is not CANCELLED. */
export function backorderNotCancellableReply(
  backorder: Pick<BackorderBot, 'folio'>,
  status: string | null,
): string {
  if (status === 'EXPIRED')
    return `Su pedido ${backorder.folio} ya venció, así que no hay nada que cancelar.`;
  if (status === 'CONFIRMED')
    return `Su pedido ${backorder.folio} ya está confirmado, así que ya no puedo cancelarlo desde aquí.`;
  return BACKORDER_CANCEL_FAILED_REPLY;
}

/** Several active backorders: the text lists them, the buttons/rows pick. */
export function backorderCancelPickReply(
  backorders: readonly Labelled[],
): string {
  return [
    'Tiene varios pedidos por reposición. ¿Cuál desea cancelar?',
    ...backorders.map(
      (backorder) =>
        `• ${backorder.folio}: ${backorder.quantity} × ${label(backorder)}`,
    ),
  ].join('\n');
}

const waitingLine = (
  backorder: Pick<BackorderBot, 'folio' | 'estimatedAt'>,
  now: Date,
): string => {
  const date =
    Date.parse(backorder.estimatedAt) > now.getTime()
      ? backorderDate(backorder.estimatedAt, now)
      : null;
  return date === null
    ? `Su pedido ${backorder.folio} sigue en espera; estamos confirmando la fecha con el equipo. Le aviso en cuanto llegue.`
    : `Su pedido ${backorder.folio} sigue en espera; llega aprox. el ${date}. Le aviso en cuanto llegue.`;
};

/** «a. m.» already ends with its period: never «a. m..». */
const endSentence = (text: string): string =>
  text.endsWith('.') ? text : `${text}.`;

const reservedWhen = (
  backorder: Pick<BackorderBot, 'reservedUntil'>,
  now: Date,
): string | null =>
  backorder.reservedUntil !== null &&
  Date.parse(backorder.reservedUntil) > now.getTime()
    ? backorderDateTime(backorder.reservedUntil, now)
    : null;

/**
 * S8 status of ONE active backorder. T5 owns the arrival notice and the
 * confirm checkout, so a RESERVED answer only says it is set aside.
 */
export function backorderStatusReply(
  backorder: Pick<
    BackorderBot,
    'folio' | 'status' | 'estimatedAt' | 'reservedUntil'
  >,
  now: Date,
): string {
  if (backorder.status === 'RESERVED') {
    const when = reservedWhen(backorder, now);
    return when === null
      ? '¡Ya llegó! Estamos confirmando con el equipo hasta cuándo se lo tenemos apartado.'
      : `¡Ya llegó! Se lo tenemos apartado hasta ${endSentence(when)}`;
  }
  return waitingLine(backorder, now);
}

/** S8 status of several active backorders, one line each (folio named). */
export function backorderStatusListReply(
  backorders: readonly Pick<
    BackorderBot,
    'folio' | 'status' | 'estimatedAt' | 'reservedUntil'
  >[],
  now: Date,
): string {
  const shown = backorders.slice(0, 5);
  const lines = shown.map((backorder) => {
    if (backorder.status !== 'RESERVED') return waitingLine(backorder, now);
    const when = reservedWhen(backorder, now);
    return when === null
      ? `Su pedido ${backorder.folio} ya llegó; estamos confirmando con el equipo hasta cuándo se lo tenemos apartado.`
      : `Su pedido ${backorder.folio} ya llegó y se lo tenemos apartado hasta ${endSentence(when)}`;
  });
  const more = backorders.length - shown.length;
  return [
    'Tiene varios pedidos por reposición:',
    ...lines,
    ...(more > 0 ? [`Y ${more} más.`] : []),
  ].join('\n');
}
