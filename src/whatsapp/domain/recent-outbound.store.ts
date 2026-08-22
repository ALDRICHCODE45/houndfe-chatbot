/**
 * Recent-outbound port (echo filter).
 *
 * When the webhook app is subscribed to message echoes, Meta re-delivers
 * every message the business number SENDS back to the webhook as an
 * inbound-looking event whose `message.id` is the outbound wamid. The
 * dispatcher stores the `providerMessageId` returned by each successful
 * `sendText()` here and skips any inbound event whose id matches — the
 * bot never answers its own outgoing messages.
 *
 * Echoes arrive within seconds of the send, so a bounded in-memory window
 * is sufficient (the wamid match is exact; there is no number-format
 * dependency).
 */
export const RECENT_OUTBOUND = Symbol('RECENT_OUTBOUND');

export interface RecentOutboundStore {
  /** Records a successfully sent outbound message id. */
  remember(providerMessageId: string): void;

  /** True when the id matches a recent outbound message (echo). */
  isKnown(providerMessageId: string): boolean;
}
