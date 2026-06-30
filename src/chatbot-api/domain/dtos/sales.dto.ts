export interface CreateSaleInput {
  cashierUserId: string;
  customerId: string;
  shippingAddressId?: string | null;
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
