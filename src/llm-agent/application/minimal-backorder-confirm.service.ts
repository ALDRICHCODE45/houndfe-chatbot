import { Logger } from '@nestjs/common';
import {
  BACKORDER_ERROR,
  type BackorderBot,
  type BackorderClient,
  type BackorderCustomerInput,
} from '../../backorders/domain/backorder';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { normalizeCustomerCheckoutContext } from '../../chatbot-api/domain/dtos/checkout-context.dto';
import {
  ChatbotApiError,
  NotFoundError,
} from '../../chatbot-api/domain/errors';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  BACKORDER_CANCELLED_ALREADY_REPLY,
  BACKORDER_CONFIRMED_ALREADY_REPLY,
  BACKORDER_CONFIRM_FAILED_REPLY,
  BACKORDER_CONFIRM_NOT_FOUND_REPLY,
  BACKORDER_FAILED_REPLY,
  BACKORDER_RESCHEDULE_DECLINE_REPLY,
  BACKORDER_RESCHEDULE_PROMPT,
  BACKORDER_RESCHEDULE_QUESTION,
  BACKORDER_RESCHEDULE_UNAVAILABLE_REPLY,
  BACKORDER_RETRY_REPLY,
  backorderAvailableNowReply,
  backorderDuplicateReply,
  backorderExpiredReply,
  backorderInactiveReply,
  backorderNotReservedYetReply,
  backorderRescheduleStateReply,
  backorderScheduledReply,
  backorderStatusReply,
} from '../domain/backorder-copy';
import { isBackorderConfirmText } from '../domain/backorder-confirm';
import {
  backorderRescheduleButtons,
  parseInteractiveReplyId,
  type CustomerReplyInteractive,
} from '../domain/customer-reply';

export interface MinimalBackorderConfirmDeps {
  readonly backorders: BackorderClient;
  readonly chatbotApi: Pick<ChatbotApiClient, 'getCustomerCheckoutContext'>;
  /** Test seam; production uses `Date.now`. */
  readonly clock?: () => number;
}

/**
 * What the customer turn answers. `add`: the backorder is RESERVED, belongs to
 * the customer and its deadline is in the future: the caller puts it in the
 * cart. `null` (from `handle`) leaves the turn to the other routes.
 */
export type MinimalBackorderConfirmTurn =
  | {
      readonly kind: 'reply';
      readonly reply: string;
      readonly interactive?: CustomerReplyInteractive;
    }
  | { readonly kind: 'add'; readonly backorder: BackorderBot };

