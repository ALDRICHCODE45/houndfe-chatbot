import {
  type ConversationState,
  type ConversationStore,
  type PendingHumanRequest,
  readPendingHumanRequest,
} from '../../conversation/domain/conversation-store';

/**
 * Re-export alias for backward compatibility with the older
 * PendingHumanRequestMarker naming used inside this module's own spec.
 * The canonical declaration lives in `conversation-store.ts` (single
 * source of truth per ADR-26: "canonical declaration of types MUST be
 * declared exactly once").
 */
export type { PendingHumanRequest as PendingHumanRequestMarker };

/**
 * Pure accessor: `data.pendingHumanRequest` → typed marker | null.
 *
 * Mirrors the `readCart`/`readMessages` style — defensive defaults, no
 * throws. A missing key, an explicit null, or a structurally malformed
 * value all collapse to `null` so the runner's short-circuit never sees
 * a half-typed blob.
 */
// Re-export the canonical helper from conversation-store.ts so existing
// imports keep working unchanged.
export { readPendingHumanRequest };

/**
 * Durable write: SET `data.pendingHumanRequest = marker` while preserving
 * every other `data` key (NOTABLY `cart`, `placedSaleId`, `messages`) via
 * a shallow spread.
 *
 * The marker is the customer's "we're already escalated" signal — the
 * runner short-circuits on this and the dispatcher suppresses duplicate
 * agent sends. The helper is the ONLY writer for this field.
 *
 * The marker is set with `pendingHumanRequest: <marker>` (NOT `null`) per
 * spec; `clearPendingHumanRequest` is the explicit null-er.
 *
 * `lastMessageAt` is supplied by the caller so the runner's idle-reset
 * path and the service's `create` flow both have a single source of
 * truth for the timestamp.
 */
export async function setPendingHumanRequest(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
  marker: PendingHumanRequest,
  lastMessageAt: string,
): Promise<ConversationState> {
  const data = {
    ...(state?.data ?? {}),
    pendingHumanRequest: marker,
  };
  return store.update(senderId, { lastMessageAt, data });
}

/**
 * CLEAR `data.pendingHumanRequest` (set to `null`) while preserving every
 * other `data` key. Mirrors `clearPlacedSaleId` style — explicit null
 * so `readPendingHumanRequest` returns `null` deterministically.
 *
 * `lastMessageAt` is preserved from `state` when available; otherwise
 * the helper falls back to a fresh ISO timestamp (mirrors
 * `persistCart` / `clearPlacedSaleId`).
 */
export async function clearPendingHumanRequest(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
): Promise<ConversationState> {
  const lastMessageAt = state?.lastMessageAt ?? new Date().toISOString();
  const data = { ...(state?.data ?? {}), pendingHumanRequest: null };
  return store.update(senderId, { lastMessageAt, data });
}
