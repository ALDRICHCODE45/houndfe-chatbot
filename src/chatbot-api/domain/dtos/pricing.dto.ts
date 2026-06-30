export interface CartItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CartEvaluationResult {
  items: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPriceCents: number;
    originalPriceCents: number;
    finalPriceCents: number;
    appliedPromotionTitle: string | null;
    discountAmountCents: number;
  }>;
  promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
}
