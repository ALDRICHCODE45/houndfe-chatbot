/**
 * Webhook deduplication port.
 *
 * Meta Cloud API re-delivers webhook events when a delivery fails or
 * times out (exponential backoff over ~24h). Without deduplication, each
 * re-delivery of the SAME `message.id` is processed as a brand-new inbound
 * message — the bot replies again (and again), which is exactly the
 * "unsolicited greetings" bug observed in production.
 *
 * Semantics chosen (at-least-once with successful-delivery dedup):
 *   - `isDuplicate()` is checked BEFORE processing a message.
 *   - `markSeen()` is called AFTER a successful reply send, so a failed
 *     send still lets a Meta re-delivery retry the message (no loss), while
 *     a successfully answered message is never answered twice.
 */
export const WEBHOOK_DEDUP = Symbol('WEBHOOK_DEDUP');

export interface WebhookDedupStore {
  /** Returns true when this message id was already processed successfully. */
  isDuplicate(messageId: string): Promise<boolean>;

  /** Records a message id as processed. Must be idempotent. */
  markSeen(messageId: string): Promise<void>;
}
