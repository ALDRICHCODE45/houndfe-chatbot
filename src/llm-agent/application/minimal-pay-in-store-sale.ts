import type { ConversationStore } from '../../conversation/domain/conversation-store';
import type { PayInStoreSaleRecord } from '../../human-requests/application/sale-pickup-notice.service';
import { parseMinimalCart } from './minimal-cart.service';

/**
 * Pay in store S3: the sender's placed order as the sale.pickup_* notices
 * need it (paid flag, checkout key, pickup branch). `null` when the sender
 * has no placed order or its slot is unreadable. Rejects only when the
 * store read itself fails (the feed retries the item).
 */
export async function readPayInStoreSale(
  store: Pick<ConversationStore, 'get'>,
  senderId: string,
): Promise<PayInStoreSaleRecord | null> {
  const state = await store.get(senderId);
  const sale = parseMinimalCart(state?.data.minimalCart)?.placedSale;
  if (sale === undefined) return null;
  return {
    saleId: sale.saleId,
    paid: sale.paid === true,
    checkoutKey: sale.pickup?.checkoutKey ?? null,
    pickupLocation: sale.pickup?.location ?? null,
  };
}
