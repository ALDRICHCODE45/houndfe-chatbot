import { CatalogItemResponse, StockCheckResponse } from './dtos/catalog.dto';
import {
  CustomerLookupResponse,
  CustomerUpsertInput,
  CustomerUpsertResponse,
} from './dtos/customers.dto';
import { CartEvaluationResult, CartItemInput } from './dtos/pricing.dto';
import {
  AttachReceiptInput,
  AttachReceiptResponse,
  BotSaleResponse,
  CreateSaleInput,
  OrderHistoryResponse,
  UpdateDeliveryInput,
} from './dtos/sales.dto';

export const CHATBOT_API_CLIENT = Symbol('CHATBOT_API_CLIENT');

export interface ChatbotApiClient {
  searchCatalog(q: string, limit?: number): Promise<CatalogItemResponse[]>;
  getStock(productId: string): Promise<StockCheckResponse>;
  evaluateCart(items: CartItemInput[]): Promise<CartEvaluationResult>;
  getCustomerByPhone(cc: string, phone: string): Promise<CustomerLookupResponse>;
  upsertCustomer(dto: CustomerUpsertInput): Promise<CustomerUpsertResponse>;
  createSale(dto: CreateSaleInput, idempotencyKey: string): Promise<BotSaleResponse>;
  attachReceipt(saleId: string, dto: AttachReceiptInput): Promise<AttachReceiptResponse>;
  updateDelivery(saleId: string, dto: UpdateDeliveryInput): Promise<void>;
  getOrderHistory(phone: string, cc: string): Promise<OrderHistoryResponse[]>;
}
