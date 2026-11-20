import { Logger } from '@nestjs/common';
import {
  BACKORDER_ERROR,
  backorderIdempotencyKey,
  type BackorderBot,
  type BackorderClient,
  type BackorderCustomerInput,
} from '../../backorders/domain/backorder';
import type {
  BackorderOfferCapability,
  BackorderOfferInput,
} from '../../backorders/domain/backorder-offer';
import { normalizeCustomerCheckoutContext } from '../../chatbot-api/domain/dtos/checkout-context.dto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import type { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import {
  BACKORDER_ASK_NAME_REPLY,
  BACKORDER_ASK_QUANTITY_REPLY,
  BACKORDER_DECLINE_REPLY,
  BACKORDER_FAILED_REPLY,
  BACKORDER_RETRY_REPLY,
  backorderAvailableNowReply,
  backorderDuplicateReply,
  backorderInactiveReply,
  backorderScheduledReply,
  backorderStatusReply,
  isActiveBackorder,
} from '../domain/backorder-copy';
import { classifyConfirmationReply } from '../domain/confirmation-reply';
import { parseInteractiveReplyId } from '../domain/customer-reply';
import { statedUnitCount } from '../domain/minimal-cart-request';
import { BackorderGates } from './gates/backorder.gates';
import {
  BACKORDER_OFFER_TTL_MS,
  BACKORDER_QUANTITY_MAX,
  type BackorderOfferState,
} from './gates/backorder-offer.gate';

export interface MinimalBackorderDeps {
  readonly backorders: BackorderClient;
  readonly chatbotApi: Pick<ChatbotApiClient, 'getCustomerCheckoutContext'>;
  readonly gates: BackorderGates;
  readonly profiles?: Pick<
    CustomerProfileService,
    'cached' | 'load' | 'record'
  >;
  /** Test seam; production uses `Date.now`. */
  readonly clock?: () => number;
}

/** What the customer turn answers; `null` leaves the turn to the normal flow. */
export type MinimalBackorderTurn =
  | { readonly kind: 'reply'; readonly reply: string }
  /** A tapped offer button that no longer answers anything. */
  | { readonly kind: 'stale' };

type Resolved =
  | { kind: 'customer'; customer: BackorderCustomerInput }
  | { kind: 'name_required' }
  | { kind: 'failed'; retryable: boolean };

type Outcome =
  | { kind: 'done'; reply: string }
  | { kind: 'retry' }
  | { kind: 'failed' };

/** A name is 1–3 plain words; these are never the answer to «¿a nombre de quién?». */
const NOT_A_NAME = new Set([
  'no',
  'se',
  'si',
  'nada',
  'nadie',
  'gracias',
  'hola',
  'mejor',
  'otro',
  'otra',
  'ya',
  'pero',
  'que',
  'como',
  'cuando',
  'cuanto',
  'cuesta',
  'donde',
  'quiero',
  'tienen',
  'hay',
]);
const NAME_WORD = /^[\p{L}][\p{L}'’.-]*$/u;
const NAME_MAX = 40;

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** A name the customer typed as the answer, or `null` when it is not one. */
export function parseBackorderName(text: string): string | null {
  const name = text.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > NAME_MAX) return null;
  const words = name.split(' ');
  if (words.length > 3) return null;
  if (!words.every((word) => NAME_WORD.test(word))) return null;
  if (words.some((word) => NOT_A_NAME.has(fold(word)))) return null;
  return name;
}

/** The unit count answering «¿Cuántas piezas?»: one count, 1–999. */
export function parseAnsweredCount(text: string): number | null {
  const count = statedUnitCount(text);
  return count.status === 'ok' &&
    count.value >= 1 &&
    count.value <= BACKORDER_QUANTITY_MAX
    ? count.value
    : null;
}

/** First word of the WhatsApp contact name, when it looks like a name. */
function firstNameOf(display: string | undefined): string | null {
  return parseBackorderName(display?.trim().split(/\s+/)[0] ?? '');
}

