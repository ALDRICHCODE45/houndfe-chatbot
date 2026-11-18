/**
 * Retest 2026-11-18 S3 (N19): whether the customer's placed sale already has
 * a transfer receipt waiting for the team's review (received and attached,
 * no confirm/reject outcome yet). The payment step uses it to avoid sending
 * the bank details again, which could lead to a second payment.
 *
 * The receipt-media store implements the read; the LLM agent module only sees
 * this port, so neither module imports the other.
 */
export interface ReceiptReviewStatusPort {
  /**
   * `true` only when `senderId` sent a receipt for `saleId` that is attached
   * to the sale and has no recorded outcome. May throw; callers fail open
   * (no receipt in review).
   */
  hasReceiptInReview(senderId: string, saleId: string): Promise<boolean>;
}

/** DI token of the receipt read exported by the receipt-media module. */
export const RECEIPT_REVIEW_STATUS = Symbol('RECEIPT_REVIEW_STATUS');

/**
 * Late-bound holder of the receipt read (like DeliveryZoneResumeRegistry).
 * The composition root registers the receipt-media store at boot; until then
 * (or in tests without receipts) no receipt is ever in review.
 */
export class ReceiptReviewStatusRegistry implements ReceiptReviewStatusPort {
  private port: ReceiptReviewStatusPort | null = null;

  register(port: ReceiptReviewStatusPort): void {
    this.port = port;
  }

  hasReceiptInReview(senderId: string, saleId: string): Promise<boolean> {
    return this.port === null
      ? Promise.resolve(false)
      : this.port.hasReceiptInReview(senderId, saleId);
  }
}
