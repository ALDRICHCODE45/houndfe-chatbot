import { z } from 'zod';
import { parseTolerantRead, type TolerantRead } from './tolerant-read';

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

/* ---- Runtime parser (tolerant read: unknown keys stripped, see tolerant-read.ts) ---- */

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const cartEvaluationSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string().min(1),
      variantId: z.string().min(1).nullable(),
      quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      unitPriceCents: cents,
      originalPriceCents: cents,
      finalPriceCents: cents,
      appliedPromotionTitle: z.string().nullable(),
      discountAmountCents: cents,
    }),
  ),
  promotionEvaluationStatus: z.enum(['fully_evaluated', 'needs_human_review']),
  customerResolution: z
    .enum(['unique', 'not_found', 'ambiguous', 'not_provided'])
    .optional(),
});

/** `POST /chatbot-api/pricing/evaluate-cart`; null on contract breaks. */
export function parseCartEvaluationResult(
  body: unknown,
): TolerantRead<CartEvaluationResult> | null {
  return parseTolerantRead(cartEvaluationSchema, body);
}