/**
 * Restock backorder S1/S14: the answer to the offer that follows the RESTOCK
 * estimate. The estimate itself goes out from the RESTOCK application
 * coordinator, outside any customer turn; this service
 *
 *   - is the capability the coordinator resolves (`arm`, `statedQuantity`):
 *     it arms the durable `backorder_offer` gate only after Meta accepted the
 *     message, and hands over the count the customer stated when asking;
 *   - answers the customer's next message deterministically (no model):
 *     a tap or a bare yes schedules the backorder (asking the count, and the
 *     name of a new customer, first when they are missing); a tap or a bare no
 *     declines; anything else spends the offer and the turn goes on.
 *
 * The backend is the source of truth: the reply states what the created
 * backorder says (folio, count, price, estimate), and a failure is reported
 * honestly. The idempotency key is stable per offer, so a retry of the same
 * offer replays the same backorder and never creates a second one.
 */
export class MinimalBackorderOfferService implements BackorderOfferCapability {
  private readonly logger = new Logger(MinimalBackorderOfferService.name);
  private readonly clock: () => number;
  readonly gates: BackorderGates;

  constructor(private readonly deps: MinimalBackorderDeps) {
    this.gates = deps.gates;
    this.clock = deps.clock ?? (() => Date.now());
  }

  // --- capability used by the RESTOCK application coordinator -------------

  async statedQuantity(
    senderId: string,
    productId: string,
    variantId: string | null,
  ): Promise<number | null> {
    try {
      await this.gates.gates.begin(senderId);
      return this.gates.quantities.read(senderId, productId, variantId);
    } catch {
      return null;
    }
  }

  async arm(input: BackorderOfferInput): Promise<boolean> {
    const { senderId } = input;
    try {
      // Load what the sender already has (and persist unsaved changes) so
      // this write lands on top of the live state, never over a stale view.
      await this.gates.gates.begin(senderId);
      this.gates.quantities.take(senderId, input.productId, input.variantId);
      this.gates.offers.arm(senderId, {
        decisionId: input.decisionId,
        productId: input.productId,
        variantId: input.variantId,
        productName: input.productName,
        estimatedAt: input.estimatedAt,
        statedQuantity: input.statedQuantity,
      });
      this.gates.gates.touch(senderId);
      return await this.gates.gates.settle(senderId);
    } catch {
      return false;
    }
  }

  // --- the customer turn ---------------------------------------------------

  async handle(input: {
    senderId: string;
    text: string;
    interactiveReplyId?: string;
  }): Promise<MinimalBackorderTurn | null> {
    const { senderId } = input;
    const intent =
      input.interactiveReplyId === undefined
        ? null
        : parseInteractiveReplyId(input.interactiveReplyId);
    const tap = intent?.kind === 'backorder' ? intent : null;
    const offer = this.gates.offers.read(senderId);
    if (tap !== null && (offer === null || offer.decisionId !== tap.reference))
      return { kind: 'stale' };
    if (offer === null) return null;
    // Another button is another message: it spends the offer.
    if (input.interactiveReplyId !== undefined && tap === null)
      return this.spend(senderId, offer);
    const verdict =
      tap === null
        ? classifyConfirmationReply(input.text)
        : tap.action === 'schedule'
          ? 'accept'
          : 'decline';
    if (verdict === 'decline') return this.decline(senderId, offer);
    switch (offer.stage) {
      case 'offer':
        if (verdict !== 'accept') return this.spend(senderId, offer);
        return offer.statedQuantity === null
          ? this.askQuantity(senderId)
          : this.schedule(senderId, offer, offer.statedQuantity, null);
      case 'ask_quantity': {
        // A second tap of the button re-asks; only a number answers.
        if (tap !== null) return this.reply(BACKORDER_ASK_QUANTITY_REPLY);
        const quantity = parseAnsweredCount(input.text);
        return quantity === null
          ? this.spend(senderId, offer)
          : this.schedule(senderId, offer, quantity, null);
      }
      case 'ask_name': {
        if (tap !== null) return this.reply(BACKORDER_ASK_NAME_REPLY);
        const name = parseBackorderName(input.text);
        if (name === null || offer.quantity === null)
          return this.spend(senderId, offer);
        return this.schedule(senderId, offer, offer.quantity, name);
      }
      case 'retry':
        // The request was already built: a yes replays it unchanged.
        return verdict === 'accept' &&
          offer.quantity !== null &&
          offer.customer !== null
          ? this.schedule(senderId, offer, offer.quantity, null)
          : this.spend(senderId, offer);
    }
  }

  private reply(reply: string): MinimalBackorderTurn {
    return { kind: 'reply', reply };
  }

