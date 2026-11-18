import { z } from 'zod';
import { parseTolerantRead, type TolerantRead } from './tolerant-read';

export type StockStatus =
  | 'available'
  | 'low_stock'
  | 'out_of_stock'
  | 'not_managed';

export interface CatalogItemVariantResponse {
  variantId: string;
  name: string;
  option: string | null;
  value: string | null;
  priceCents: number | null;
  stock: {
    status: StockStatus;
    quantity: number | null;
  };
}

export interface CatalogItemResponse {
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  description: string | null;
  price: {
    priceCents: number | null;
    fromPriceCents: number | null;
    promoPriceCents: number | null;
    promotionEvaluationStatus: 'needs_human_review';
  };
  stock: {
    status: StockStatus;
    quantity: number | null;
  };
  packageInfo: {
    weightGrams: null;
    dimensions: null;
  };
  variants: CatalogItemVariantResponse[];
  /**
   * Optional backend relevance flag (S10d): `all` = the item matches every
   * search term, `partial` = only some. Absent = unknown (older backend or an
   * unrecognized value, which the parser drops).
   */
  match?: CatalogMatchFlag;
  /** S14: product category; null when absent/unknown. */
  category?: CatalogCategory | null;
}

export type CatalogMatchFlag = 'all' | 'partial';

/**
 * S14: the product's flat POS category (backend 2ab0ef7e). Optional on the
 * type so older fixtures/backends keep working; the parsers always set it
 * (absent, null or malformed → null).
 */
export interface CatalogCategory {
  id: string;
  name: string;
}

export interface StockCheckResponse {
  productId: string;
  name: string;
  stock: {
    status: StockStatus;
    quantity: number | null;
  };
  variants: Array<{
    variantId: string;
    name: string;
    option: string | null;
    value: string | null;
    stock: {
      status: StockStatus;
      quantity: number | null;
    };
  }>;
  /** S14: product category; null when absent/unknown. */
  category?: CatalogCategory | null;
}

/* ---- Runtime parsers (tolerant reads: unknown keys stripped, see tolerant-read.ts) ---- */

const id = z.string().min(1);
const nullableCents = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
const stockSchema = z.object({
  status: z.enum(['available', 'low_stock', 'out_of_stock', 'not_managed']),
  quantity: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});
const variantBase = {
  variantId: id,
  name: z.string(),
  option: z.string().nullable(),
  value: z.string().nullable(),
  stock: stockSchema,
};

// Optional and forgiving: an absent or unrecognized value means "unknown"
// and the key is left off the parsed item; it never rejects the item.
const matchFlag = z
  .unknown()
  .transform((value): CatalogMatchFlag | undefined =>
    value === 'all' || value === 'partial' ? value : undefined,
  )
  .optional();

// S14: optional and forgiving like `match`: absent, null or malformed is
// null (the key is always present after parsing); never rejects the item.
// Unknown sub-keys of a valid category are stripped (and reported).
const categoryObject = z.object({
  id,
  name: z.string().refine((name) => name.trim().length > 0),
});
const categoryField = categoryObject.nullable().catch(null);

const catalogItemSchema = z.object({
  productId: id,
  name: z.string(),
  brand: z.string().nullable(),
  imageUrl: z.string().nullable(),
  description: z.string().nullable(),
  price: z.object({
    priceCents: nullableCents,
    fromPriceCents: nullableCents,
    promoPriceCents: nullableCents,
    promotionEvaluationStatus: z.literal('needs_human_review'),
  }),
  stock: stockSchema,
  packageInfo: z.object({ weightGrams: z.null(), dimensions: z.null() }),
  variants: z.array(z.object({ ...variantBase, priceCents: nullableCents })),
  match: matchFlag,
  category: categoryField,
});

const stockCheckSchema = z.object({
  productId: id,
  name: z.string(),
  stock: stockSchema,
  variants: z.array(z.object(variantBase)),
  category: categoryField,
});

/** `GET /chatbot-api/catalog/search`; null when the body breaks the contract. */
export function parseCatalogSearchResponse(
  body: unknown,
): TolerantRead<CatalogItemResponse[]> | null {
  return parseTolerantRead(z.array(catalogItemSchema), body);
}

/** `GET /chatbot-api/catalog/:productId/stock`; null on contract breaks. */
export function parseStockCheckResponse(
  body: unknown,
): TolerantRead<StockCheckResponse> | null {
  return parseTolerantRead(stockCheckSchema, body);
}
