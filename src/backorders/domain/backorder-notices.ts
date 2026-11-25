import {
  applyCustomerStyle,
  type CustomerStyle,
} from '../../customer-profile/domain/notice-style';
import {
  backorderDate,
  backorderDateTime,
  backorderItemLines,
} from '../../llm-agent/domain/backorder-copy';
import { bold, money, plain } from '../../llm-agent/domain/whatsapp-format';

/**
 * Restock backorder T5a: the customer copy of the `backorder.*` feed notices
 * (docs/minimal-backorder.md, "Notices"), in usted. Server-owned data only:
 * names, folio, price and dates come from the feed item, never from a model.
 *
 * Skeletons carry `{placeholders}` that are filled AFTER the register is
 * applied, so a product or first name is never rewritten by a phrase pair
 * (a product called «Su pedido Premium» stays as it is).
 *
 * Message formatting F3c (S2, S4): the multi-fact notices carry their
 * WhatsApp layout in the skeleton (bold folio and deadline, the item block,
 * the closing question apart); names and products are `plain` values and
 * amounts are «$1,250.00». The Meta templates and their one-line
 * parameters (`backorderMoney`, `backorderLabel`) stay as approved.
 */

// ------------------------------------------------------------- buttons

/** Reply buttons are tapped by id; T5b parses `backorder_confirm` and the two
 *  reschedule ids, T6a parses `backorder_cancel:pick` (customer-reply.ts). */
export const BACKORDER_CONFIRM_TITLE = 'Confirmar pedido';
export const BACKORDER_NO_LONGER_TITLE = 'Ya no lo quiero';
export const BACKORDER_RESCHEDULE_TITLE = 'Sí, agéndalo';
export const BACKORDER_RESCHEDULE_DECLINE_TITLE = 'No, gracias';
export const BACKORDER_WAIT_TITLE = 'Seguir esperando';

export const backorderConfirmButtonId = (backorderId: string): string =>
  `backorder_confirm:${backorderId}`;
/** The «Ya no lo quiero» tap is T6a's cancel-pick: it leads to its
 *  «¿Cancelo su pedido …?» question. */
export const backorderCancelPickButtonId = (backorderId: string): string =>
  `backorder_cancel:pick:${backorderId}`;
export const backorderRescheduleButtonId = (backorderId: string): string =>
  `backorder_reschedule:${backorderId}`;
/** S7: «Seguir esperando» is answered locally by the manage service. */
export const backorderWaitButtonId = (backorderId: string): string =>
  `backorder_wait:${backorderId}`;
export const backorderRescheduleDeclineButtonId = (
  backorderId: string,
): string => `backorder_reschedule_decline:${backorderId}`;

export const backorderConfirmButtons = (
  backorderId: string,
): ReadonlyArray<{ id: string; title: string }> => [
  { id: backorderConfirmButtonId(backorderId), title: BACKORDER_CONFIRM_TITLE },
  {
    id: backorderCancelPickButtonId(backorderId),
    title: BACKORDER_NO_LONGER_TITLE,
  },
];

/** S7: the two buttons of the ETA-slip notices. */
export const backorderEtaButtons = (
  backorderId: string,
): ReadonlyArray<{ id: string; title: string }> => [
  { id: backorderWaitButtonId(backorderId), title: BACKORDER_WAIT_TITLE },
  {
    id: backorderCancelPickButtonId(backorderId),
    title: BACKORDER_NO_LONGER_TITLE,
  },
];

export const backorderRescheduleButtons = (
  backorderId: string,
): ReadonlyArray<{ id: string; title: string }> => [
  {
    id: backorderRescheduleButtonId(backorderId),
    title: BACKORDER_RESCHEDULE_TITLE,
  },
  {
    id: backorderRescheduleDeclineButtonId(backorderId),
    title: BACKORDER_RESCHEDULE_DECLINE_TITLE,
  },
];

// ---------------------------------------------------------------- copy

export const BACKORDER_CONFIRM_QUESTION = '¿Lo confirmamos?';
export const BACKORDER_RESCHEDULE_QUESTION =
  '¿Quiere que se lo vuelva a agendar?';

/** S7: asked under both ETA-slip notices (and the short body of the buttons). */
export const BACKORDER_ETA_QUESTION = '¿Seguimos con su pedido?';

/** Phrases the shared `customer-style.ts` pairs do not cover (the notices
 *  say «Se lo apartamos», «Le recuerdo», «le aviso en cuanto llegue», …).
 *  Applied before the shared pairs for tú customers. */