  /** The offer ends without an answer; the turn carries on as usual. */
  private async spend(
    senderId: string,
    offer: BackorderOfferState,
  ): Promise<null> {
    await this.claim(senderId, offer);
    return null;
  }

  private async decline(
    senderId: string,
    offer: BackorderOfferState,
  ): Promise<MinimalBackorderTurn | null> {
    if (!(await this.claim(senderId, offer))) return null;
    return this.reply(BACKORDER_DECLINE_REPLY);
  }

  /** Atomically spends the durable row; `false` when someone else did. */
  private async claim(
    senderId: string,
    offer: BackorderOfferState,
  ): Promise<boolean> {
    const won = await this.gates.gates.claim(senderId, 'backorder_offer', {
      decisionId: offer.decisionId,
    });
    this.gates.offers.clear(senderId);
    return won;
  }

  private askQuantity(senderId: string): MinimalBackorderTurn {
    this.gates.offers.update(senderId, { stage: 'ask_quantity' });
    this.gates.gates.touch(senderId);
    return this.reply(BACKORDER_ASK_QUANTITY_REPLY);
  }

  /**
   * Schedules `quantity` units. The offer is claimed first (single use across
   * concurrent turns); a retryable failure or a missing name puts it back with
   * its original expiry, so the customer can answer again.
   */
  private async schedule(
    senderId: string,
    offer: BackorderOfferState,
    quantity: number,
    name: string | null,
  ): Promise<MinimalBackorderTurn | null> {
    if (!(await this.claim(senderId, offer))) return null;
    const phone = parseMexicanWhatsAppPhone(senderId);
    if (phone === null) return this.reply(BACKORDER_FAILED_REPLY);
    // A retry replays the first request's customer: the same idempotency key
    // must never carry a different body (the customer may exist by now).
    const resolved: Resolved =
      offer.stage === 'retry' && offer.customer !== null
        ? { kind: 'customer', customer: offer.customer }
        : await this.resolveCustomer(senderId, phone, name);
    if (resolved.kind === 'name_required') {
      this.rearm(senderId, { ...offer, stage: 'ask_name', quantity });
      return this.reply(BACKORDER_ASK_NAME_REPLY);
    }
    if (resolved.kind === 'failed') {
      if (!resolved.retryable) return this.reply(BACKORDER_FAILED_REPLY);
      this.rearm(senderId, offer);
      return this.reply(BACKORDER_RETRY_REPLY);
    }
    const outcome = await this.create(senderId, offer, quantity, {
      ...phone,
      customer: resolved.customer,
    });
    if (outcome.kind === 'retry') {
      // Keep exactly what was sent: the next yes replays this body.
      this.rearm(senderId, {
        ...offer,
        stage: 'retry',
        quantity,
        customer: resolved.customer,
      });
      return this.reply(BACKORDER_RETRY_REPLY);
    }
    if (outcome.kind === 'failed') return this.reply(BACKORDER_FAILED_REPLY);
    if (name !== null) void this.rememberName(senderId, name);
    return this.reply(outcome.reply);
  }

  private rearm(senderId: string, state: BackorderOfferState): void {
    this.gates.offers.restore(senderId, state);
    this.gates.gates.touch(senderId);
  }

  private async resolveCustomer(
    senderId: string,
    phone: { phoneCountryCode: string; phone: string },
    typedName: string | null,
  ): Promise<Resolved> {
    let raw: unknown;
    try {
      raw = await this.deps.chatbotApi.getCustomerCheckoutContext(
        phone.phoneCountryCode,
        phone.phone,
        { limit: 1 },
      );
    } catch (error) {
      this.logFailure('customer lookup', error);
      return { kind: 'failed', retryable: true };
    }
    const context = normalizeCustomerCheckoutContext(raw);
    if (context === null) {
      this.logger.warn('backorder customer lookup was malformed');
      return { kind: 'failed', retryable: false };
    }
    if (context.status === 'unique')
      return {
        kind: 'customer',
        customer: { mode: 'existing', customerId: context.customer.customerId },
      };
    // A shared number is never guessed: the team must resolve it.
    if (context.status === 'ambiguous')
      return { kind: 'failed', retryable: false };
    const firstName = typedName ?? (await this.knownFirstName(senderId));
    return firstName === null
      ? { kind: 'name_required' }
      : {
          kind: 'customer',
          customer: { mode: 'createIfAbsent', firstName },
        };
  }

