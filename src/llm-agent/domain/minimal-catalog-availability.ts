import type {
  CatalogItemResponse,
  StockCheckResponse,
  StockStatus,
} from '../../chatbot-api/domain/dtos/catalog.dto';

/**
 * S11: code-derived availability for the products a catalog read offers.
 *
 * Boundary (odd/tasks/inventory-evidence-boundary.md, stock-conversation-
 * boundary*.md): the search payload is NOT inventory evidence. Its stock is
 * used only as an ORDERING hint (`hintsOutOfStock`/`preferInStock`); the
 * availability the model sees comes from a fresh authenticated stock read of
 * the offered products (`deriveAvailability`). Pure functions, no I/O.
 */

/** A fresh read that cannot be trusted or never happened is `unverified`. */
export type AvailabilityStatus = StockStatus | 'unverified';

export interface ItemAvailability {
  /** Product-level availability (derived from the presentations when any). */
  status: AvailabilityStatus;
  /** One entry per presentation of the offered item, in catalog order. */
  variants: Array<{ variantId: string; status: AvailabilityStatus }>;
  /** Names of the presentations verified as agotado. */
  agotadoPresentations: string[];
}

type Hintable = Pick<CatalogItemResponse, 'stock' | 'variants'>;

/**
 * Ordering hint only: does the (untrusted-for-claims) search payload say the
 * item has nothing to sell? With presentations, only when every one is agotado.
 */
export function hintsOutOfStock(item: Hintable): boolean {
  // Optional chaining: this is a hint, so an item without stock data is simply
  // "no hint" and must never fail the whole search.
  const status = (stock: Hintable['stock'] | undefined) => stock?.status;
  if (item.variants.length > 0)
    return item.variants.every(
      (variant) => status(variant.stock) === 'out_of_stock',
    );
  return status(item.stock) === 'out_of_stock';
}

/**
 * Stable partition: items the payload hints are agotado go after the rest, so
 * an agotado product never takes the place of an available match in the cap.
 * Nothing is dropped.
 */
export function preferInStock<T extends Hintable>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => !hintsOutOfStock(item)),
    ...items.filter((item) => hintsOutOfStock(item)),
  ];
}

/** A stock status is trusted only when its quantity agrees with it. */
function verifiedStatus(stock: {
  status: StockStatus;
  quantity: number | null;
}): AvailabilityStatus {
  switch (stock.status) {
    case 'out_of_stock':
      return stock.quantity === 0 ? 'out_of_stock' : 'unverified';
    case 'available':
    case 'low_stock':
      return stock.quantity === null || stock.quantity > 0
        ? stock.status
        : 'unverified';
    case 'not_managed':
      return 'not_managed';
    default:
      return 'unverified';
  }
}

/**
 * Availability of one offered item from a fresh stock read (`null` = the read
 * failed). A mismatched product, an inconsistent quantity or a presentation
 * missing from the read is `unverified` — never agotado, never available.
 */
export function deriveAvailability(
  item: Pick<CatalogItemResponse, 'productId' | 'stock' | 'variants'>,
  fresh: StockCheckResponse | null,
): ItemAvailability {
  const trusted = fresh !== null && fresh.productId === item.productId;
  const freshVariants = new Map(
    (trusted ? fresh.variants : []).map((v) => [v.variantId, v.stock]),
  );
  const variants = item.variants.map((variant) => {
    const stock = freshVariants.get(variant.variantId);
    return {
      variantId: variant.variantId,
      name: variant.name,
      status:
        stock === undefined ? ('unverified' as const) : verifiedStatus(stock),
    };
  });
  const agotadoPresentations = variants
    .filter((variant) => variant.status === 'out_of_stock')
    .map((variant) => variant.name);
  const publicVariants = variants.map(({ variantId, status }) => ({
    variantId,
    status,
  }));
  if (!trusted)
    return {
      status: 'unverified',
      variants: publicVariants,
      agotadoPresentations,
    };
  if (variants.length === 0)
    return {
      status: verifiedStatus(fresh.stock),
      variants: publicVariants,
      agotadoPresentations,
    };
  const statuses = variants.map((variant) => variant.status);
  const status: AvailabilityStatus = statuses.includes('available')
    ? 'available'
    : statuses.includes('low_stock')
      ? 'low_stock'
      : statuses.every((s) => s === 'out_of_stock')
        ? 'out_of_stock'
        : statuses.includes('unverified')
          ? 'unverified'
          : 'not_managed';
  return { status, variants: publicVariants, agotadoPresentations };
}