/** The RESTOCK decision a backorder was scheduled from, when the backend says. */
export function sourceDecisionOf(backorder: BackorderBot): string | null {
  const value = (backorder as { sourceDecisionId?: unknown }).sourceDecisionId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `backorder-reschedule:<backorderId>`: one new backorder per expired one. */
export const backorderRescheduleKey = (backorderId: string): string =>
  `backorder-reschedule:${backorderId}`;

type Phone = { phoneCountryCode: string; phone: string };

/**
 * Restock backorder T5b (S6): the customer confirms a RESERVED backorder, or
 * schedules an expired one again. Deterministic: no model call; the only I/O
 * is the backorder client and the customer lookup.
 *
 * CONFIRM triggers (the caller adds the cart line, see `kind: 'add'`)
 *   - a tap of `backorder_confirm:<id>` (the arrival / reminder notice): never
 *     blocked by a pending cart or order, it names the backorder itself;
 *   - a bare yes / «confirmo» / «sí lo quiero» ONLY when the customer has
 *     exactly ONE RESERVED backorder and `bareYesAllowed()` is true (the
 *     caller: no competing order context, no other question pending). Without
 *     certainty (a failed read, several reserved, a throw) the turn is not
 *     ours and `null` leaves it to the other flows.
 * Both verify the backorder against `GET :id` and the customer's own list
 * (same phone), and answer honestly when it is not RESERVED, expired,
 * confirmed, cancelled or unknown.
 */
export class MinimalBackorderConfirmService {
  private readonly logger = new Logger(MinimalBackorderConfirmService.name);
  private readonly clock: () => number;

  constructor(private readonly deps: MinimalBackorderConfirmDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  async handle(input: {
    senderId: string;
    text: string;
    interactiveReplyId?: string;
    /** A bare yes is only ours when nothing else could own it. */
    bareYesAllowed: () => Promise<boolean>;
  }): Promise<MinimalBackorderConfirmTurn | null> {
    const phone = parseMexicanWhatsAppPhone(input.senderId);
    if (phone === null) return null;
    if (input.interactiveReplyId !== undefined) {
      const intent = parseInteractiveReplyId(input.interactiveReplyId);
      switch (intent?.kind) {
        case 'backorder_confirm':
          return this.confirm(phone, intent.reference);
        case 'backorder_reschedule':
          return this.reschedule(phone, intent.reference);
        case 'backorder_reschedule_decline':
          return this.reply(BACKORDER_RESCHEDULE_DECLINE_REPLY);
        default:
          return null;
      }
    }
    if (!isBackorderConfirmText(input.text)) return null;
    if (!(await this.allowed(input.bareYesAllowed))) return null;
    let reserved: BackorderBot[];
    try {
      reserved = (
        await this.deps.backorders.listBackorders({
          ...phone,
          status: 'RESERVED',
        })
      ).filter((backorder) => backorder.status === 'RESERVED');
    } catch (error) {
      this.logFailure('confirm list', error);
      return null;
    }
    return reserved.length === 1 ? this.confirm(phone, reserved[0].id) : null;
  }

  private reply(
    reply: string,
    interactive?: CustomerReplyInteractive,
  ): MinimalBackorderConfirmTurn {
    return {
      kind: 'reply',
      reply,
      ...(interactive === undefined ? {} : { interactive }),
    };
  }

  private async allowed(check: () => Promise<boolean>): Promise<boolean> {
    try {
      return await check();
    } catch {
      return false;
    }
  }

  /**
   * The customer's backorder `id`, read fresh: `NOT_FOUND` when it is not in
   * the customer's own list (another phone's backorder looks the same as an
   * unknown one), `FAILED` when it cannot be read.
   */
  private async load(
    phone: Phone,
    id: string,
  ): Promise<BackorderBot | 'NOT_FOUND' | 'FAILED'> {
    try {
      const own = await this.deps.backorders.listBackorders({ ...phone });
      if (!own.some((backorder) => backorder.id === id)) return 'NOT_FOUND';
      return await this.deps.backorders.getBackorder(id);
    } catch (error) {
      this.logFailure('confirm read', error);
      return error instanceof NotFoundError ||
        (error instanceof ChatbotApiError &&
          error.statusCode === 404 &&
          error.errorCode === BACKORDER_ERROR.BACKORDER_NOT_FOUND)
        ? 'NOT_FOUND'
        : 'FAILED';
    }
  }

  private async confirm(
    phone: Phone,
    id: string,
  ): Promise<MinimalBackorderConfirmTurn> {
    const backorder = await this.load(phone, id);
    if (backorder === 'NOT_FOUND')
      return this.reply(BACKORDER_CONFIRM_NOT_FOUND_REPLY);
    if (backorder === 'FAILED')
      return this.reply(BACKORDER_CONFIRM_FAILED_REPLY);
    const now = this.clock();
    switch (backorder.status) {
      case 'RESERVED': {
        const until =
          backorder.reservedUntil === null
            ? Number.NaN
            : Date.parse(backorder.reservedUntil);
        if (!(until > now)) return this.expired(backorder);
        // The price is the final price frozen at reservation; without it the
        // line cannot be priced and nothing is added.
        if (backorder.finalPriceCents === null)
          return this.reply(BACKORDER_CONFIRM_FAILED_REPLY);
        return { kind: 'add', backorder };
      }
      case 'EXPIRED':
        return this.expired(backorder);
      case 'CONFIRMED':
        return this.reply(BACKORDER_CONFIRMED_ALREADY_REPLY);
      case 'CANCELLED':
        return this.reply(BACKORDER_CANCELLED_ALREADY_REPLY);
      default:
        return this.reply(backorderNotReservedYetReply(backorder));
    }
  }

  /** «Se venció el apartado…», with the reschedule offer when it can be made. */
  private expired(backorder: BackorderBot): MinimalBackorderConfirmTurn {
    if (sourceDecisionOf(backorder) === null)
      return this.reply(backorderExpiredReply(backorder));
    return this.reply(
      `${backorderExpiredReply(backorder)} ${BACKORDER_RESCHEDULE_QUESTION}`,
      backorderRescheduleButtons(backorder.id, BACKORDER_RESCHEDULE_PROMPT),
    );
  }

  // --- reschedule after an expiry ---------------------------------------

  private async reschedule(
    phone: Phone,
    id: string,
  ): Promise<MinimalBackorderConfirmTurn> {
    const old = await this.load(phone, id);
    if (old === 'NOT_FOUND')
      return this.reply(BACKORDER_CONFIRM_NOT_FOUND_REPLY);
    if (old === 'FAILED') return this.reply(BACKORDER_CONFIRM_FAILED_REPLY);
    if (old.status !== 'EXPIRED' && old.status !== 'CANCELLED')
      return this.reply(backorderRescheduleStateReply(old));
    const sourceDecisionId = sourceDecisionOf(old);
    if (sourceDecisionId === null)
      return this.reply(BACKORDER_RESCHEDULE_UNAVAILABLE_REPLY);
    const customer = await this.customer(phone, old);
    if (customer === 'RETRY') return this.reply(BACKORDER_RETRY_REPLY);
    if (customer === 'FAILED') return this.reply(BACKORDER_FAILED_REPLY);
    try {
      const { backorder } = await this.deps.backorders.createBackorder(
        {
          ...phone,
          customer,
          productId: old.productId,
          variantId: old.variantId,
          quantity: old.quantity,
          sourceDecisionId,
        },
        backorderRescheduleKey(old.id),
      );
      return this.reply(this.stateReply(backorder));
    } catch (error) {
      return this.rescheduleFailed(error, old);
    }
  }

  /** The same customer as checkout: the existing one, never a guessed one. */
  private async customer(
    phone: Phone,
    old: BackorderBot,
  ): Promise<BackorderCustomerInput | 'RETRY' | 'FAILED'> {
    let raw: unknown;
    try {
      raw = await this.deps.chatbotApi.getCustomerCheckoutContext(
        phone.phoneCountryCode,
        phone.phone,
        { limit: 1 },
      );
    } catch (error) {
      this.logFailure('reschedule customer', error);
      return 'RETRY';
    }
    const context = normalizeCustomerCheckoutContext(raw);
    if (context === null || context.status === 'ambiguous') return 'FAILED';
    if (context.status === 'unique')
      return { mode: 'existing', customerId: context.customer.customerId };
    return old.customerFirstName === null
      ? 'FAILED'
      : { mode: 'createIfAbsent', firstName: old.customerFirstName };
  }

  private stateReply(backorder: BackorderBot): string {
    const now = new Date(this.clock());
    if (backorder.status === 'WAITING')
      return backorderScheduledReply(backorder, now);
    return backorder.status === 'RESERVED'
      ? backorderStatusReply(backorder, now)
      : backorderInactiveReply(backorder);
  }

  private async rescheduleFailed(
    error: unknown,
    old: BackorderBot,
  ): Promise<MinimalBackorderConfirmTurn> {
    this.logFailure('reschedule', error);
    if (!(error instanceof ChatbotApiError))
      return this.reply(BACKORDER_RETRY_REPLY);
    const { statusCode: status, errorCode: code } = error;
    if (status === 409 && code === BACKORDER_ERROR.STOCK_AVAILABLE_NOW)
      return this.reply(backorderAvailableNowReply(old.productName));
    if (status === 409 && code === BACKORDER_ERROR.BACKORDER_DUPLICATE)
      return this.reply(await this.duplicateReply(error));
    const retryable =
      status === null ||
      status === 429 ||
      status >= 500 ||
      (status === 409 && code === BACKORDER_ERROR.IDEMPOTENCY_KEY_IN_FLIGHT);
    return this.reply(
      retryable ? BACKORDER_RETRY_REPLY : BACKORDER_FAILED_REPLY,
    );
  }

  private async duplicateReply(error: ChatbotApiError): Promise<string> {
    const body = error.responseBody;
    const id =
      typeof body === 'object' && body !== null
        ? (body as { backorderId?: unknown }).backorderId
        : undefined;
    if (typeof id !== 'string') return backorderDuplicateReply(null);
    try {
      return backorderDuplicateReply(
        await this.deps.backorders.getBackorder(id),
      );
    } catch (failure) {
      this.logFailure('duplicate read', failure);
      return backorderDuplicateReply(null);
    }
  }

  /** Status and code only: a body could carry customer data. */
  private logFailure(what: string, error: unknown): void {
    const status = error instanceof ChatbotApiError ? error.statusCode : null;
    const code = error instanceof ChatbotApiError ? error.errorCode : null;
    this.logger.warn(
      `backorder ${what} failed: status=${status ?? 'none'} code=${code ?? 'none'}`,
    );
  }
}
