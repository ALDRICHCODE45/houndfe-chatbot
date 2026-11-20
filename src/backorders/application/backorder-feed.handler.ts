import { Logger } from '@nestjs/common';
import type { BackorderFeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import type {
  BackorderFeedHandler,
  BackorderFeedPlan,
  BackorderNoticeTemplate,
} from '../../human-requests/domain/backorder-feed';
import {
  senderIdFromRef,
  type DeliveryDecision,
  type DeliveryRow,
} from '../../human-requests/domain/human-request-feed';
import {
  BACKORDER_CONFIRM_QUESTION,
  BACKORDER_RESCHEDULE_QUESTION,
  BACKORDER_TEMPLATE_DEFAULTS,
  BACKORDER_TEMPLATE_LANGUAGE,
  backorderConfirmButtons,
  backorderDeadline,
  backorderEstimateDate,
  backorderLabel,
  backorderMoney,
  backorderRescheduleButtons,
  cancelledNotice,
  expiredNotice,
  lostNotice,
  renderNotice,
  reminderNotice,
  reservedNotice,
  templateParameter,
  type BackorderTemplateNames,
} from '../domain/backorder-notices';

export { BACKORDER_TEMPLATE_DEFAULTS, type BackorderTemplateNames };

export interface BackorderFeedNoticePorts {
  /** Local 24 h window; rejects when the read fails (never "closed"). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
  /** `BACKORDER_TEMPLATES_ENABLED` (exactly `true`): outside the 24 h window
   *  the reserved / reminder / expired / lost notices go out as approved
   *  Meta templates. Absent or not `true` → no template is ever sent. */
  templatesEnabled?: boolean;
  /** Approved template names; defaults in `BACKORDER_TEMPLATE_DEFAULTS`. */
  templateNames?: Partial<BackorderTemplateNames>;
  /** The conversation of a customer whose feed item carries no
   *  `conversationRef` (none or several mirrored chats): `wa:<id>` or `null`
   *  when unknown. Rejects on a transient failure (the page is read again).
   *  Today `GET /chatbot-api/backorders/:id` names no phone, so nothing is
   *  wired and those items are unresolved (see docs/minimal-backorder.md). */
  resolveConversation?(backorderId: string): Promise<string | null>;
  clock?: () => Date;
}

type NoticeKind = 'reserved' | 'reminder' | 'expired' | 'lost' | 'cancelled';

const KIND: Record<string, NoticeKind | undefined> = {
  'backorder.reserved': 'reserved',
  'backorder.reservation_reminder': 'reminder',
  'backorder.reservation_expired': 'expired',
  'backorder.reservation_lost': 'lost',
  'backorder.cancelled_by_staff': 'cancelled',
};

const DECISION: Record<NoticeKind, DeliveryDecision> = {
  reserved: 'BACKORDER_RESERVED_NOTICE',
  reminder: 'BACKORDER_REMINDER_NOTICE',
  expired: 'BACKORDER_EXPIRED_NOTICE',
  lost: 'BACKORDER_LOST_NOTICE',
  cancelled: 'BACKORDER_CANCELLED_NOTICE',
};

/** The two notices the customer can still act on: when they cannot be
 *  delivered the backend alerts staff to call (S13), via PROVIDER_REJECTED. */
const alerts = (kind: NoticeKind): boolean =>
  kind === 'reserved' || kind === 'reminder';

/** What a notice needs, read and checked from the feed item. */
interface Content {
  folio: string;
  firstName: string | null;
  productName: string;
  label: string;
  quantity: number;
  finalPriceCents: number;
  referencePriceCents: number | null;
  /** `backorderDeadline` of `reservedUntil`. */
  deadline: string;
  reservedUntilMs: number;
  estimatedAt: string | null;
  reason: string | null;
  offerReschedule: boolean;
}

/** One line, single spaces: names come from staff-entered data. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();
const text = (value: unknown): string | null =>
  typeof value === 'string' && oneLine(value) !== '' ? oneLine(value) : null;
const cents = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

/**
 * Restock backorder T5a: the `BackorderFeedHandler` (S4, S6, S9, S12, S13,
 * S15). Plans one notice per `backorder.*` feed item; the delivery service
 * executes it as a BOT notice (never deferred) and owns the ACK.
 *
 *   - reserved / reminder: text + [Confirmar pedido] [Ya no lo quiero].
 *   - expired: text, plus [Sí, agéndalo] [No, gracias] only when the backend
 *     names `sourceDecisionId` (a reschedule needs the source decision).
 *   - lost: the apology. cancelled_by_staff: the team's reason.
 *   - eta_updated / eta_unavailable: STALE until T6 (S7).
 *   - Outside the 24 h window: approved templates when
 *     `BACKORDER_TEMPLATES_ENABLED`; otherwise reserved / reminder are
 *     `PROVIDER_REJECTED TEMPLATE_NOT_APPROVED` (staff calls the customer)
 *     and the rest `STALE`.
 *   - A customer whose chat cannot be resolved is never messaged.
 *
 * Nothing here logs the conversation ref or the phone.
 */
export class BackorderFeedNoticeService implements BackorderFeedHandler {
  private readonly logger = new Logger(BackorderFeedNoticeService.name);
  private readonly clock: () => Date;

  constructor(private readonly ports: BackorderFeedNoticePorts) {
    this.clock = ports.clock ?? (() => new Date());
  }

  async plan(
    row: DeliveryRow,
    item: BackorderFeedItem,
  ): Promise<BackorderFeedPlan> {
    if (
      item.type === 'backorder.eta_updated' ||
      item.type === 'backorder.eta_unavailable'
    ) {
      // Backend T4: the ETA slip is handled by T6 (S7); STALE for now.
      this.logger.log(
        `feed item ${row.deliveryId} ${item.type}: not handled yet (S7): STALE`,
      );
      return { action: 'stale', decision: 'BACKORDER_ETA_PENDING' };
    }
    const kind = KIND[item.type];
    if (kind === undefined) {
      this.logger.log(
        `feed item ${row.deliveryId} of unknown backorder type: STALE`,
      );
      return { action: 'stale', decision: 'UNKNOWN_TYPE' };
    }
    return this.notice(row, item, kind);
  }

  private async notice(
    row: DeliveryRow,
    item: BackorderFeedItem,
    kind: NoticeKind,
  ): Promise<BackorderFeedPlan> {
    const now = this.clock();
    /** Reserved / reminder alert staff (PROVIDER_REJECTED); the rest are STALE. */
    const cannotDeliver = (
      decision: DeliveryDecision,
      reason: string,
      staleDecision: DeliveryDecision = decision,
    ): BackorderFeedPlan =>
      alerts(kind)
        ? { action: 'rejected', decision, reason }
        : { action: 'stale', decision: staleDecision };

    const content = this.read(item, kind, now);
    if (content === null) {
      this.logger.warn(
        `feed item ${row.deliveryId} ${item.type}: the payload cannot be worded`,
      );
      return cannotDeliver('BACKORDER_PAYLOAD_INVALID', 'PAYLOAD_INVALID');
    }
    if (
      (kind === 'reserved' || kind === 'reminder') &&
      content.reservedUntilMs <= now.getTime()
    ) {
      this.logger.log(
        `feed item ${row.deliveryId} ${item.type}: the reservation deadline already passed: STALE`,
      );
      return { action: 'stale', decision: 'BACKORDER_OVERTAKEN' };
    }

    const senderId = await this.recipient(row, item);
    if (senderId === null)
      return cannotDeliver('NO_CONVERSATION', 'NO_CONVERSATION');

    const decision = DECISION[kind];
    const staffAlert = alerts(kind) ? ({ staffAlert: true } as const) : {};

    if (!(await this.ports.isWindowOpen(senderId))) {
      const template =
        this.ports.templatesEnabled === true
          ? this.template(kind, content)
          : null;
      if (template === null) {
        this.logger.log(
          `feed item ${row.deliveryId} ${item.type}: the 24 h window is closed and no template is enabled`,
        );
        return alerts(kind)
          ? {
              action: 'rejected',
              decision: 'TEMPLATE_NOT_APPROVED',
              reason: 'TEMPLATE_NOT_APPROVED',
            }
          : { action: 'stale', decision: 'WINDOW_CLOSED' };
      }
      return {
        action: 'send',
        decision,
        senderId,
        text: this.usted(kind, content, null),
        template,
        ...staffAlert,
      };
    }

    const style = await this.readStyle(senderId);
    const body = this.usted(kind, content, style);
    const buttons = this.buttons(kind, item, content, style);
    return {
      action: 'send',
      decision,
      senderId,
      text: body,
      ...(buttons === null ? {} : buttons),
      ...staffAlert,
    };
  }

  // ----------------------------------------------------------- reading

  /** The item's data, or `null` when the notice cannot be worded. */
  private read(
    item: BackorderFeedItem,
    kind: NoticeKind,
    now: Date,
  ): Content | null {
    const { payload } = item;
    const raw = payload.raw;
    const folio = text(payload.folio);
    if (folio === null) return null;
    const productName = text(payload.productName);
    const variantName = text(payload.variantName);
    const quantity = payload.quantity;
    if (kind !== 'reminder' && kind !== 'cancelled' && productName === null)
      return null;
    if (kind === 'reserved' && quantity === null) return null;

    let deadline = '';
    let reservedUntilMs = Number.POSITIVE_INFINITY;
    if (kind === 'reserved' || kind === 'reminder') {
      const until = text(raw.reservedUntil);
      const at = until === null ? Number.NaN : Date.parse(until);
      const when = until === null ? null : backorderDeadline(until, now);
      if (until === null || Number.isNaN(at) || when === null) return null;
      deadline = when;
      reservedUntilMs = at;
    }
    const finalPriceCents = cents(raw.finalPriceCents);
    if (kind === 'reserved' && finalPriceCents === null) return null;

    const sourceDecisionId = text(raw.sourceDecisionId);
    return {
      folio,
      firstName: text(payload.customerFirstName),
      productName: productName ?? '',
      label: backorderLabel(productName ?? '', variantName),
      quantity: quantity ?? 1,
      finalPriceCents: finalPriceCents ?? 0,
      referencePriceCents: cents(raw.referencePriceCents),
      deadline,
      reservedUntilMs,
      estimatedAt: text(raw.estimatedAt),
      reason: text(raw.reason),
      offerReschedule: kind === 'expired' && sourceDecisionId !== null,
    };
  }

  /** The recipient (`5215512349901`), or `null`: never a guess. */
  private async recipient(
    row: DeliveryRow,
    item: BackorderFeedItem,
  ): Promise<string | null> {
    if (item.conversationRef !== null) {
      const senderId = senderIdFromRef(item.conversationRef);
      if (senderId === null)
        this.logger.warn(
          `feed item ${row.deliveryId} ${item.type}: malformed conversationRef: customer unresolved`,
        );
      return senderId;
    }
    const resolved =
      this.ports.resolveConversation === undefined
        ? null
        : await this.ports.resolveConversation(item.payload.backorderId);
    const senderId = senderIdFromRef(resolved);
    if (senderId === null)
      this.logger.warn(
        `feed item ${row.deliveryId} ${item.type}: no conversationRef and the customer could not be resolved: nothing is sent`,
      );
    return senderId;
  }

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- copy

  private usted(
    kind: NoticeKind,
    content: Content,
    style: CustomerStyle | null,
  ): string {
    const now = this.clock();
    switch (kind) {
      case 'reserved':
        return reservedNotice(
          {
            firstName: content.firstName,
            folio: content.folio,
            quantity: content.quantity,
            label: content.label,
            finalPriceCents: content.finalPriceCents,
            referencePriceCents: content.referencePriceCents,
            deadline: content.deadline,
          },
          style,
        );
      case 'reminder':
        return reminderNotice(
          { folio: content.folio, deadline: content.deadline },
          style,
        );
      case 'expired':
        return expiredNotice(
          {
            folio: content.folio,
            productName: content.productName,
            offerReschedule: content.offerReschedule,
          },
          style,
        );
      case 'lost':
        return lostNotice(
          {
            firstName: content.firstName,
            productName: content.productName,
            folio: content.folio,
            estimateDate: backorderEstimateDate(content.estimatedAt, now),
          },
          style,
        );
      case 'cancelled':
        return cancelledNotice(
          { folio: content.folio, reason: content.reason },
          style,
        );
    }
  }

  /** Reply buttons of the notice, with the short body used when the text is
   *  over Meta's interactive limit; `null` for a notice without buttons. */
  private buttons(
    kind: NoticeKind,
    item: BackorderFeedItem,
    content: Content,
    style: CustomerStyle | null,
  ): {
    buttons: ReadonlyArray<{ id: string; title: string }>;
    shortBody: string;
  } | null {
    const id = item.payload.backorderId;
    if (kind === 'reserved' || kind === 'reminder')
      return {
        buttons: backorderConfirmButtons(id),
        shortBody: renderNotice(BACKORDER_CONFIRM_QUESTION, {}, style),
      };
    if (kind === 'expired' && content.offerReschedule)
      return {
        buttons: backorderRescheduleButtons(id),
        shortBody: renderNotice(BACKORDER_RESCHEDULE_QUESTION, {}, style),
      };
    return null;
  }

  // --------------------------------------------------------- templates

  /**
   * The approved template of the notice (S9), `null` when there is none
   * (cancelled_by_staff has no template) or a parameter would be empty.
   * Templates carry no buttons: the customer answers in text.
   */
  private template(
    kind: NoticeKind,
    content: Content,
  ): BackorderNoticeTemplate | null {
    const names = {
      ...BACKORDER_TEMPLATE_DEFAULTS,
      ...this.ports.templateNames,
    };
    const name = content.firstName ?? 'cliente';
    const lowered =
      content.referencePriceCents !== null &&
      content.finalPriceCents < content.referencePriceCents;
    let templateName: string;
    let values: string[];
    switch (kind) {
      case 'reserved':
        templateName = names.reserved;
        values = [
          name,
          content.folio,
          `${content.quantity} × ${content.label}`,
          lowered
            ? `${backorderMoney(content.finalPriceCents)} (bajó de precio)`
            : backorderMoney(content.finalPriceCents),
          content.deadline,
        ];
        break;
      case 'reminder':
        templateName = names.reminder;
        values = [content.folio, content.deadline];
        break;
      case 'expired':
        templateName = names.expired;
        values = [content.folio, content.productName];
        break;
      case 'lost': {
        templateName = names.lost;
        const date = backorderEstimateDate(content.estimatedAt, this.clock());
        values = [
          name,
          content.productName,
          content.folio,
          date === null ? 'fecha por confirmar' : `aprox. ${date}`,
        ];
        break;
      }
      case 'cancelled':
        return null;
    }
    const bodyParameters: string[] = [];
    for (const value of values) {
      const parameter = templateParameter(value);
      if (parameter === null) return null;
      bodyParameters.push(parameter);
    }
    return {
      templateName,
      languageCode: BACKORDER_TEMPLATE_LANGUAGE,
      bodyParameters,
      refusedDecision: 'TEMPLATE_NOT_APPROVED',
    };
  }
}
