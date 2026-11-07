import { randomUUID } from 'node:crypto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import type { OrderHistoryResponse } from '../../chatbot-api/domain/dtos/sales.dto';
import { NotFoundError } from '../../chatbot-api/domain/errors';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import type { ReorderOfferContext } from '../domain/minimal-catalog-session.store';
import { minimalLineLabel } from '../domain/minimal-order-confirmation';
import type { MinimalCartService } from './minimal-cart.service';

/**
 * S2 reorder: "Lo mismo de la vez pasada". The customer's last confirmed
 * order is re-read by productId/variantId/quantity only; every line is
 * re-checked against today's stock and re-priced through the cart quote
 * (evaluate-cart). Historical names and unit prices are never shown as a
 * price: what was paid is the sale total only.
 */
export const REORDER_EMPTY_REPLY =
  'Todavía no encuentro pedidos anteriores con este número. ¿Qué producto busca?';
export const REORDER_UNAVAILABLE_REPLY =
  'Disculpe, no pude consultar su pedido anterior en este momento. ¿Qué producto busca?';
export const REORDER_DECLINE_REPLY =
  'Entendido, no agregué nada a su carrito. ¿Qué producto busca?';
export const REORDER_CHANGE_REPLY =
  'Claro, ¿qué desea cambiar? Dígame qué productos y cuántos de cada uno.';
export const REORDER_NEXT_STEP =
  '¿Desea agregar algo más o seguimos con su compra?';
export const REORDER_BUTTONS_PROMPT = '¿Lo agrego a su carrito?';

export type MinimalReorderPresentation = {
  reply: string;
  /** Armed only when at least one line can be added today. */
  offer: ReorderOfferContext | null;
  /** Products this read verified (for later catalog tools). */
  productIds: string[];
};

type Line = {
  productId: string;
  variantId?: string;
  quantity: number;
  historicalUnitCents: number;
  historicalLabel: string;
};
type Unavailable = 'gone' | 'out_of_stock' | 'insufficient' | 'unverified';
type Checked =
  | { line: Line; status: 'available' }
  | { line: Line; status: Unavailable; label: string };

const UNAVAILABLE_SUFFIX: Record<Unavailable, string> = {
  gone: 'ya no está disponible',
  out_of_stock: 'agotado por ahora',
  insufficient: 'sin existencias suficientes',
  unverified: 'no puedo confirmar existencias',
};

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;
const empty = (reply: string): MinimalReorderPresentation => ({
  reply,
  offer: null,
  productIds: [],
});

const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

function mexicoCityDate(date: Date): {
  day: number;
  month: number;
  year: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return { day: part('day'), month: part('month'), year: part('year') };
}

/** "20 oct" in Mexico City time; the year only when it is not this one. */
export function shortOrderDate(iso: string | null, now: Date): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const { day, month, year } = mexicoCityDate(date);
  const label = `${day} ${MONTHS[month - 1]}`;
  return year === mexicoCityDate(now).year ? label : `${label} ${year}`;
}

/** Same product/presentation lines of one order merged, in order. */
function orderLines(order: OrderHistoryResponse): Line[] {
  const lines: Line[] = [];
  for (const item of order.items) {
    const variantId = item.variantId ?? undefined;
    const same = lines.find(
      (line) =>
        line.productId === item.productId && line.variantId === variantId,
    );
    if (same !== undefined) {
      same.quantity += item.quantity;
      continue;
    }
    lines.push({
      productId: item.productId,
      ...(variantId === undefined ? {} : { variantId }),
      quantity: item.quantity,
      historicalUnitCents: item.unitPriceCents,
      historicalLabel: minimalLineLabel(item.productName, item.variantName),
    });
  }
  return lines;
}

/** Today's availability of one line from its stock read. */
function checkLine(line: Line, stock: StockCheckResponse): Checked {
  if (stock.productId !== line.productId)
    return { line, status: 'gone', label: line.historicalLabel };
  const variant =
    line.variantId === undefined
      ? undefined
      : stock.variants.find((v) => v.variantId === line.variantId);
  if (
    (line.variantId !== undefined && variant === undefined) ||
    (line.variantId === undefined && stock.variants.length > 0)
  )
    return { line, status: 'gone', label: line.historicalLabel };
  const label = minimalLineLabel(stock.name, variant?.name);
  const inventory = variant?.stock ?? stock.stock;
  const quantity = inventory.quantity;
  if (
    inventory.status === 'out_of_stock' ||
    (typeof quantity === 'number' && quantity <= 0)
  )
    return { line, status: 'out_of_stock', label };
  if (
    !['available', 'low_stock'].includes(inventory.status) ||
    typeof quantity !== 'number'
  )
    return { line, status: 'unverified', label };
  if (quantity < line.quantity) return { line, status: 'insufficient', label };
  return { line, status: 'available' };
}

