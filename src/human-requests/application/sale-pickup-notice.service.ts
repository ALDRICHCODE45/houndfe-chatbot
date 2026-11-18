import { Logger } from '@nestjs/common';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  CheckoutPickupLocation,
  CheckoutSaleHold,
} from '../../chatbot-api/domain/dtos/checkout.dto';
import type { SalePickupItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import {
  pickupExpiredText,
  pickupExtendedText,
  pickupReminderText,
} from '../../pay-in-store/domain/pay-in-store-copy';
import {
  senderIdFromRef,
  styleFixedCopy,
  type DeliveryDecision,
  type DeliveryRow,
} from '../domain/human-request-feed';
import type { LivePlan } from './live-conversation.service';

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
  clock?: () => Date;
}

export interface SalePickupHandler {
  plan(row: DeliveryRow, item: SalePickupItem): Promise<LivePlan>;
}

const SEND_DECISION: Record<SalePickupItem['type'], DeliveryDecision> = {
  'sale.pickup_reminder': 'PICKUP_REMINDER',
  'sale.pickup_expired': 'PICKUP_EXPIRED_NOTICE',
  'sale.pickup_extended': 'PICKUP_EXTENDED_NOTICE',
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
 * cancelled (expired) hold, or a closed window (this bot has no approved
 * template for these notices).
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
    if (item.type !== 'sale.pickup_expired' && hold.stage >= 2)
      return stale(
        'SALE_CLOSED',
        'the hold expired and the sale was cancelled',
      );
    if (!(await this.ports.isWindowOpen(senderId)))
      return stale('WINDOW_CLOSED', 'the 24 h window is closed (no template)');
    const style = await this.readStyle(senderId);
    return {
      action: 'send',
      decision: SEND_DECISION[item.type],
      senderId,
      text: styleFixedCopy(this.usted(item, record), style),
    };
  }

  private usted(item: SalePickupItem, record: PayInStoreSaleRecord): string {
    switch (item.type) {
      case 'sale.pickup_reminder':
        return pickupReminderText({
          folio: item.payload.folio,
          holdUntil: item.payload.holdUntil,
          location: record.pickupLocation,
          now: this.clock(),
        });
      case 'sale.pickup_expired':
        return pickupExpiredText(item.payload.folio);
      case 'sale.pickup_extended':
        return pickupExtendedText({
          folio: item.payload.folio,
          holdUntil: item.payload.holdUntil,
        });
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
