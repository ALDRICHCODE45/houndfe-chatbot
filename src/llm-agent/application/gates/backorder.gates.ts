import type { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { DurableBackorderOffer } from './backorder-offer.gate';
import { DurableBackorderQuantity } from './backorder-quantity.gate';

/**
 * The two durable backorder gates of one `ConversationGates`. Each kind can be
 * registered once, and two services need them (the RESTOCK confirmation
 * writes the stated count; the offer service arms and answers the offer), so
 * they are built together and shared.
 */
export class BackorderGates {
  readonly offers: DurableBackorderOffer;
  readonly quantities: DurableBackorderQuantity;

  constructor(readonly gates: ConversationGates) {
    this.offers = new DurableBackorderOffer(gates);
    this.quantities = new DurableBackorderQuantity(gates);
  }
}
