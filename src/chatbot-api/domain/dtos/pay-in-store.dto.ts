/**
 * Pay in store (odd/tasks/pay-in-store.md S3; backend contract
 * docs/chatbot-handoff/pay-in-store-hold-bot-contract.md):
 * `PATCH /chatbot-api/sales/:saleId/payment-intent` with
 * `{ "method": "IN_STORE" }` (scope `sales:write`, idempotent).
 */

/** Documented refusals (`error === message`, code-only body). */
export const PAY_IN_STORE_SALE_ALREADY_PAID = 'PAY_IN_STORE_SALE_ALREADY_PAID';

/** The hold the backend set (or the current one, on a repeated call). */
export interface PayInStoreHold {
  saleId: string;
  folio: string | null;
  paymentIntent: 'IN_STORE';
  /** ISO UTC deadline; render it in the branch time zone. */
  holdUntil: string;
  /** ISO UTC reminder time; `null` for a hold of 3 h or less. */
  reminderAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
  !Number.isNaN(Date.parse(value));

/**
 * The 200 body bound to the requested sale; `null` when it breaks the
 * contract (another sale or intent, no usable deadline). Unknown keys are
 * ignored.
 */
export function normalizePayInStoreHold(
  body: unknown,
  saleId: string,
): PayInStoreHold | null {
  if (!isRecord(body)) return null;
  const { folio, paymentIntent, holdUntil, reminderAt } = body;
  if (
    typeof body.saleId !== 'string' ||
    body.saleId.toLowerCase() !== saleId.toLowerCase() ||
    !(folio === null || typeof folio === 'string') ||
    paymentIntent !== 'IN_STORE' ||
    !isInstant(holdUntil) ||
    !(reminderAt === null || reminderAt === undefined || isInstant(reminderAt))
  )
    return null;
  return {
    saleId: body.saleId,
    folio: folio === '' ? null : folio,
    paymentIntent: 'IN_STORE',
    holdUntil,
    reminderAt: reminderAt ?? null,
  };
}