/**
 * The deterministic reorder presentation for a sender: the last order with
 * today's names, availability and price, plus the offer a yes may add.
 * Never throws; any read failure is the apology, never invented items.
 */
export async function prepareMinimalReorder(
  api: ChatbotApiClient,
  cart: MinimalCartService,
  senderId: string,
  now: Date,
): Promise<MinimalReorderPresentation> {
  const phone = parseMexicanWhatsAppPhone(senderId);
  if (phone === null) return empty(REORDER_EMPTY_REPLY);
  let history: OrderHistoryResponse[];
  try {
    history = await api.getOrderHistory(phone.phone, phone.phoneCountryCode);
  } catch {
    return empty(REORDER_UNAVAILABLE_REPLY);
  }
  const last = history.find((order) => order.items.length > 0);
  if (last === undefined) return empty(REORDER_EMPTY_REPLY);
  const checked: Checked[] = [];
  for (const line of orderLines(last)) {
    try {
      checked.push(checkLine(line, await api.getStock(line.productId)));
    } catch (error) {
      if (!(error instanceof NotFoundError))
        return empty(REORDER_UNAVAILABLE_REPLY);
      checked.push({ line, status: 'gone', label: line.historicalLabel });
    }
  }
  const available = checked.flatMap((entry) =>
    entry.status === 'available' ? [entry.line] : [],
  );
  const quote =
    available.length === 0
      ? null
      : await cart.preview(
          senderId,
          available.map(({ productId, variantId, quantity }) => ({
            productId,
            ...(variantId === undefined ? {} : { variantId }),
            quantity,
          })),
        );
  if (quote !== null && !quote.ok) return empty(REORDER_UNAVAILABLE_REPLY);
  const quoted = quote?.ok ? quote.items : [];
  const details = [
    last.folio === null ? null : `folio ${last.folio}`,
    shortOrderDate(last.confirmedAt, now),
  ].filter((part): part is string => part !== null);
  const lines: string[] = [];
  let next = 0;
  for (const entry of checked) {
    if (entry.status === 'available') {
      const item = quoted[next++];
      lines.push(
        `• ${minimalLineLabel(item.name, item.variantName)}: ${entry.line.quantity}`,
      );
    } else {
      lines.push(
        `• ${entry.label}: ${entry.line.quantity} (${UNAVAILABLE_SUFFIX[entry.status]}; no lo incluyo)`,
      );
    }
  }
  const parts = [
    `Su último pedido${details.length === 0 ? '' : ` (${details.join(', ')})`} fue:`,
    ...lines,
    `El total de esa vez fue ${mxn(last.totalCents)}.`,
  ];
  if (quote === null || !quote.ok)
    return empty(
      [
        ...parts,
        'Por ahora ninguno está disponible. ¿Qué producto busca?',
      ].join('\n'),
    );
  const changed = quote.items.some(
    (item, index) =>
      item.unitPriceCents !== available[index].historicalUnitCents,
  );
  parts.push(
    changed
      ? `Total con precios de hoy: ${mxn(quote.totalCents)}; algunos precios cambiaron.`
      : `Precio de hoy: ${mxn(quote.totalCents)}.`,
  );
  if (quote.promotionEvaluationStatus === 'needs_human_review')
    parts.push('Las promociones requieren revisión del equipo.');
  parts.push(
    available.length < checked.length
      ? '¿Agrego los disponibles a su carrito?'
      : '¿Lo agrego igual a su carrito?',
  );
  return {
    reply: parts.join('\n'),
    offer: {
      reference: randomUUID(),
      items: available.map(({ productId, variantId, quantity }) => ({
        productId,
        ...(variantId === undefined ? {} : { variantId }),
        quantity,
      })),
    },
    productIds: [...new Set(available.map((line) => line.productId))],
  };
}
