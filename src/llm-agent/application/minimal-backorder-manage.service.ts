import { Logger } from '@nestjs/common';
import {
  BACKORDER_ERROR,
  type BackorderBot,
  type BackorderClient,
} from '../../backorders/domain/backorder';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  BACKORDER_CANCEL_FAILED_REPLY,
  BACKORDER_CANCEL_PICK_PROMPT,
  BACKORDER_STATUS_FAILED_REPLY,
  backorderCancelKeptReply,
  backorderCancelledReply,
  backorderCancelPickReply,
  backorderCancelPrompt,
  backorderCancelQuestion,
  backorderNotCancellableReply,
  backorderStatusListReply,
  backorderStatusReply,
  isActiveBackorder,
} from '../domain/backorder-copy';
import {
  backorderFolioIn,
  classifyBackorderRequest,
  type BackorderRequest,
} from '../domain/backorder-requests';
import { classifyConfirmationReply } from '../domain/confirmation-reply';
import {
  backorderCancelButtons,
  backorderCancelPick,
  parseInteractiveReplyId,
  type CustomerReplyInteractive,
} from '../domain/customer-reply';

/** S7: the answer to «Seguir esperando». */
export const BACKORDER_WAIT_REPLY = 'Perfecto, le aviso en cuanto llegue.';

export interface MinimalBackorderManageDeps {
  readonly backorders: BackorderClient;
  /** Test seam; production uses `Date.now`. */
  readonly clock?: () => number;
}

/** What the customer turn answers; `null` leaves the turn to the other routes. */
export type MinimalBackorderManageTurn =
  | {
      readonly kind: 'reply';
      readonly reply: string;
      readonly interactive?: CustomerReplyInteractive;
    }
  /** A tapped cancel button that no longer answers anything. */
  | { readonly kind: 'stale' };

/** How long the cancel question (or the pick) waits for its answer. */
export const BACKORDER_MANAGE_PENDING_TTL_MS = 5 * 60 * 1000;

/** Rows a pick can show (WhatsApp list cap). */
const PICK_MAX = 10;
const ACTIVE_STATUSES = 'WAITING,RESERVED';

type Pending =
  | {
      readonly kind: 'confirm';
      readonly backorderId: string;
      readonly folio: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: 'pick';
      readonly backorders: readonly BackorderBot[];
      readonly expiresAt: number;
    };

/** «cancela», «cancélalo», «sí, cancela»: a yes to the cancel question. */
const BARE_CANCEL =
  /^(?:si\s+)?cancel(?:a|ar|alo|ala)(?:\s+(?:por favor|porfa))?$/;

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Restock backorder S8 (T6): the customer asks, from the chat, to cancel a
 * scheduled restock order or how it is going. Deterministic (no model): the
 * only I/O is the backorder client (`listBackorders`, `cancelBackorder`).
 *
 * TRIGGER (conservative, see `classifyBackorderRequest`)
 *   - a typed message must read as a cancel or status request about the
 *     restock order, AND the customer must have an ACTIVE backorder (WAITING
 *     or RESERVED, listed by phone). Anything else returns `null`, so the
 *     existing flows (cart, placed order, payment, the model) answer exactly
 *     as before. A message that is no request never reaches the backend.
 *   - explicit wording («por reposición», «lo que aparté», a `BO-` folio) is
 *     enough. Generic wording («ya no quiero el pedido», «¿cómo va mi
 *     pedido?») additionally requires `competingOrderContext()` to be false:
 *     no cart, pending summary, delivery draft or placed sale. Without
 *     certainty (the check throws) generic wording is not ours.
 *
 * CANCEL asks once, naming the backorder («¿Cancelo su pedido {folio} de
 * {quantity} × {product}?», [Sí, cancelar] [No]); with several it asks which
 * first (buttons up to three, else a list; a typed folio also answers).
 * The question is process-local state with a 5-minute expiry (no gate kind, so
 * no migration): a restart only loses the typed yes, while a tapped button
 * carries the backorder id and is re-verified against the customer's own
 * active list, so it still works. Any other message spends the question.
 */
