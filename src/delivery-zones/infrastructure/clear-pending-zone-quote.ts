import type { ConversationStore } from '../../conversation/domain/conversation-store';

/**
 * Drop `minimalCart.shipping` when it is a stored PENDING-zone quote, so the
 * next shipping request re-quotes against the now-resolved zone. One CAS on
 * the exact raw slot; any other shipping record (live quote, pickup) or a
 * concurrent cart change is left untouched.
 */
export async function clearPendingZoneQuote(
  store: Pick<ConversationStore, 'get' | 'commitMinimalCart'>,
  senderId: string,
): Promise<void> {
  if (!store.commitMinimalCart) return;
  const state = await store.get(senderId);
  const raw: unknown = state?.data.minimalCart;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const shipping = (raw as { shipping?: unknown }).shipping;
  if (
    typeof shipping !== 'object' ||
    shipping === null ||
    (shipping as { zoneStatus?: unknown }).zoneStatus !== 'PENDING'
  )
    return;
  const next: Record<string, unknown> = { ...raw };
  delete next.shipping;
  await store.commitMinimalCart(senderId, raw, next, state!.lastMessageAt);
}
