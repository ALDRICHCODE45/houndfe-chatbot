/** S3 receipt sale lookup: the order a receipt pays for is the one the
 * minimal route persisted in `data.minimalCart.placedSale`. Local parser of
 * that persisted JSON shape (owned by the llm-agent minimal cart) so the
 * receipt context does not import llm-agent internals. Defensive: any
 * malformed slot collapses to `null` (no sale), never throws. */
import type { ConversationState } from '../../conversation/domain/conversation-store';

/** Canonical lowercase UUID, matching the receipt store's sale-id bound. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;

export interface PlacedOrder {
  saleId: string;
  /** Order total in cents; `null` when the persisted value is malformed. */
  totalCents: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readPlacedOrder(
  state: ConversationState | null,
): PlacedOrder | null {
  const cart = state?.data?.minimalCart;
  if (!isRecord(cart) || !isRecord(cart.placedSale)) return null;
  const { saleId, totalCents } = cart.placedSale;
  if (typeof saleId !== 'string' || !UUID.test(saleId)) return null;
  return {
    saleId,
    totalCents:
      Number.isSafeInteger(totalCents) && (totalCents as number) >= 0
        ? (totalCents as number)
        : null,
  };
}
