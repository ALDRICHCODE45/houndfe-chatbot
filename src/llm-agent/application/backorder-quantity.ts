import { statedUnitCount } from '../domain/minimal-cart-request';
import { statesCountToBuy } from './minimal-cart-conversation';
import { BACKORDER_QUANTITY_MAX } from './gates/backorder-offer.gate';

/**
 * Restock backorder S14 («la que dijo al pedir; si no dijo, preguntar»): the
 * unit count the customer stated in `text` while asking to buy, or
 * `undefined` when there is none. It reuses the cart's own readings:
 *
 *   - `statedUnitCount`: one count only; measurements («18 kg»), decimals and
 *     presentation numbers are not counts, several counts are ambiguous;
 *   - `statesCountToBuy`: the message asks to buy, and the number is not a
 *     price, an age or a time span.
 *
 * A count of one is not carried (like the cart): «una» is as often an article
 * as a count, and the bot asks «¿Cuántas piezas le aparto?» instead.
 */
export function statedPurchaseCount(text: string): number | undefined {
  const count = statedUnitCount(text);
  if (count.status !== 'ok') return undefined;
  if (count.value < 2 || count.value > BACKORDER_QUANTITY_MAX) return undefined;
  return statesCountToBuy(text) ? count.value : undefined;
}
