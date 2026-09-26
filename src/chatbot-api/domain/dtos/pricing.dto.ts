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
    /** Per-unit price echoed from the caller's input (NOT an extended line total). */
    unitPriceCents: number;
    /** Extended line total before discount (`unitPriceCents * quantity`). */
    originalPriceCents: number;
    /** Extended line total after discount (`unitPriceCents * quantity - discountAmountCents`). */
    finalPriceCents: number;
    appliedPromotionTitle: string | null;
    /** Discount applied to the extended line total, not the unit price. */
    discountAmountCents: number;
  }>;
  promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
}
