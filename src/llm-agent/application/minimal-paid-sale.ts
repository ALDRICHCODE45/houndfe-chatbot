import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { parseMinimalCart } from './minimal-cart.service';

/** One lost CAS race is retried against the fresh state; no more. */
const MAX_ATTEMPTS = 2;

/**
 * S6: the sender's placed sale is paid (the backend confirmed the receipt and
 * no debt is left). One CAS on the owned cart slot with the rest of the cart
 * untouched, `paymentPending` cleared and the idle clock left alone (this is
 * not a customer message). Best effort: never throws; `false` means nothing
 * was written (another sale, no placed sale, an unreadable state or a lost
 * race) and the order stays unpaid in the conversation.
 */
export async function markPlacedSalePaid(
  store: Pick<ConversationStore, 'get' | 'commitMinimalCart'>,
  senderId: string,
  saleId: string,
): Promise<boolean> {
  if (typeof store.commitMinimalCart !== 'function') return false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const state = await store.get(senderId);
      const raw: unknown = state?.data.minimalCart;
      const cart = parseMinimalCart(raw);
      const sale = cart?.placedSale;
      if (state === null || cart === null || sale?.saleId !== saleId)
        return false;
      if (sale.paid === true && sale.paymentPending !== true) return true;
      const { paymentPending: _pending, ...rest } = sale;
      void _pending;
      const saved = await store.commitMinimalCart(
        senderId,
        raw,
        { ...cart, placedSale: { ...rest, paid: true } },
        state.lastMessageAt,
      );
      if (saved) return true;
    }
  } catch {
    // Best effort: the customer notice never depends on this write.
  }
  return false;
}
