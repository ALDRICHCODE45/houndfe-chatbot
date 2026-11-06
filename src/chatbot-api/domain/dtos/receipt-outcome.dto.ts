/** Transfer-receipt outcome (docs/contracts/transfer-receipts.md):
 *  `GET /chatbot-api/receipts/:receiptId`, scope `sales:read`. A human
 *  decides in the backend; the bot only relays the result (S1, S5). */

export type ReceiptOutcomeStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED';

export interface ReceiptOutcome {
  status: ReceiptOutcomeStatus;
  /** Customer-safe reason, only with REJECTED; null otherwise. */
  customerReason: string | null;
  sale: { debtCents: number; paymentStatus: string };
}

/** Longest customer reason relayed to WhatsApp. */
export const RECEIPT_OUTCOME_REASON_MAX_LENGTH = 500;

const STATUSES: ReadonlySet<unknown> = new Set([
  'PENDING',
  'CONFIRMED',
  'REJECTED',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyKeys = (record: Record<string, unknown>, keys: string[]) =>
  Object.keys(record).every((key) => keys.includes(key));

/** Strict parse: known keys only, a reason only with REJECTED. Null when the
 *  body does not match the contract. Never throws. */
export function parseReceiptOutcome(body: unknown): ReceiptOutcome | null {
  if (!isRecord(body) || !onlyKeys(body, ['status', 'customerReason', 'sale']))
    return null;
  const { status, customerReason, sale } = body;
  if (!STATUSES.has(status)) return null;
  if (
    !isRecord(sale) ||
    !onlyKeys(sale, ['debtCents', 'paymentStatus']) ||
    !Number.isSafeInteger(sale.debtCents) ||
    (sale.debtCents as number) < 0 ||
    typeof sale.paymentStatus !== 'string' ||
    sale.paymentStatus.length === 0
  )
    return null;
  let reason: string | null = null;
  if (customerReason !== undefined && customerReason !== null) {
    if (status !== 'REJECTED' || typeof customerReason !== 'string')
      return null;
    reason = customerReason.trim();
    if (
      reason.length === 0 ||
      reason.length > RECEIPT_OUTCOME_REASON_MAX_LENGTH
    )
      return null;
  }
  return {
    status: status as ReceiptOutcomeStatus,
    customerReason: reason,
    sale: {
      debtCents: sale.debtCents as number,
      paymentStatus: sale.paymentStatus,
    },
  };
}
