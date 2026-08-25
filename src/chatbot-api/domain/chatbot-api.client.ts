import { CatalogItemResponse, StockCheckResponse } from './dtos/catalog.dto';
import {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from './dtos/customers.dto';
import type { PaymentDetail } from './dtos/payment-details.dto';
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
  ): Promise<AttachReceiptResponse>;
  updateDelivery(saleId: string, dto: UpdateDeliveryInput): Promise<void>;
  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]>;
}
