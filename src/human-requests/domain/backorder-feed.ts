import type { BackorderFeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { OutboundTemplate } from '../../whatsapp/domain/whatsapp-sender.port';
import type { DeliveryDecision, DeliveryRow } from './human-request-feed';

/** Optional DI token: a module that can plan backorder notices (T5, the
 *  llm-agent module) provides it; the delivery service picks it up when
 *  present and falls back to ACK STALE otherwise. */
export const BACKORDER_FEED_HANDLER = Symbol('BACKORDER_FEED_HANDLER');

/**
 * Restock backorder S15 / T8: the port the feed's delivery service calls for
 * every `backorder.*` item (docs/contracts/restock-backorder-bot-contract.md,
 * "Feed envelope" and "ACK outcomes"). Domain-only types (type imports of
 * the DTO and the sender port), so a later module (the llm-agent module, T5)
 * can import it without a cycle with `human-requests.module`.
 *
 * Without a handler registered the delivery service ACKs every backorder
 * item `STALE` with no customer message. A handler plans one notice; the
 * delivery service executes it as a BOT notice that is NEVER deferred (the
 * backend answers `422 OUTCOME_NOT_ALLOWED` to `DEFERRED_*` for backorder
 * items): a HUMAN session or a closed window at send time is `STALE`.
 *
 * Not available yet: `PROVIDER_REJECTED`. The ledger has no column for its
 * `reason` and its CHECK constraints reject the outcome, so a handler that
 * needs it (T5: no approved template, unreachable customer) must ship a
 * migration together with the plan variant. The client already sends it.
 */
export interface BackorderFeedHandler {
  /** Rejects on a transient local failure: the page is read again. */
  plan(row: DeliveryRow, item: BackorderFeedItem): Promise<BackorderFeedPlan>;
}

/** An approved template a notice goes out as (recipient and origin are the
 *  plan's). Structurally the live/pay-in-store `NoticeTemplate`. */
export type BackorderNoticeTemplate = Omit<
  OutboundTemplate,
  'to' | 'origin'
> & {
  /** Recorded when Meta (or the local check) definitely refuses it. */
  refusedDecision: DeliveryDecision;
};

export type BackorderFeedPlan =
  /** Nothing is sent; ACK `STALE`. */
  | { action: 'stale'; decision: DeliveryDecision }
  /** A BOT notice (text, or `template` outside the 24 h window). `decision`
   *  must be one the ledger accepts (see `DeliveryDecision`). */
  | {
      action: 'send';
      decision: DeliveryDecision;
      senderId: string;
      text: string;
      template?: BackorderNoticeTemplate;
    };
