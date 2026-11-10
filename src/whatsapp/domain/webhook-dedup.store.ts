/**
 * Webhook deduplication port.
 *
 * Meta Cloud API re-delivers webhook events when a delivery fails or
 * times out (retries for up to 7 days). Without deduplication, each
 * re-delivery of the SAME `message.id` is processed as a brand-new inbound
 * message — the bot replies again (and again), which is exactly the
 * "unsolicited greetings" bug observed in production.
 *
 * Semantics (S6, at-least-once with a claim lease; see docs/webhook-dedup.md):
 *   - `claim()` runs BEFORE processing. It atomically records the message as
 *     PROCESSING with a lease; only one of two concurrent deliveries wins.
 *     A DONE message is a duplicate (acknowledged). A live claim throws
 *     `WebhookClaimInFlightError` so the delivery is NOT acknowledged and
 *     Meta keeps retrying until the row is DONE or the lease expires.
 *   - `markSeen()` runs AFTER the message was handled (reply sent, mirrored
 *     in HUMAN mode, receipt admitted): the row becomes DONE.
 *   - `release()` runs when handling failed before anything was sent, so
 *     Meta's redelivery is processed again (no lost customer message).
 *   - A crash mid-processing leaves the claim to expire; the next
 *     redelivery after the lease takes it over. A crash after the send but
 *     before `markSeen` can therefore duplicate one reply (accepted).
 *   - `purgeBefore()` drops DONE rows and abandoned claims older than the
 *     retention window, in bounded batches.
 */
export const WEBHOOK_DEDUP = Symbol('WEBHOOK_DEDUP');

/** Optional clock for the dedup adapters (tests); defaults to `new Date()`. */
export const WEBHOOK_DEDUP_CLOCK = Symbol('WEBHOOK_DEDUP_CLOCK');

/**
 * Claim lease. Must exceed the dispatcher's worst-case turn (several LLM
 * steps plus backend calls of up to 45 s each), or a slow redelivery could
 * take over a turn that is still running and reply twice. A crash only
 * delays the redelivery by this much; Meta keeps retrying for days.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 10 * 60_000;

/** Meta retries a delivery for up to 7 days; keep one day of margin. */
export const WEBHOOK_DEDUP_RETENTION_MS = 8 * 24 * 60 * 60_000;

/** Another delivery holds a live claim; the webhook must not answer 200. */
export class WebhookClaimInFlightError extends Error {
  constructor(messageId: string) {
    super(
      `webhook message ${messageId} is being processed by another delivery; retry later`,
    );
    this.name = 'WebhookClaimInFlightError';
  }
}

export interface WebhookDedupStore {
  /**
   * Claims a message for processing. Returns the claim token, or `null`
   * only when the message is DONE. Throws `WebhookClaimInFlightError` while
   * another delivery holds a live claim. An expired claim is taken over.
   */
  claim(messageId: string): Promise<string | null>;

  /** Records a message as handled (DONE). Idempotent; needs no claim. */
  markSeen(messageId: string): Promise<void>;

  /** Drops this caller's PROCESSING claim; never a DONE row or a newer claim. */
  release(messageId: string, claimToken: string): Promise<void>;

  /**
   * Deletes up to `limit` DONE rows and abandoned claims last touched before
   * `cutoff` (a claim whose lease is still live is never deleted). Returns
   * how many rows were deleted.
   */
  purgeBefore(cutoff: Date, limit: number): Promise<number>;
}
