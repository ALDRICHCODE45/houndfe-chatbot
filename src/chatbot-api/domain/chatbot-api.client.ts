import { CatalogItemResponse, StockCheckResponse } from './dtos/catalog.dto';
import {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from './dtos/customers.dto';
import type { PaymentDetail } from './dtos/payment-details.dto';
import type { ExpirationIntakeInput } from './dtos/human-decisions-expiration.dto';
import type { ExpirationIntakeReceipt } from './dtos/human-decisions-expiration-receipt.dto';
import type { ExpirationDecision } from './dtos/human-decisions-expiration-decision.dto';
import type {
  DeliveryZoneIntakeInput,
  DeliveryZoneRequester,
} from './dtos/human-decisions-delivery-zone.dto';
import type {
  RestockApplicationOutcomeAck,
  RestockApplicationOutcomeRequest,
  RestockDecision,
  RestockIntakeInput,
  RestockIntakeReceipt,
} from './dtos/human-decisions.dto';
import { CartEvaluationResult, CartItemInput } from './dtos/pricing.dto';
import {
  BotSaleResponse,
  CancelSaleInput,
  CancelSaleResult,
  CreateSaleInput,
  OrderHistoryResponse,
  UpdateDeliveryInput,
} from './dtos/sales.dto';
import type {
  CheckoutContextQuery,
  CustomerCheckoutContext,
} from './dtos/checkout-context.dto';

import type {
  CreateCheckoutInput,
  CheckoutResponse,
  CheckoutStatus,
} from './dtos/checkout.dto';
import type {
  CreateShippingQuoteInput,
  ShippingQuoteResponse,
} from './dtos/shipping-quote.dto';
import type {
  ReceiptUploadFields,
  ReceiptUploadFile,
  ReceiptUploadResponse,
} from './dtos/receipt-upload.dto';
import type { ReceiptOutcome } from './dtos/receipt-outcome.dto';
import type {
  CancelHumanRequestInput,
  CancelHumanRequestResult,
  CreateHumanRequestInput,
  CreateHumanRequestResult,
  DeliveryOutcomeInput,
  PendingDeliveriesFilter,
  PendingDeliveriesResult,
  ReadFeedOptions,
  ReadFeedResult,
  RecordDeliveryOutcomeResult,
} from './dtos/human-requests.dto';

export const CHATBOT_API_CLIENT = Symbol('CHATBOT_API_CLIENT');

/**
 * Transport-level options for the multipart receipt upload. `signal` is
 * caller-owned and forwarded verbatim to the HTTP layer as the Axios
 * `signal`; the request timeout is owned by the HTTP client.
 */
export interface AttachReceiptTransportOptions {
  signal?: AbortSignal;
}

export interface ChatbotApiClient {
  searchCatalog(q: string, limit?: number): Promise<CatalogItemResponse[]>;
  getStock(productId: string): Promise<StockCheckResponse>;
  evaluateCart(
    items: CartItemInput[],
    customer?: { phoneCountryCode: string; phone: string },
  ): Promise<CartEvaluationResult>;
  getCustomerByPhone(
    cc: string,
    phone: string,
  ): Promise<CustomerLookupResponse>;
  /**
   * S1/S6 minimal checkout customer/address read (scope `customers:read`):
   * `GET /chatbot-api/customers/checkout-context`. The credential owns the
   * tenant and the trusted application derives the digit phone. Returns the
   * `not_found`/`ambiguous`/`unique` envelope as a result; malformed upstream
   * data rejects as a transport error so an unavailable lookup is never
   * mistaken for customer absence. Reads only: no upsert, address mutation,
   * sale, reservation, payment or shipping call. */
  getCustomerCheckoutContext(
    cc: string,
    phone: string,
    options?: CheckoutContextQuery,
  ): Promise<CustomerCheckoutContext>;
  createCheckout(
    dto: CreateCheckoutInput,
    idempotencyKey: string,
  ): Promise<CheckoutResponse>;
  getCheckoutStatus(idempotencyKey: string): Promise<CheckoutStatus>;
  /** `POST /chatbot-api/shipping/quotes`: the backend picks the cheapest
   *  carrier and computes the credit; single attempt, no retry. Rejects with
   *  `ChatbotApiError` carrying `errorCode` (e.g. `PACKAGING_DATA_MISSING`,
   *  `SHIPPING_QUOTE_UNAVAILABLE`); a malformed body is an `UpstreamError`. */
  createShippingQuote(
    input: CreateShippingQuoteInput,
  ): Promise<ShippingQuoteResponse>;
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
  /** Multipart `POST /chatbot-api/sales/:saleId/receipts` (scope
   *  `sales:write`). `idempotencyKey` is the WhatsApp media id: a retry with
   *  the same key and file returns the same receipt. Exactly one POST per
   *  call; only a strictly valid 201 resolves. Rejects with `ChatbotApiError`
   *  carrying `statusCode` and `errorCode` (`body.error`); a timeout or
   *  network failure has `statusCode: null` (unknown outcome). */
  uploadReceipt(
    saleId: string,
    file: ReceiptUploadFile,
    fields: ReceiptUploadFields,
    idempotencyKey: string,
    options?: AttachReceiptTransportOptions,
  ): Promise<ReceiptUploadResponse>;
  /** `GET /chatbot-api/receipts/:receiptId` (scope `sales:read`): the
   *  human outcome of an uploaded receipt. UUID-validated before any request,
   *  safe GET retry policy, strict body parse; errors carry `body.error`. */
  getReceiptOutcome(receiptId: string): Promise<ReceiptOutcome>;
  updateDelivery(saleId: string, dto: UpdateDeliveryInput): Promise<void>;
  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]>;
  /** HD-R2b2: `POST /chatbot-api/human-decisions` RESTOCK intake (scope
   *  `human-decisions:create`). Single attempt, no retry; resolves only on
   *  `201`/`200` with a strictly validated immutable historical receipt
   *  (`PENDING`/v1), never on inferred current decision state. */
  submitRestockIntake(dto: RestockIntakeInput): Promise<RestockIntakeReceipt>;
  /** HD-R2b3: `POST /chatbot-api/human-decisions` EXPIRATION intake (scope
   *  `human-decisions:create`). Single attempt, no retry; only a `201`/`200`
   *  immutable historical `PENDING`/v1 receipt bound to the sent identity
   *  resolves. HTTP transport only — not wired to runtime. */
  submitExpirationIntake(
    dto: ExpirationIntakeInput,
  ): Promise<ExpirationIntakeReceipt>;
  /** T4b1: `GET /chatbot-api/human-decisions/:id` RESTOCK current-state poll
   *  (scope `human-decisions:read`). The only source of current
   *  `PENDING`/`RESOLVED` state; the immutable POST receipt never is. Validates
   *  the decision id as a UUID before any request, uses the safe GET retry
   *  policy (network/5xx only, bounded to three attempts), requires HTTP 200
   *  and binds the parsed current decision to the requested UUID
   *  (case-insensitive). */
  getRestockDecision(decisionId: string): Promise<RestockDecision>;
  /** EXPIRATION `GET /chatbot-api/human-decisions/:id` current-state poll
   *  (scope `human-decisions:read`). Validates the id as a canonical lowercase
   *  RFC UUID v1–v8 (nil/uppercase/whitespace rejected) before any request,
   *  uses the safe GET retry policy (network/5xx only, bounded to three
   *  attempts), and requires HTTP 200 whose normalized body binds exactly to
   *  the requested id. Binding to source/subject/branch/sender and freshness
   *  eligibility are future runtime concerns, so a valid `RESOLVED` decision
   *  past its deadline still parses here. */
  getExpirationDecision(decisionId: string): Promise<ExpirationDecision>;
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
  /** DELIVERY_ZONE intake: `POST /chatbot-api/human-decisions` with `type:
   *  "DELIVERY_ZONE"` (scope `human-decisions:create`) and `X-Idempotency-Key`
   *  = `sourceRequestId`. Single attempt; resolves on `201`/`200` with the
   *  current requester state (PENDING, or RESOLVED for EXISTING_ZONE). The ACK
   *  is identical to RESTOCK: use `recordRestockApplicationOutcome` with the
   *  requester id. */
  submitDeliveryZoneIntake(
    dto: DeliveryZoneIntakeInput,
  ): Promise<DeliveryZoneRequester>;
  /** DELIVERY_ZONE poll: `GET /chatbot-api/human-decisions/:id` by requester id
   *  (scope `human-decisions:read`), safe GET retry policy. */
  getDeliveryZoneRequester(requesterId: string): Promise<DeliveryZoneRequester>;
}

