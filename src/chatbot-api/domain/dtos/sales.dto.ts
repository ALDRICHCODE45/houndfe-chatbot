import { z } from 'zod';

/**
 * Zod schema for `CancelSaleInput` (chatbot-api
 * `POST /chatbot-api/sales/:saleId/cancel`, scope `sales:write`).
 *
 * `reason` is the full 5-value enum (chatbot-api spec §4.4.10); the
 * `cancelSale` tool layer always sends `CUSTOMER_REQUEST` (ADR-21), but
 * the wire contract stays complete so future relaxations don't churn the
 * DTO.
 *
 * `cashierUserId` is server-injected (`CHATBOT_API_CASHIER_USER_ID`); the
 * tool never accepts a model-supplied value.
 */
export const CancelSaleInputSchema = z.object({
  reason: z.enum([
    'CUSTOMER_REQUEST',
    'ORDER_ERROR',
    'OUT_OF_STOCK',
    'DUPLICATE_SALE',
    'OTHER',
  ]),
  cashierUserId: z.string().min(1),
});

export interface CancelSaleInput {
  reason:
    | 'CUSTOMER_REQUEST'
    | 'ORDER_ERROR'
    | 'OUT_OF_STOCK'
    | 'DUPLICATE_SALE'
    | 'OTHER';
  /** UUID of the cashier / bot identity. Injected from
   *  `CHATBOT_API_CASHIER_USER_ID`; never model-supplied. */
  cashierUserId: string;
}

/**
 * Cancel endpoint response projection (`CancelSaleResult`).
 *
 * NOT `BotSaleResponse` — the backend `cancelBotSale` → `SalesService.cancelSale`
 * returns a different shape (no `deliveryStatus` / `totalCents` /
 * `subtotalCents`; carries `refundedCents` + `restockedItems` +
 * `canceledAt`). Reusing `BotSaleResponse` would be a deserialization
 * lie (ADR-19).
 *
 * Plain interface (matches the existing response-DTO style — responses
 * are not Zod-validated today); only the INPUT carries a Zod schema.
 */
export interface CancelSaleResult {
  /** UUID of the canceled sale. */
  saleId: string;
  /** Literal `'CANCELED'` — a `CANCELED` sale returns a 200 replay
   *  success (no distinct "already canceled" code, ADR-20). */
  status: 'CANCELED';
  /** Non-negative integer cents. */
  refundedCents: number;
  restockedItems: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
  }>;
  /** ISO 8601 timestamp of the cancel operation. */
  canceledAt: string;
}

/**
 * Zod schema for `CreateSaleInput` (chatbot-api `POST /chatbot-api/sales`).
 *
 * `expectedTotalCents` is OPTIONAL on the wire — the bot MUST omit the key
 * entirely (never `0`, never `null`) when no `evaluateCart` quote is in scope
 * (legacy carts, fresh first attempt). The schema accepts `null` /
 * `undefined` for ergonomics; the HTTP client strips them before sending so
 * the JSON body never carries the key in that case.
 */
export const CreateSaleInputSchema = z.object({
  cashierUserId: z.string().min(1),
  customerId: z.string().min(1),
  shippingAddressId: z.string().nullish(),
  expectedTotalCents: z.number().int().min(0).nullish(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().nullish(),
        productName: z.string().min(1),
        variantName: z.string().nullish(),
        quantity: z.number().int().min(1),
        unitPriceCents: z.number().int().min(0),
      }),
    )
    .min(1),
});

export interface CreateSaleInput {
  cashierUserId: string;
  customerId: string;
  shippingAddressId?: string | null;
  /** Optional top-level promo-re-quote guard (Q2 / R13).
   *  Forwarded to the wire as a non-null integer cents value when present;
   *  the HTTP client strips `null`/`undefined` so the JSON body omits the key
   *  entirely when absent. */
  expectedTotalCents?: number | null;
  items: Array<{
    productId: string;
    variantId?: string | null;
    productName: string;
    variantName?: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
}

export interface BotSaleResponse {
  saleId: string;
  folio: string | null;
  paymentStatus: 'CREDIT' | 'PARTIAL' | 'PAID';
  channel: string;
  deliveryStatus: string;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  confirmedAt: string | null;
  /** Non-negative integer cents; `0` when no promo applies. The HTTP client
   *  defaults to `0` when the body omits the field (legacy backend). */
  discountCents: number;
}

export interface AttachReceiptInput {
  mediaUrl: string;
  declaredAmountCents: number;
  declaredDate?: string | null;
  declaredReference?: string | null;
}

export interface AttachReceiptResponse {
  receiptId: string;
  status: 'PENDING';
}

export interface UpdateDeliveryInput {
  carrierName?: string | null;
  trackingRef?: string | null;
  estimatedDeliveryAt?: string | null;
}

export interface OrderHistoryResponse {
  saleId: string;
  folio: string | null;
  confirmedAt: string | null;
  channel: string;
  deliveryStatus: string;
  paymentStatus: string | null;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  items: Array<{
    productId: string;
    variantId: string | null;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  payments: Array<{
    method: string;
    amountCents: number;
    reference: string | null;
  }>;
  shippingAddress: {
    street: string | null;
    zipCode: string | null;
  } | null;
}
