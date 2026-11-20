import type { BackorderCheckoutFailure } from '../../chatbot-api/domain/dtos/checkout.dto';
import type { BackorderLineDrop } from '../domain/backorder-copy';

/**
 * Restock backorder T5b: what the checkout's backorder errors mean for the
 * cart line that carries `backorderId` (contract §7, "backend T3 built").
 * The ONE place that maps those codes: the order service applies the decision
 * to the stored cart and words the reply.
 *
 *   drop        the reservation cannot be confirmed (expired, lost, already a
 *               sale, cancelled, not arrived, unknown): the line leaves the
 *               cart, nothing was charged; `lost` is never retried
 *   reprice     the line's price differs from the backorder's final price:
 *               refresh it and show the summary again
 *   mismatch    the line no longer matches the reservation: log and apologise
 *   unavailable a data fault: the team calls the customer; the cart is kept
 *   null        not a backorder-line decision: the existing handling answers
 *               (ordinary-line PRICE_OUT_OF_DATE, INVALID_CHECKOUT_REQUEST,
 *               the 503 BACKORDER_CHECKOUT_UNAVAILABLE keep-and-retry)
 */
export type BackorderLineDecision =
  | { kind: 'drop'; why: BackorderLineDrop }
  | { kind: 'reprice'; currentPriceCents: number }
  | { kind: 'mismatch'; field: string | null }
  | { kind: 'unavailable' };

const NOT_RESERVED_STATE: Readonly<Record<string, BackorderLineDrop>> = {
  EXPIRED: 'expired',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  WAITING: 'waiting',
};

export function backorderLineDecision(
  failure: BackorderCheckoutFailure,
): BackorderLineDecision | null {
  switch (failure.code) {
    case 'BACKORDER_RESERVATION_EXPIRED':
      return { kind: 'drop', why: 'expired' };
    case 'BACKORDER_NOT_RESERVED':
      return {
        kind: 'drop',
        why:
          (failure.backorderStatus === null
            ? undefined
            : NOT_RESERVED_STATE[failure.backorderStatus]) ?? 'unknown',
      };
    case 'BACKORDER_RESERVATION_LOST':
      return { kind: 'drop', why: 'lost' };
    case 'BACKORDER_NOT_FOUND':
      return { kind: 'drop', why: 'not_found' };
    case 'BACKORDER_MISMATCH':
      return { kind: 'mismatch', field: failure.field };
    case 'BACKORDER_RESERVATION_UNAVAILABLE':
      return { kind: 'unavailable' };
    case 'PRICE_OUT_OF_DATE':
      // An ordinary line's stale price carries no detail member.
      return failure.currentPriceCents === null
        ? null
        : { kind: 'reprice', currentPriceCents: failure.currentPriceCents };
    default:
      return null;
  }
}
