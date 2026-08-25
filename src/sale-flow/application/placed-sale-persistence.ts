import { EMPTY_CART } from '../domain/cart-state';
import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';

/**
 * Pure accessor: `data.placedSaleId` → `string | null`.
 *
 * A missing key, an empty string, or a non-string value all collapse to
 * `null` so the tool's client-side guard never fabricates an id. Mirrors
 * `readCart`/`readMessages` style — defensive defaults, no throws.
 *
 * The `placedSaleId` field is a sibling of `data.cart` in
 * `ConversationStateData` (ADR-12); it carries the `saleId` the current
 * session's `createSale` confirmed and that `cancelSale` consumes.
 */
export function readPlacedSaleId(
  state: ConversationState | null,
): string | null {
  const raw = state?.data?.placedSaleId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Atomic durable write: SET `data.cart = EMPTY_CART` AND
 * `data.placedSaleId = saleId` in a SINGLE `ConversationStore.update`.
 *
 * Two sequential writes would clobber the first's cart clear because
 * `update` replaces the whole `data` bag (ADR-13). This helper is the
 * only writer for the success path of `createSale`.
 *
 * Preserves the prior `data` keys (e.g. `messages`) via a shallow spread.
 * `lastMessageAt` is preserved from `state` when available; otherwise the
 * helper falls back to a fresh ISO timestamp so the storage layer's
 * "requires lastMessageAt" invariant is satisfied.
 */
export async function persistConfirmedSale(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
  saleId: string,
): Promise<ConversationState> {
  const lastMessageAt = state?.lastMessageAt ?? new Date().toISOString();
  const data = {
    ...(state?.data ?? {}),
    cart: EMPTY_CART,
    placedSaleId: saleId,
  };
  return store.update(senderId, { lastMessageAt, data });
}

/**
 * CLEAR `data.placedSaleId` while preserving every other key (NOTABLY the
 * `cart` — `cancelSale` does not own the cart). The key is `delete`d
 * (not set to `undefined`) so a follow-up `readPlacedSaleId` returns
 * `null` deterministically.
 *
 * `lastMessageAt` is preserved from `state` when available, otherwise the
 * helper falls back to a fresh ISO timestamp (mirrors `persistCart`).
 */
export async function clearPlacedSaleId(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
): Promise<ConversationState> {
  const lastMessageAt = state?.lastMessageAt ?? new Date().toISOString();
  const data = { ...(state?.data ?? {}) };
  delete data.placedSaleId;
  return store.update(senderId, { lastMessageAt, data });
}