  /** What the profile knows: the preferred name, else the contact's. */
  private async knownFirstName(senderId: string): Promise<string | null> {
    const { profiles } = this.deps;
    if (profiles === undefined) return null;
    try {
      const profile =
        profiles.cached(senderId) ?? (await profiles.load(senderId));
      if (profile === null) return null;
      return (
        parseBackorderName(profile.preferredName ?? '') ??
        firstNameOf(profile.displayName)
      );
    } catch {
      return null;
    }
  }

  private async rememberName(senderId: string, name: string): Promise<void> {
    try {
      await this.deps.profiles?.record(senderId, { preferredName: name });
    } catch {
      // The profile is best effort.
    }
  }

  private async create(
    senderId: string,
    offer: BackorderOfferState,
    quantity: number,
    who: {
      phoneCountryCode: string;
      phone: string;
      customer: BackorderCustomerInput;
    },
  ): Promise<Outcome> {
    try {
      const { backorder } = await this.deps.backorders.createBackorder(
        {
          ...who,
          productId: offer.productId,
          variantId: offer.variantId,
          quantity,
          sourceDecisionId: offer.decisionId,
        },
        backorderIdempotencyKey(offer.decisionId, senderId),
      );
      return { kind: 'done', reply: this.stateReply(backorder) };
    } catch (error) {
      return this.failed(error, offer, who);
    }
  }

  /**
   * L11 note 2: a replay (200) can answer a backorder that is not active any
   * more; «quedó agendado» is only said for a WAITING one.
   */
  private stateReply(backorder: BackorderBot): string {
    const now = new Date(this.clock());
    if (backorder.status === 'WAITING')
      return backorderScheduledReply(backorder, now);
    return backorder.status === 'RESERVED'
      ? backorderStatusReply(backorder, now)
      : backorderInactiveReply(backorder);
  }

  /**
   * L11 note 1: the same key with a different body means an earlier attempt
   * already created the backorder. When the customer's active list holds one
   * for this product/variant created after this offer was armed, it is the
   * one: confirm it. Otherwise it is an honest failure (never a reschedule).
   */
  private async recoverScheduled(
    offer: BackorderOfferState,
    who: { phoneCountryCode: string; phone: string },
  ): Promise<Outcome> {
    let active: BackorderBot[];
    try {
      active = (
        await this.deps.backorders.listBackorders({
          phoneCountryCode: who.phoneCountryCode,
          phone: who.phone,
          status: 'WAITING,RESERVED',
        })
      ).filter(isActiveBackorder);
    } catch (error) {
      this.logFailure('conflict lookup', error);
      return { kind: 'retry' };
    }
    const armedAt = offer.expiresAt - BACKORDER_OFFER_TTL_MS;
    const found = active.find(
      (backorder) =>
        backorder.productId === offer.productId &&
        (backorder.variantId ?? null) === (offer.variantId ?? null) &&
        Date.parse(backorder.scheduledAt) >= armedAt,
    );
    return found === undefined
      ? { kind: 'failed' }
      : { kind: 'done', reply: this.stateReply(found) };
  }

  private async failed(
    error: unknown,
    offer: BackorderOfferState,
    who: { phoneCountryCode: string; phone: string },
  ): Promise<Outcome> {
    this.logFailure('schedule', error);
    if (!(error instanceof ChatbotApiError)) return { kind: 'failed' };
    const { statusCode: status, errorCode: code } = error;
    if (status === 409 && code === BACKORDER_ERROR.STOCK_AVAILABLE_NOW)
      return {
        kind: 'done',
        reply: backorderAvailableNowReply(offer.productName),
      };
    if (status === 409 && code === BACKORDER_ERROR.BACKORDER_DUPLICATE)
      return { kind: 'done', reply: await this.duplicateReply(error) };
    if (status === 409 && code === BACKORDER_ERROR.IDEMPOTENCY_KEY_CONFLICT)
      return this.recoverScheduled(offer, who);
    const retryable =
      status === null ||
      status === 429 ||
      status >= 500 ||
      (status === 409 && code === BACKORDER_ERROR.IDEMPOTENCY_KEY_IN_FLIGHT);
    return retryable ? { kind: 'retry' } : { kind: 'failed' };
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
