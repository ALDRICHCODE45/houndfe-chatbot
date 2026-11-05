/** DI token for the receipt pre-fill extractor. */
export const RECEIPT_EXTRACTION = Symbol('RECEIPT_EXTRACTION');

export type ReceiptExtractionMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'application/pdf';

export interface ReceiptExtractionInput {
  bytes: Buffer;
  mimeType: ReceiptExtractionMimeType;
  /** Amount the customer owes for the bound sale, when known. */
  expectedAmountCents: number | null;
}

export type ReceiptExtractionConfidence = 'high' | 'medium' | 'low';

export type ReceiptExtraction =
  | {
      kind: 'receipt';
      amountCents: number | null;
      /** Transfer date as YYYY-MM-DD. */
      date: string | null;
      reference: string | null;
      bank: string | null;
      confidence: ReceiptExtractionConfidence;
      /** True only when both amounts are known and differ. */
      amountMismatch: boolean;
    }
  | { kind: 'not_receipt' }
  | {
      kind: 'unavailable';
      reason: 'timeout' | 'error' | 'budget' | 'unsupported';
    };

/**
 * Pre-fills transfer receipt data (amount, date, reference, bank) and flags a
 * mismatch against the amount owed.
 *
 * It NEVER confirms or rejects a payment: a human always validates the
 * receipt in the backend (S1). The extracted values are suggestions sent
 * separately from what the customer declared (S4). Implementations never
 * throw; failures surface as `{ kind: 'unavailable' }`.
 */
export interface ReceiptExtractionPort {
  extract(input: ReceiptExtractionInput): Promise<ReceiptExtraction>;
}

/** True only when both amounts are known and differ. */
export function computeAmountMismatch(
  amountCents: number | null,
  expectedAmountCents: number | null,
): boolean {
  if (amountCents === null || expectedAmountCents === null) return false;
  return amountCents !== expectedAmountCents;
}
