import type {
  CatalogItemResponse,
  StockStatus,
} from '../../chatbot-api/domain/dtos/catalog.dto';

/**
 * S11/S12: code-derived availability for the products a catalog read offers.
 *
 * Evidence (backend, 2026-11-17): the search payload and `/catalog/:id/stock`
 * read the same live columns with the same thresholds (no cache), so the
 * search's stock status is live evidence for availability LABELS and costs no
 * extra backend call. They differ only for products WITH variants: the
 * product-level quantity is not a usable figure there (search: raw
 * product.quantity; /stock: ignores variants). Rule implemented here:
 *   - simple / not-managed product -> its own `stock.status`;
 *   - product with variants -> each variant's status, product-level status is
 *     derived from them; the product-level stock and quantity are NEVER used.
 * Pure functions, no I/O.
 */

/** A status that cannot be trusted or is missing is `unverified`. */
export type AvailabilityStatus = StockStatus | 'unverified';

export interface ItemAvailability {
  /** Product-level availability (derived from the presentations when any). */
  status: AvailabilityStatus;
  /** One entry per presentation of the offered item, in catalog order. */
  variants: Array<{ variantId: string; status: AvailabilityStatus }>;
  /** Names of the presentations marked agotado. */
  agotadoPresentations: string[];
}

type StockLike = { status?: unknown; quantity?: unknown } | null | undefined;

/** A stock status is trusted only when its quantity agrees with it. */
export function verifiedStockStatus(stock: StockLike): AvailabilityStatus {
  if (stock === null || stock === undefined || typeof stock !== 'object')
    return 'unverified';
  const quantity = stock.quantity;
  const known = typeof quantity === 'number' && Number.isFinite(quantity);
  switch (stock.status) {
    case 'out_of_stock':
      return known && quantity === 0 ? 'out_of_stock' : 'unverified';
    case 'available':
    case 'low_stock':
      return quantity === null || (known && quantity > 0)
        ? stock.status
        : 'unverified';
    case 'not_managed':
      return 'not_managed';
    default:
      return 'unverified';
  }
}

/** Product-level status from the presentations' statuses (never a quantity). */
export function aggregateVariantStatus(
  statuses: readonly AvailabilityStatus[],
): AvailabilityStatus {
  if (statuses.length === 0) return 'unverified';
  if (statuses.includes('available')) return 'available';
  if (statuses.includes('low_stock')) return 'low_stock';
  if (statuses.every((status) => status === 'out_of_stock'))
    return 'out_of_stock';
  return statuses.includes('unverified') ? 'unverified' : 'not_managed';
}

interface PresentationStock {
  variantId: string;
  name: string;
  stock?: StockLike;
}

/** Availability of an item with presentations, from THEIR statuses only. */
export function availabilityFromVariants(
  variants: readonly PresentationStock[],
): ItemAvailability {
  const derived = variants.map((variant) => ({
    variantId: variant.variantId,
    name: variant.name,
    status: verifiedStockStatus(variant.stock),
  }));
  return {
    status: aggregateVariantStatus(derived.map((v) => v.status)),
    variants: derived.map(({ variantId, status }) => ({ variantId, status })),
    agotadoPresentations: derived
      .filter((v) => v.status === 'out_of_stock')
      .map((v) => v.name),
  };
}

type Offered = Pick<CatalogItemResponse, 'stock' | 'variants'>;

/**
 * Availability of one offered search item, from the search payload alone.
 * Simple / not-managed -> own status; with presentations -> theirs.
 */
export function deriveAvailability(item: Offered): ItemAvailability {
  if (item.variants.length > 0) return availabilityFromVariants(item.variants);
  return {
    status: verifiedStockStatus(item.stock),
    variants: [],
    agotadoPresentations: [],
  };
}

/** Is the item agotado (every presentation when it has them)? */
export function isOutOfStock(item: Offered): boolean {
  return deriveAvailability(item).status === 'out_of_stock';
}

/**
 * Stable partition: agotado items go after the rest, so an agotado product
 * never takes the place of an available match in the cap. Nothing is dropped.
 */
export function preferInStock<T extends Offered>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => !isOutOfStock(item)),
    ...items.filter((item) => isOutOfStock(item)),
  ];
}
