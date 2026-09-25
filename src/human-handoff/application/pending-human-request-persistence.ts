import {
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
 * the atomic first-contact CAS primitive `ConversationStore.setPendingHumanRequest`.
 *
 * The marker is the customer's "we're already escalated" signal — the
 * runner short-circuits on this and the dispatcher suppresses duplicate
 * agent sends. The helper is the ONLY writer for this field.
 *
 * The marker is set with `pendingHumanRequest: <marker>` (NOT `null`) per
 * spec; `clearPendingHumanRequest` is the explicit null-er. Returns true only
 * when the CAS set succeeded (a different/corrupt active marker returns false).
 */
export function setPendingHumanRequest(
  store: ConversationStore,
  senderId: string,
  marker: PendingHumanRequest,
  lastMessageAt: string,
): Promise<boolean> {
  return store.setPendingHumanRequest(senderId, marker, lastMessageAt);
}

/**
 * CLEAR `data.pendingHumanRequest` (set to `null`) while preserving every
 * other `data` key. Mirrors `clearPlacedSaleId` style — explicit null
 * so `readPendingHumanRequest` returns `null` deterministically.
 *
 * Delegates to the CAS primitive `ConversationStore.clearPendingHumanRequest`:
 * it clears only when the stored marker's `requestId` matches, so a false
 * result (missing row, wrong id, or malformed marker) lets the caller fail closed.
 */
export function clearPendingHumanRequest(
  store: ConversationStore,
  senderId: string,
  requestId: string,
  lastMessageAt: string,
): Promise<boolean> {
  return store.clearPendingHumanRequest(senderId, requestId, lastMessageAt);
}
