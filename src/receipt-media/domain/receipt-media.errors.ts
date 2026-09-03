/** WU3 safe domain errors (RM3): only fixed allowlisted categories/codes are
 * exposed; arbitrary text, diagnostics, and PII never enter messages. */
export const RECEIPT_ERROR_CODES = [
  'TEMPLATE_KEY_UNKNOWN',
  'TEMPLATE_ARGS_INVALID',
  'IDENTITY_INVALID',
  'TX2_COMMIT_FAILED',
] as const;
export type ReceiptErrorCode = (typeof RECEIPT_ERROR_CODES)[number];
export type ReceiptErrorCategory =
  | 'RECEIPT_OUTBOX_INVALID_INTENT'
  | 'RECEIPT_OUTBOX_TX2_FAILED';

export class ReceiptMediaError extends Error {
  constructor(
    readonly category: ReceiptErrorCategory,
    readonly code: ReceiptErrorCode,
  ) {
    super(`receipt-media:${category}/${code}`);
  }
}
