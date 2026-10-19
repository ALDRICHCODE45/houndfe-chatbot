export interface CartItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
  /** Required for compatibility; informative only, ignored by backend pricing. */
  unitPriceCents: number;
}

export interface CartEvaluationResult {
  items: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
    /** Backend-chosen unit price before discount; send this to sales/checkouts. */
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
  /** Older backends may omit this; only unique customers use their price list. */
  customerResolution?: 'unique' | 'not_found' | 'ambiguous' | 'not_provided';
}
