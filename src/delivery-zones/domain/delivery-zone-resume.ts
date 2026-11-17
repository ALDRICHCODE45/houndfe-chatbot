import type { DeliveryZoneType } from '../../chatbot-api/domain/dtos/human-decisions-delivery-zone.dto';

/**
 * S4: what the delivery-zone notifier needs to resume a checkout that was
 * waiting for a zone approval. The capability lives in the LLM agent module
 * (it owns the cart, shipping and order summary); the notifier only sees this
 * port, so the two modules stay decoupled.
 */
export interface DeliveryZoneResumeInput {
  senderId: string;
  zipCode: string;
  zoneType: DeliveryZoneType;
  sourceRequestId: string;
  receivingPhoneNumberId: string;
}

/**
 * A re-quoted checkout ready to send. Text is unstyled usted copy; the
 * notifier applies the customer's stored style before sending.
 */
export interface DeliveryZoneCheckoutResume {
  /** Shipping sentence of the fresh quote, without the trailing period. */
  readonly shippingSentence: string;
  /** The order summary and its confirm / change buttons. */
  readonly summary: {
    readonly text: string;
    readonly buttons: ReadonlyArray<{ id: string; title: string }>;
    /** Short body used when the summary exceeds Meta's interactive limit. */
    readonly prompt: string;
  };
  /** Arms the pending summary; call ONLY after Meta accepted the summary. */
  arm(): void;
  /** Drops the pending summary when it will not (or could not) be delivered. */
  discard(): void;
}

export interface DeliveryZoneCheckoutResumer {
  /**
   * `null` when any precondition fails (cart empty or changed, ZIP changed,
   * no confirmed delivery data, quote failed or not deliverable, cart write
   * lost). Never throws; nothing stays pending on `null`.
   */
  prepare(
    input: DeliveryZoneResumeInput,
  ): Promise<DeliveryZoneCheckoutResume | null>;
}

/**
 * Late-bound holder of the resumer. The LLM agent module registers itself at
 * boot; the notifier resolves it at call time. Until one is registered the
 * notice is the current text (no resume).
 */
export class DeliveryZoneResumeRegistry {
  private resumer: DeliveryZoneCheckoutResumer | null = null;

  register(resumer: DeliveryZoneCheckoutResumer): void {
    this.resumer = resumer;
  }

  current(): DeliveryZoneCheckoutResumer | null {
    return this.resumer;
  }
}