export class MinimalBackorderManageService {
  private readonly logger = new Logger(MinimalBackorderManageService.name);
  private readonly clock: () => number;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: MinimalBackorderManageDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  async handle(input: {
    senderId: string;
    text: string;
    interactiveReplyId?: string;
    /**
     * Another order or purchase is in progress (cart, pending summary,
     * delivery draft, placed sale). Evaluated only for generic wording.
     */
    competingOrderContext: () => Promise<boolean>;
  }): Promise<MinimalBackorderManageTurn | null> {
    const { senderId } = input;
    const phone = parseMexicanWhatsAppPhone(senderId);
    if (phone === null) return null;
    const pending = this.livePending(senderId);

    if (input.interactiveReplyId !== undefined) {
      const intent = parseInteractiveReplyId(input.interactiveReplyId);
      if (intent?.kind === 'backorder_wait') {
        // Another button is another message: it spends the question.
        this.pending.delete(senderId);
        return this.wait(phone, intent.reference);
      }
      if (intent?.kind !== 'backorder_cancel') {
        // Another button is another message: it spends the question.
        this.pending.delete(senderId);
        return null;
      }
      this.pending.delete(senderId);
      return this.tap(senderId, phone, intent, pending);
    }

    if (pending?.kind === 'confirm') {
      // Spent before any await, so a double yes cancels once.
      this.pending.delete(senderId);
      const verdict = BARE_CANCEL.test(fold(input.text))
        ? 'accept'
        : classifyConfirmationReply(input.text);
      if (verdict === 'accept')
        return this.cancel(pending.backorderId, pending);
      if (verdict === 'decline')
        return this.reply(backorderCancelKeptReply(pending));
    } else if (pending?.kind === 'pick') {
      this.pending.delete(senderId);
      const folio = backorderFolioIn(input.text);
      const chosen = pending.backorders.find((item) => item.folio === folio);
      if (chosen !== undefined) return this.ask(senderId, chosen);
    }

    const request = classifyBackorderRequest(input.text);
    if (request === null) return null;
    if (!request.explicit && !(await this.alone(input.competingOrderContext)))
      return null;
    const active = await this.listActive(phone);
    if (active === null)
      return request.explicit ? this.reply(this.failedCopy(request)) : null;
    if (active.length === 0) return null;
    if (request.kind === 'status') return this.status(active);
    return active.length === 1
      ? this.ask(senderId, active[0])
      : this.askWhich(senderId, active);
  }

  private reply(
    reply: string,
    interactive?: CustomerReplyInteractive,
  ): MinimalBackorderManageTurn {
    return {
      kind: 'reply',
      reply,
      ...(interactive === undefined ? {} : { interactive }),
    };
  }

  private failedCopy(request: BackorderRequest): string {
    return request.kind === 'cancel'
      ? BACKORDER_CANCEL_FAILED_REPLY
      : BACKORDER_STATUS_FAILED_REPLY;
  }

  private livePending(senderId: string): Pending | null {
    const pending = this.pending.get(senderId);
    if (pending === undefined) return null;
    if (this.clock() >= pending.expiresAt) {
      this.pending.delete(senderId);
      return null;
    }
    return pending;
  }

  private expiry(): number {
    return this.clock() + BACKORDER_MANAGE_PENDING_TTL_MS;
  }

  /** Generic wording is ours only with no other order in play (fails closed). */
  private async alone(competing: () => Promise<boolean>): Promise<boolean> {
    try {
      return !(await competing());
    } catch {
      return false;
    }
  }

  /** The customer's active backorders, or `null` when they cannot be read. */
  private async listActive(phone: {
    phoneCountryCode: string;
    phone: string;
  }): Promise<BackorderBot[] | null> {
    try {
      const items = await this.deps.backorders.listBackorders({
        phoneCountryCode: phone.phoneCountryCode,
        phone: phone.phone,
        status: ACTIVE_STATUSES,
      });
      return items.filter(isActiveBackorder);
    } catch (error) {
      this.logFailure('list', error);
      return null;
    }
  }

  private status(active: readonly BackorderBot[]): MinimalBackorderManageTurn {
    const now = new Date(this.clock());
    return this.reply(
      active.length === 1
        ? backorderStatusReply(active[0], now)
        : backorderStatusListReply(active, now),
    );
  }

