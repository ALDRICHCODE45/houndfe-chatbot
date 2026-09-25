import { CatalogItemResponse, StockCheckResponse } from './dtos/catalog.dto';
import {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from './dtos/customers.dto';
import type { PaymentDetail } from './dtos/payment-details.dto';
import type {
  RestockApplicationOutcomeAck,
  RestockApplicationOutcomeRequest,
  RestockDecision,
  RestockIntakeInput,
  RestockIntakeReceipt,
} from './dtos/human-decisions.dto';
import { CartEvaluationResult, CartItemInput } from './dtos/pricing.dto';
import {
  AttachReceiptInput,
  AttachReceiptResponse,
  BotSaleResponse,
  CancelSaleInput,
  CancelSaleResult,
  CreateSaleInput,
  OrderHistoryResponse,
  UpdateDeliveryInput,
} from './dtos/sales.dto';

export const CHATBOT_API_CLIENT = Symbol('CHATBOT_API_CLIENT');

/**
 * Transport-level options for attachment-only receipt upload (WU11B).
 * `signal` is caller-owned and forwarded verbatim to the HTTP layer as the
 * Axios `signal`; the request timeout is owned by the HTTP client config.
 */
export interface AttachReceiptTransportOptions {
  signal?: AbortSignal;
}

export interface ChatbotApiClient {
  searchCatalog(q: string, limit?: number): Promise<CatalogItemResponse[]>;
  getStock(productId: string): Promise<StockCheckResponse>;
  evaluateCart(items: CartItemInput[]): Promise<CartEvaluationResult>;
  getCustomerByPhone(
    cc: string,
    phone: string,
  ): Promise<CustomerLookupResponse>;
  upsertCustomer(dto: CustomerUpsertInput): Promise<CustomerUpsertResponse>;
  createSale(
    dto: CreateSaleInput,
    idempotencyKey: string,
  ): Promise<BotSaleResponse>;
  /** Q1 / R11: `GET /chatbot-api/payment-details` (scope `payment-details:read`).
   *  Returns the active `PaymentDetail` or rejects with
   *  `ChatbotApiError { statusCode: 404, errorCode: 'NO_ACTIVE_PAYMENT_DETAIL' }`. */
  getPaymentDetails(): Promise<PaymentDetail>;
  /** `POST /chatbot-api/sales/:saleId/cancel` (scope `sales:write`).
   *  No client `X-Idempotency-Key` — idempotency is backend-derived
   *  from `sale:cancel:<saleId>` (SHA-256 of `{saleId, actorId, reason}`).
   *  The `cancelSale` tool layer always sends `reason: 'CUSTOMER_REQUEST'`
   *  and the injected `cashierUserId`. */
  cancelSale(saleId: string, dto: CancelSaleInput): Promise<CancelSaleResult>;
  attachReceipt(
    saleId: string,
    dto: AttachReceiptInput,
    options?: AttachReceiptTransportOptions,
  ): Promise<AttachReceiptResponse>;
  updateDelivery(saleId: string, dto: UpdateDeliveryInput): Promise<void>;
  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]>;
  /** HD-R2b2: `POST /chatbot-api/human-decisions` RESTOCK intake (scope
   *  `human-decisions:create`). Single attempt, no retry; resolves only on
   *  `201`/`200` with a strictly validated immutable historical receipt
   *  (`PENDING`/v1), never on inferred current decision state. */
  submitRestockIntake(dto: RestockIntakeInput): Promise<RestockIntakeReceipt>;
  /** T4b1: `GET /chatbot-api/human-decisions/:id` RESTOCK current-state poll
   *  (scope `human-decisions:read`). The only source of current
   *  `PENDING`/`RESOLVED` state; the immutable POST receipt never is. Validates
   *  the decision id as a UUID before any request, uses the safe GET retry
   *  policy (network/5xx only, bounded to three attempts), requires HTTP 200
   *  and binds the parsed current decision to the requested UUID
   *  (case-insensitive). */
  getRestockDecision(decisionId: string): Promise<RestockDecision>;
  /** T4b2: `POST /chatbot-api/human-decisions/:id/application-outcome`
   *  terminal bot ACK (scope `human-decisions:ack`). The decision id and the
   *  request are validated/normalized before any HTTP; the wire body is the
   *  exact normalized discriminated DTO. Exactly one POST is attempted — no
   *  retry or sleep even on 5xx/network ambiguity — and only a fulfilled HTTP
   *  200 whose five-key ACK parses and binds to the requested decision id,
   *  `attemptId` and outcome resolves. No idempotency header: `attemptId` is
   *  the backend replay key. */
  recordRestockApplicationOutcome(
    decisionId: string,
    request: RestockApplicationOutcomeRequest,
  ): Promise<RestockApplicationOutcomeAck>;
}
