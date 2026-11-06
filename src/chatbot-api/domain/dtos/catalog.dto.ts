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
});

const stockCheckSchema = z.object({
  productId: id,
  name: z.string(),
  stock: stockSchema,
  variants: z.array(z.object(variantBase)),
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
