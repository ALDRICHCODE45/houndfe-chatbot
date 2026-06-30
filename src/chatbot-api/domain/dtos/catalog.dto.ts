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