const TU_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Le recuerdo que su pedido', 'Te recuerdo que tu pedido'],
  ['Se lo apartamos', 'Te lo apartamos'],
  [BACKORDER_RESCHEDULE_QUESTION, '¿Quieres que te lo vuelva a agendar?'],
  ['el lote que le apartamos', 'el lote que te apartamos'],
  ['le aviso en cuanto llegue', 'te aviso en cuanto llegue'],
  ['le actualizo su pedido', 'te actualizo tu pedido'],
  ['Le actualizo su pedido', 'Te actualizo tu pedido'],
  [
    'Se lo aparto en cuanto llegue y le aviso',
    'Te lo aparto en cuanto llegue y te aviso',
  ],
  ['Con gusto se lo tengo listo', 'Con gusto te lo tengo listo'],
  [BACKORDER_ETA_QUESTION, '¿Seguimos con tu pedido?'],
  ['Su lugar sigue apartado', 'Tu lugar sigue apartado'],
  ['se lo separo y le aviso', 'te lo separo y te aviso'],
];

/** A skeleton in the customer's style, then its `{placeholders}` filled. */
export function renderNotice(
  skeleton: string,
  values: Readonly<Record<string, string>>,
  style: CustomerStyle | null,
): string {
  let text = skeleton;
  if (style !== null) {
    if (style.register === 'tu')
      for (const [usted, tu] of TU_PAIRS) text = text.split(usted).join(tu);
    text = applyCustomerStyle(text, style);
  }
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

/** `$1099.00 MXN`: the approved template parameters only (S9); the free
 *  notices use the shared `money()` («$1,099.00»). */
export const backorderMoney = (cents: number): string =>
  `$${(cents / 100).toFixed(2)} MXN`;

/** `Croquetas (18 kg)`: the product with its presentation. */
export const backorderLabel = (
  productName: string,
  variantName: string | null,
): string =>
  variantName === null ? productName : `${productName} (${variantName})`;

/** «a. m.» already ends with its period: never «a. m..». */
const endSentence = (text: string): string =>
  text.endsWith('.') ? text : `${text}.`;

/** A first name as shown (`plain`); `''` when absent or emptied. */
const firstNameText = (firstName: string | null): string =>
  firstName === null ? '' : plain(firstName);

/** «, Ana» after «¡Buenas noticias» / «Una disculpa», or nothing. */
const greeting = (firstName: string | null): string => {
  const name = firstNameText(firstName);
  return name === '' ? '' : `, ${name}`;
};

/** «el 21 de noviembre a las 9:00 a. m.» (Mexico City), `null` if unreadable. */
export const backorderDeadline = (iso: string, now: Date): string | null =>
  backorderDateTime(iso, now);

/** «27 de noviembre» when the estimate is still ahead, else `null`. */
export function backorderEstimateDate(
  iso: string | null,
  now: Date,
): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) || at <= now.getTime()
    ? null
    : backorderDate(iso, now);
}

export interface ReservedNoticeInput {
  firstName: string | null;
  folio: string;
  quantity: number;
  label: string;
  finalPriceCents: number;
  referencePriceCents: number | null;
  /** Output of `backorderDeadline`. */
  deadline: string;
}

/** S6: the arrival summary (product, quantity, price, deadline). */
export function reservedNotice(
  input: ReservedNoticeInput,
  style: CustomerStyle | null,
): string {
  const lowered =
    input.referencePriceCents !== null &&
    input.finalPriceCents < input.referencePriceCents;
  return renderNotice(
    '¡Buenas noticias{greeting}! Ya llegó su pedido *{folio}*.\n\n' +
      '{item}\n\n' +
      'Se lo apartamos hasta *{deadline}*\n\n' +
      '{question}',
    {
      greeting: greeting(input.firstName),
      folio: input.folio,
      item: backorderItemLines({
        label: input.label,
        quantity: input.quantity,
        unitPriceCents: input.finalPriceCents,
        note: lowered
          ? `Bajó de precio, antes ${money(input.referencePriceCents as number)}`
          : null,
      }).join('\n'),
      deadline: input.deadline,
      question: renderNotice(BACKORDER_CONFIRM_QUESTION, {}, style),
    },
    style,
  );
}

/** S4: the reminder before the 24 h hold lapses. */
export function reminderNotice(
  input: { folio: string; deadline: string },
  style: CustomerStyle | null,
): string {
  return renderNotice(
    'Le recuerdo que su pedido *{folio}* sigue apartado hasta *{deadline}*\n\n{question}',
    {
      folio: input.folio,
      deadline: input.deadline,
      question: renderNotice(BACKORDER_CONFIRM_QUESTION, {}, style),
    },
    style,
  );
}

/** S4: the hold lapsed; with a reschedule offer when the backend names the
 *  source decision (the buttons then answer it). */