export const HUMAN_REQUESTS_CLIENT = Symbol('HUMAN_REQUESTS_CLIENT');

/**
 * Human requests and feed (docs/contracts/human-intervention-requests-5a.md,
 * docs/contracts/human-intervention-bot-contract-5b.md), a separate port so
 * existing `ChatbotApiClient` fakes stay valid. Implemented by the same HTTP
 * adapter. Documented business errors resolve as typed results discriminated
 * by `kind`; transport failures (401/403, 5xx, network, undocumented codes,
 * malformed bodies) reject with `ChatbotApiError` subclasses as everywhere
 * else.
 */
export interface HumanRequestsClient {
  /** `POST /chatbot-api/requests` (scope `requests:create`), single attempt,
   *  `X-Idempotency-Key` = `sourceRequestId`. `CUSTOMER_RATE_LIMITED` must
   *  not be auto-retried. */
  createHumanRequest(
    input: CreateHumanRequestInput,
  ): Promise<CreateHumanRequestResult>;
  /** `POST /chatbot-api/requests/:id/cancel` (scope `requests:cancel`),
   *  single attempt with the caller's idempotency key. */
  cancelHumanRequest(
    requestId: string,
    input: CancelHumanRequestInput,
    idempotencyKey: string,
  ): Promise<CancelHumanRequestResult>;
  /** `GET /chatbot-api/feed` long-poll (scope `feed:read`). No retries: the
   *  consumer loop decides. The request timeout exceeds `waitSeconds` by
   *  `FEED_TIMEOUT_SLACK_MS`. Unknown item types surface as `type: 'unknown'`;
   *  a malformed item rejects the page with `UpstreamError`. */
  readFeed(options?: ReadFeedOptions): Promise<ReadFeedResult>;
  /** `POST /chatbot-api/deliveries/:deliveryId/outcome` (scope `feed:ack`),
   *  single attempt; retry a lost ACK with the same body. */
  recordDeliveryOutcome(
    deliveryId: string,
    input: DeliveryOutcomeInput,
  ): Promise<RecordDeliveryOutcomeResult>;
  /** `GET /chatbot-api/requests/pending-deliveries` (scope `feed:read`) with
   *  exactly one filter; safe GET retry policy. */
  listPendingDeliveries(
    filter: PendingDeliveriesFilter,
  ): Promise<PendingDeliveriesResult>;
}
