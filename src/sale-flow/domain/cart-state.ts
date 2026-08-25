import type { ConversationState } from '../../conversation/domain/conversation-store';

/**
 * Per-sender cart line. Persisted at add-to-cart time so the backend's
 * `originalPriceCents` (from `evaluateCart`) becomes the list price the
 * model can never undercut on `createSale` (Q2 / spec list-price-only rule).
 */
export interface CartItem {
  productId: string;
  variantId?: string;
  quantity: number;
  unitPriceCents: number;
}

/**
 * Per-sender cart held under `ConversationState.data.cart`. The
 * `idempotencyKey` is generated client-side on the first `createSale`
 * attempt and reused on every retry within the sender's session (cleared
 * on success).
 */
export interface CartState {
  items: CartItem[];
  idempotencyKey: string;
  /** Optional: persisted by `evaluateCart` on success, read by `createSale`.
   *  Absent on legacy carts; `createSale` MUST omit the field on the wire
   *  when undefined (Q2 / R13 promo contract). */
  expectedTotalCents?: number;
}

/** Default empty cart — same shape every caller can deep-equal against. */
export const EMPTY_CART: CartState = { items: [], idempotencyKey: '' };

/**
 * Type guard: only treat `unknown` blobs as `CartState` when both fields
 * are well-shaped. Any malformed cart collapses to `EMPTY_CART` so callers
 * never crash on legacy data.
 */
function isCartState(value: unknown): value is CartState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { items?: unknown; idempotencyKey?: unknown };
  return (
    Array.isArray(candidate.items) &&
    typeof candidate.idempotencyKey === 'string'
  );
}

/**
 * Pure accessor: missing `data.cart` OR a malformed blob → `EMPTY_CART`.
 * Mirrors the `readMessages(state)` style — defensive defaults, no throws.
 */
export function readCart(state: ConversationState | null): CartState {
  const raw = state?.data?.cart;
  return isCartState(raw) ? raw : { items: [], idempotencyKey: '' };
}

/**
 * Pure shallow-merge: `{ ...readCart(state), ...patch }`. Callers persist
 * the result via `ConversationStore.update` (the durable store handles
 * the whole `data` bag replacement; see conversation-store spec).
 *
 * writeCart never touches `state.data` keys outside `cart` — the caller
 * owns that merge.
 */
export function writeCart(
  state: ConversationState | null,
  patch: Partial<CartState>,
): CartState {
  return { ...readCart(state), ...patch };
}