export function expiredNotice(
  input: { folio: string; productName: string; offerReschedule: boolean },
  style: CustomerStyle | null,
): string {
  return renderNotice(
    input.offerReschedule
      ? `Se venció el apartado de su pedido *{folio}* ({product}).\n\n${BACKORDER_RESCHEDULE_QUESTION}`
      : 'Se venció el apartado de su pedido *{folio}* ({product}).',
    { folio: input.folio, product: plain(input.productName) },
    style,
  );
}

/** S12: the reserved lot expired and no valid one is left. */
export function lostNotice(
  input: {
    firstName: string | null;
    productName: string;
    folio: string;
    /** Output of `backorderEstimateDate`. */
    estimateDate: string | null;
  },
  style: CustomerStyle | null,
): string {
  return renderNotice(
    'Una disculpa{greeting}: el lote que le apartamos de {product} caducó y no tenemos otro vigente.\n\n' +
      'Su pedido *{folio}* sigue en primer lugar; le aviso en cuanto llegue{when}.',
    {
      greeting: greeting(input.firstName),
      product: plain(input.productName),
      folio: input.folio,
      when:
        input.estimateDate === null ? '' : ` (aprox. ${input.estimateDate})`,
    },
    style,
  );
}

/**
 * S7 (owner: «solo le estas diciendo al cliente que no ha llegado pero no
 * estas mostrando mucho interes realmente de venderle el producto»): the new
 * estimate, said with interest in selling. The date comes from the backend
 * (a human estimate, not a guarantee); an estimate already past, or unreadable,
 * is never shown: the team is still confirming it.
 */
export function etaUpdatedNotice(
  input: {
    firstName: string | null;
    folio: string;
    quantity: number;
    label: string;
    /** Output of `backorderEstimateDate`; `null` when past or unreadable. */
    estimateDate: string | null;
  },
  style: CustomerStyle | null,
): string {
  const name = firstNameText(input.firstName);
  const lead =
    name === '' ? 'Le actualizo su pedido' : '{name}, le actualizo su pedido';
  return renderNotice(
    `${lead} *{folio}*:\n• {quantity} × {label}\n{when}.\n\n` +
      'Se lo aparto en cuanto llegue y le aviso; sigue sin pagar nada hasta entonces. ' +
      `Con gusto se lo tengo listo.\n\n${BACKORDER_ETA_QUESTION}`,
    {
      name,
      folio: input.folio,
      quantity: String(input.quantity),
      label: plain(input.label),
      when:
        input.estimateDate === null
          ? 'El equipo está confirmando la nueva fecha de llegada'
          : `El equipo nos confirmó que llega aprox. el ${bold(input.estimateDate)}`,
    },
    style,
  );
}

/** S7: the supplier gave no date. Honest, and the place in the queue is kept. */
export function etaUnavailableNotice(
  input: { firstName: string | null; productName: string; folio: string },
  style: CustomerStyle | null,
): string {
  const name = firstNameText(input.firstName);
  const lead = name === '' ? 'El proveedor' : '{name}, el proveedor';
  return renderNotice(
    `${lead} todavía no nos confirma fecha para {product} (pedido *{folio}*).\n\n` +
      'Su lugar sigue apartado: en cuanto llegue se lo separo y le aviso.\n\n' +
      BACKORDER_ETA_QUESTION,
    {
      name,
      product: plain(input.productName),
      folio: input.folio,
    },
    style,
  );
}

/** Staff cancelled it; the staff's reason is verbatim, never restyled. */
export function cancelledNotice(
  input: { folio: string; reason: string | null },
  style: CustomerStyle | null,
): string {
  const head = renderNotice(
    'El equipo canceló su pedido *{folio}*',
    { folio: input.folio },
    style,
  );
  if (input.reason === null) return `${head}.`;
  return `${head}: ${endSentence(input.reason)}`;
}

// ------------------------------------------------------------ templates

/** Approved Meta template language (the owner creates them in `es_MX`). */
export const BACKORDER_TEMPLATE_LANGUAGE = 'es_MX';

/** Defaults; every name is configurable (docs/minimal-backorder.md). */
export const BACKORDER_TEMPLATE_DEFAULTS = {
  reserved: 'pedido_reposicion_llego',
  reminder: 'pedido_reposicion_recordatorio',
  expired: 'pedido_reposicion_vencido',
  lost: 'pedido_reposicion_lote',
  etaUpdated: 'pedido_reposicion_fecha',
  etaUnavailable: 'pedido_reposicion_sin_fecha',
} as const;

export type BackorderTemplateNames = {
  -readonly [K in keyof typeof BACKORDER_TEMPLATE_DEFAULTS]: string;
};

/** A template parameter: one line, trimmed, ≤ 1024 chars; `null` when empty
 *  (Meta refuses an empty value). */
export function templateParameter(value: string): string | null {
  const line = value.replace(/\s+/g, ' ').trim().slice(0, 1024).trim();
  return line === '' ? null : line;
}
