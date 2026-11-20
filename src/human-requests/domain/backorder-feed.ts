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
 * `PROVIDER_REJECTED` (migration 5600 stores it with its `reason`): a handler
 * asks for it with a `rejected` plan, or sets `staffAlert` on a `send` plan so
 * the delivery service answers it when the notice cannot reach the customer
 * (HUMAN session, window closed at send time, refused template or message).
 * The backend alerts staff to call the customer on `backorder.reserved` /
 * `backorder.reservation_reminder` (S13).
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

/** A reply button of a notice (Meta: ≤ 3 per message, title ≤ 20 chars). */
export interface BackorderNoticeButton {
  id: string;
  title: string;
}

export type BackorderFeedPlan =
  /** Nothing is sent; ACK `STALE`. */
  | { action: 'stale'; decision: DeliveryDecision }
  /** Nothing is sent; ACK `PROVIDER_REJECTED` with `reason` (1-280 chars)
   *  so the backend alerts staff to call the customer (S13). */
  | { action: 'rejected'; decision: DeliveryDecision; reason: string }
  /** A BOT notice (text, or `template` outside the 24 h window). `decision`
   *  must be one the ledger accepts (see `DeliveryDecision`). */
  | {
      action: 'send';
      decision: DeliveryDecision;
      senderId: string;
      text: string;
      /** Sent as reply buttons under `text` (the plain text when the sender
       *  cannot send interactive messages). Ignored with a `template`. */
      buttons?: ReadonlyArray<BackorderNoticeButton>;
      /** Short body used when `text` exceeds Meta's interactive limit. */
      shortBody?: string;
      template?: BackorderNoticeTemplate;
      /** `backorder.reserved` / `reservation_reminder`: when the notice
       *  cannot reach the customer (HUMAN session, closed window at send
       *  time, a message or template Meta definitely refuses) the ACK is
       *  `PROVIDER_REJECTED` (reasons `HUMAN_SESSION`, `WINDOW_CLOSED`,
       *  `UNREACHABLE`, `TEMPLATE_NOT_APPROVED`) instead of `STALE`, so staff
       *  is alerted. An uncertain send stays `DELIVERY_UNKNOWN`. */
      staffAlert?: boolean;
    };