  /** The one confirmation question; recorded so a typed yes answers it. */
  private ask(
    senderId: string,
    backorder: BackorderBot,
  ): MinimalBackorderManageTurn {
    this.pending.set(senderId, {
      kind: 'confirm',
      backorderId: backorder.id,
      folio: backorder.folio,
      expiresAt: this.expiry(),
    });
    return this.reply(
      backorderCancelQuestion(backorder),
      backorderCancelButtons(backorder.id, backorderCancelPrompt(backorder)),
    );
  }

  private askWhich(
    senderId: string,
    active: readonly BackorderBot[],
  ): MinimalBackorderManageTurn {
    const shown = active.slice(0, PICK_MAX);
    this.pending.set(senderId, {
      kind: 'pick',
      backorders: shown,
      expiresAt: this.expiry(),
    });
    return this.reply(
      backorderCancelPickReply(shown),
      backorderCancelPick(
        shown.map((backorder) => ({
          id: backorder.id,
          folio: backorder.folio,
          description: `${backorder.quantity} × ${backorder.productName}`,
        })),
        BACKORDER_CANCEL_PICK_PROMPT,
      ) ?? undefined,
    );
  }

  /**
   * S7: «Seguir esperando» under an ETA notice. No backend write: the
   * backorder stays WAITING in its place. The promise is only made while the
   * customer's own list still shows it WAITING (a reserved, cancelled or
   * unknown one is a stale button; an unreadable list never promises).
   */
  private async wait(
    phone: { phoneCountryCode: string; phone: string },
    backorderId: string,
  ): Promise<MinimalBackorderManageTurn> {
    const active = await this.listActive(phone);
    if (active === null) return this.reply(BACKORDER_STATUS_FAILED_REPLY);
    const target = active.find((item) => item.id === backorderId);
    if (target === undefined || target.status !== 'WAITING')
      return { kind: 'stale' };
    return this.reply(BACKORDER_WAIT_REPLY);
  }

  /** A tapped yes / no / pick; always verified against the customer's list. */
  private async tap(
    senderId: string,
    phone: { phoneCountryCode: string; phone: string },
    intent: { action: 'yes' | 'no' | 'pick'; reference: string },
    pending: Pending | null,
  ): Promise<MinimalBackorderManageTurn> {
    if (intent.action === 'no')
      return this.reply(
        pending?.kind === 'confirm' && pending.backorderId === intent.reference
          ? backorderCancelKeptReply(pending)
          : 'Entendido, no lo cancelo.',
      );
    const active = await this.listActive(phone);
    if (active === null) return this.reply(BACKORDER_CANCEL_FAILED_REPLY);
    const target = active.find((item) => item.id === intent.reference);
    if (target === undefined) return { kind: 'stale' };
    return intent.action === 'pick'
      ? this.ask(senderId, target)
      : this.cancel(target.id, target);
  }

  private async cancel(
    backorderId: string,
    backorder: Pick<BackorderBot, 'folio'>,
  ): Promise<MinimalBackorderManageTurn> {
    try {
      await this.deps.backorders.cancelBackorder(backorderId);
      return this.reply(backorderCancelledReply(backorder));
    } catch (error) {
      this.logFailure('cancel', error);
      if (
        error instanceof ChatbotApiError &&
        error.statusCode === 409 &&
        error.errorCode === BACKORDER_ERROR.BACKORDER_NOT_CANCELLABLE
      ) {
        const status = this.statusOf(error);
        // A retried successful cancel answers this with CANCELLED: done.
        if (status === 'CANCELLED')
          return this.reply(backorderCancelledReply(backorder));
        if (status !== null)
          return this.reply(backorderNotCancellableReply(backorder, status));
      }
      return this.reply(BACKORDER_CANCEL_FAILED_REPLY);
    }
  }

  private statusOf(error: ChatbotApiError): string | null {
    const body = error.responseBody;
    const status =
      typeof body === 'object' && body !== null
        ? (body as { status?: unknown }).status
        : undefined;
    return typeof status === 'string' ? status : null;
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
