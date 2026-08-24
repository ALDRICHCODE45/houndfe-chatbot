import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import type { CartState } from '../domain/cart-state';

/**
 * Durable cart write.
 *
 * Persists `nextCart` under `data.cart` by replacing the whole `data`
 * object via `ConversationStore.update`. The `data` bag is treated as
 * an opaque JSONB column by the storage layer (no deep-merge there) —
 * this matches the `conversation-store` spec.
 *
 * `lastMessageAt` is preserved from `state` when available, otherwise
 * the helper supplies a fresh ISO timestamp so the store's
 * "requires lastMessageAt" invariant is satisfied (mirrors the runner's
 * pattern in `AgentRunner.handle`).
 *
 * Caller responsibility: build `nextCart` from `writeCart(state, patch)`
 * before calling this; `persistCart` only persists what the caller hands
 * it.
 */
export async function persistCart(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
  nextCart: CartState,
): Promise<ConversationState> {
  const lastMessageAt = state?.lastMessageAt ?? new Date().toISOString();
  const data = {
    ...(state?.data ?? {}),
    cart: nextCart,
  };
  return store.update(senderId, { lastMessageAt, data });
}
