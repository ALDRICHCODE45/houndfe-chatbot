/**
 * Bot-safe `PaymentDetail` projection (Q1 / R11).
 *
 * `GET /chatbot-api/payment-details` returns the active bank account so the
 * 10th AI-SDK tool `getPaymentDetails` can render the transfer message.
 *
 * The projection deliberately omits `tenantId` and `createdAt` per the
 * backend's bot-safe contract (see `docs/backend-questions-sale-flow-responses.md`
 * Q1). Tool callers MUST NOT assume `tenantId` exists on the response.
 */
export interface PaymentDetail {
  id: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
  isActive: boolean;
  /** ISO 8601 timestamp from the backend. */
  updatedAt: string;
}
