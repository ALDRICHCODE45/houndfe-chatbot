import { Logger } from '@nestjs/common';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  CheckoutPickupLocation,
  CheckoutSaleHold,
} from '../../chatbot-api/domain/dtos/checkout.dto';
import type { SalePickupItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import {
  PAY_IN_STORE_TEMPLATES,
  payInStoreTemplateStoreText,
  pickupExpiredReviewText,
  pickupExpiredText,
  pickupExtendedText,
  pickupNewDeadline,
  pickupReminderDeadline,
  pickupReminderText,
} from '../../pay-in-store/domain/pay-in-store-copy';
import {
  senderIdFromRef,
  styleFixedCopy,
  type DeliveryDecision,
  type DeliveryRow,
} from '../domain/human-request-feed';
import type { LivePlan, NoticeTemplate } from './live-conversation.service';

/** What the bot keeps about the conversation's placed order. */
export interface PayInStoreSaleRecord {
  saleId: string;
  /** The receipt outcome poller saw it paid. */
  paid: boolean;
  /** The checkout key that created it (reads the live hold); `null` when
   *  the order was placed without pay in store enabled. */
  checkoutKey: string | null;
  /** The pickup branch shown in the reminder; `null` when unknown. */
  pickupLocation: CheckoutPickupLocation | null;
}

export interface SalePickupNoticePorts {
  /** The sender's placed order, `null` when none. Rejects when the read
   *  fails (transient: the feed retries the item, nothing is sent). */
  placedSale(senderId: string): Promise<PayInStoreSaleRecord | null>;
  /** `GET /chatbot-api/checkouts/status`: the live hold. Rejects → retry. */
  api: Pick<ChatbotApiClient, 'getCheckoutStatus'>;
  /** Local 24 h window; rejects when the read fails (never "closed"). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
  /** PAY_IN_STORE_TEMPLATES_ENABLED (exactly true): outside the 24 h window
   *  the reminder / expiry / deadline change go out as Meta templates.
   *  Absent or false → a closed window is STALE (WINDOW_CLOSED). */
  templatesEnabled?: boolean;
  clock?: () => Date;
}

export interface SalePickupHandler {
  plan(row: DeliveryRow, item: SalePickupItem): Promise<LivePlan>;
}

const SEND_DECISION: Record<SalePickupItem['type'], DeliveryDecision> = {
  'sale.pickup_reminder': 'PICKUP_REMINDER',
  'sale.pickup_expired': 'PICKUP_EXPIRED_NOTICE',
  'sale.pickup_extended': 'PICKUP_EXTENDED_NOTICE',
  'sale.pickup_expired_review': 'PICKUP_EXPIRED_REVIEW_NOTICE',
};

/** `undefined`: the backend did not report a hold (older answer). */
type LiveHold = CheckoutSaleHold | null | undefined;

/**
 * Pay in store S3: the sale.pickup_* feed items (backend contract
 * docs/chatbot-handoff/pay-in-store-hold-bot-contract.md). Wired only when
 * PAY_IN_STORE_ENABLED is on; without it the delivery service ACKs them
 * STALE as in T1. BOT messages, sent only while the 24 h window is open and
 * the chat is not HUMAN; never deferred (the backend answers 422 to a
 * DEFERRED_*), so the delivery service ACKs PROVIDER_ACCEPTED,
 * DELIVERY_UNKNOWN or STALE. STALE: no conversation, a sale the bot cannot
 * verify (not the chat's placed order, no checkout key, no hold), a paid
 * sale, a hold version below the live one, a reminder or extension of a
 * cancelled (expired) hold, or a closed window. With
 * PAY_IN_STORE_TEMPLATES_ENABLED a closed window sends the reminder, the
 * expiry and the deadline change as Meta templates
 * (odd/tasks/pay-in-store-templates.md S4); the expired-with-payment notice
 * has no template (staff contacts the customer) and stays STALE.
 *
 * Nothing here logs the conversation ref or the phone.
 */
export class SalePickupNoticeService implements SalePickupHandler {
  private readonly logger = new Logger(SalePickupNoticeService.name);
  private readonly clock: () => Date;

  constructor(private readonly ports: SalePickupNoticePorts) {
    this.clock = ports.clock ?? (() => new Date());
  }

  async plan(row: DeliveryRow, item: SalePickupItem): Promise<LivePlan> {
    const stale = (decision: DeliveryDecision, why: string): LivePlan => {
      this.logger.log(
        `feed item ${row.deliveryId} (${item.type}) not sent: ${why} (${decision})`,
      );
      return { action: 'stale', decision };
    };
    const senderId = senderIdFromRef(item.conversationRef);
    if (senderId === null)
      return stale('NO_CONVERSATION', 'no usable conversationRef');
    const record = await this.ports.placedSale(senderId);
    if (record === null || record.saleId !== item.saleId)
      return stale('SALE_UNKNOWN', 'not the conversation placed order');
    if (record.paid) return stale('SALE_CLOSED', 'the sale is paid');
    if (record.checkoutKey === null)
      return stale('SALE_UNKNOWN', 'no checkout key to read the hold');
    const hold = await this.liveHold(record.checkoutKey);
    if (hold === undefined || hold === null)
      return stale('SALE_UNKNOWN', 'no live hold reported');
    if (hold.version > item.payload.holdVersion)
      return stale('HOLD_SUPERSEDED', 'a later hold version exists');
    // Both expiries describe an expired hold (stage 2); the review one keeps
    // the sale open, so stage 2 does not close it.
    if (
      (item.type === 'sale.pickup_reminder' ||
        item.type === 'sale.pickup_extended') &&
      hold.stage >= 2
    )
      return stale(
        'SALE_CLOSED',
        'the hold expired and the sale was cancelled',
      );
    if (!(await this.ports.isWindowOpen(senderId))) {
      if (this.ports.templatesEnabled !== true)
        return stale(
          'WINDOW_CLOSED',
          'the 24 h window is closed (templates off)',
        );
      const template = this.template(item, record);
      if (template === null)
        return stale(
          'WINDOW_CLOSED',
          'the 24 h window is closed (no template for this notice)',
        );
      return {
        action: 'send',
        decision: SEND_DECISION[item.type],
        senderId,
        text: this.usted(item, record),
        template,
      };
    }
    const style = await this.readStyle(senderId);
    return {
      action: 'send',
      decision: SEND_DECISION[item.type],
      senderId,
      text: styleFixedCopy(this.usted(item, record), style),
    };
  }

  /**
   * The approved template of the notice (S4), `null` when there is none:
   * the expired-with-payment notice (staff contacts the customer) and an
   * item without a folio ({{1}} is required).
   */
  private template(
    item: SalePickupItem,
    record: PayInStoreSaleRecord,
  ): NoticeTemplate | null {
    const folio = item.payload.folio;
    if (folio === null || folio.trim() === '') return null;
    const base = {
      languageCode: PAY_IN_STORE_TEMPLATES.languageCode,
      // Meta refused it (not approved, missing): today's STALE.
      refusedDecision: 'WINDOW_CLOSED' as const,
    };
    const store = () =>
      payInStoreTemplateStoreText(
        record.pickupLocation,
        item.payload.branchName,
      );
    switch (item.type) {
      case 'sale.pickup_reminder':
        return {
          ...base,
          templateName: PAY_IN_STORE_TEMPLATES.reminder,
          bodyParameters: [
            folio,
            pickupReminderDeadline(item.payload.holdUntil, this.clock()),
            store(),
          ],
        };
      case 'sale.pickup_expired':
        return {
          ...base,
          templateName: PAY_IN_STORE_TEMPLATES.expired,
          bodyParameters: [folio],
        };
      case 'sale.pickup_extended':
        return {
          ...base,
          templateName: PAY_IN_STORE_TEMPLATES.updated,
          bodyParameters: [
            folio,
            pickupNewDeadline(item.payload.holdUntil),
            store(),
          ],
        };
      case 'sale.pickup_expired_review':
        return null;
    }
  }

  private usted(item: SalePickupItem, record: PayInStoreSaleRecord): string {
    switch (item.type) {
      case 'sale.pickup_reminder':
        return pickupReminderText({
          folio: item.payload.folio,
          holdUntil: item.payload.holdUntil,
          location: record.pickupLocation,
          branchName: item.payload.branchName,
          now: this.clock(),
        });
      case 'sale.pickup_expired':
        return pickupExpiredText(item.payload.folio);
      case 'sale.pickup_extended':
        return pickupExtendedText({
          folio: item.payload.folio,
          holdUntil: item.payload.holdUntil,
          ...(item.payload.previousHoldUntil === undefined
            ? {}
            : { previousHoldUntil: item.payload.previousHoldUntil }),
          ...(item.payload.direction === undefined
            ? {}
            : { direction: item.payload.direction }),
        });
      case 'sale.pickup_expired_review':
        return pickupExpiredReviewText(item.payload.folio);
    }
  }

  /** The sale's current hold; rejects when the read fails (retried). */
  private async liveHold(checkoutKey: string): Promise<LiveHold> {
    const status = await this.ports.api.getCheckoutStatus(checkoutKey);
    if (status.status !== 'succeeded') return undefined;
    return status.hold;
  }

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }
}
