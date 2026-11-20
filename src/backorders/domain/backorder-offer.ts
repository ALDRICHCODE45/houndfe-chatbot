/**
 * Restock backorder S1: what the RESTOCK application coordinator (human
 * decisions module, runs OUTSIDE any customer turn) needs to turn the
 * delivered estimate into an offer the customer can answer. The capability
 * lives in the LLM agent module (it owns the conversation gates and the
 * customer turn); the coordinator only sees this port, so the two modules stay
 * decoupled (same pattern as `DeliveryZoneResumeRegistry`).
 */
export interface BackorderOfferInput {
  senderId: string;
  /** The RESTOCK human decision the estimate came from (`sourceDecisionId`). */
  decisionId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  /** `resolvedAt + restockDays`, ISO UTC. */
  estimatedAt: string;
  /** The count the customer stated when asking; `null` → ask before scheduling. */
  statedQuantity: number | null;
}

export interface BackorderOfferCapability {
  /**
   * The unit count the customer stated in the turn the RESTOCK request was
   * prepared, or `null` (none stated, expired, or unreadable). Never throws.
   */
  statedQuantity(
    senderId: string,
    productId: string,
    variantId: string | null,
  ): Promise<number | null>;
  /**
   * Arms the durable `backorder_offer` gate. Call ONLY after Meta accepted
   * the offer message. Resolves `true` when the gate is durable; never throws.
   */
  arm(input: BackorderOfferInput): Promise<boolean>;
}

/** Customer-facing copy shared by the coordinator and the answering turn. */
export const BACKORDER_OFFER_CLOSING =
  '¿Quiere que se lo apartemos en cuanto llegue? Le aviso y no paga nada hasta entonces.';
export const BACKORDER_SCHEDULE_TITLE = 'Sí, apártamelo';
export const BACKORDER_DECLINE_TITLE = 'No, gracias';
/** Short body used when the estimate text exceeds Meta's interactive limit. */
export const BACKORDER_OFFER_PROMPT = '¿Quiere que se lo apartemos?';

const SCHEDULE = 'backorder:schedule:';
const DECLINE = 'backorder:decline:';

export const backorderScheduleButtonId = (decisionId: string): string =>
  `${SCHEDULE}${decisionId}`;
export const backorderDeclineButtonId = (decisionId: string): string =>
  `${DECLINE}${decisionId}`;

/** The two reply buttons of the offer, bound to the decision they answer. */
export function backorderOfferButtons(
  decisionId: string,
): ReadonlyArray<{ id: string; title: string }> {
  return [
    {
      id: backorderScheduleButtonId(decisionId),
      title: BACKORDER_SCHEDULE_TITLE,
    },
    {
      id: backorderDeclineButtonId(decisionId),
      title: BACKORDER_DECLINE_TITLE,
    },
  ];
}

/**
 * Late-bound holder of the capability. The LLM agent module registers itself
 * at boot; the coordinator resolves it at call time. Until one is registered
 * the offer is still worded in the estimate but nothing is armed.
 */
export class BackorderOfferRegistry {
  private capability: BackorderOfferCapability | null = null;

  register(capability: BackorderOfferCapability): void {
    this.capability = capability;
  }

  current(): BackorderOfferCapability | null {
    return this.capability;
  }
}
