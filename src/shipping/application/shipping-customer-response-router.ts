/**
 * SCA-4b: deterministic inbound customer-response router over the committed
 * SCA-1/3/4a contracts. One narrow ConversationStore read/update seam plus an
 * injected clock; no WhatsApp sender, LLM, provider or dispatcher wiring.
 * `fenced` means "not this flow" so the caller falls through; every other
 * terminal kind is authoritative and never reaches the LLM. A decline cancels
 * offer/acceptance/approval and drops draft/context in ONE write before any
 * acknowledgment; a malformed or drifted active flow blocks without a write.
 * Store failures propagate. No cross-store compare-and-swap is claimed: the
 * read and the single update are not atomic against a concurrent writer.
 */
import {
  readPendingHumanRequest,
  type ConversationState,
  type ConversationStateData,
} from '../../conversation/domain/conversation-store';
import { SHIPPING_APPROVAL_KEY } from '../../human-handoff/application/shipping-approval-persistence';
import {
  matchShippingCustomerAcceptance,
  normalizeShippingCustomerAcceptance,
  normalizeShippingCustomerOffer,
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY,
  type ShippingCustomerAcceptance,
  type ShippingCustomerOffer,
} from './shipping-customer-acceptance';
import { parseShippingCustomerDecision } from './shipping-customer-decision';
import { prepareShippingCustomerDisclosure } from './shipping-customer-disclosure';
import { SHIPPING_QUOTE_DRAFT_CONTEXT_KEY } from './shipping-quote-draft-context';
import { SHIPPING_QUOTE_DRAFT_KEY } from './shipping-quote-draft-record';
import {
  classifyShippingCustomerResponse,
  matchShippingCustomerDeclineReceipt,
  normalizeShippingCustomerDeclineReceipt,
  SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY,
  type ShippingCustomerDeclineReceipt,
} from './shipping-customer-response';

export interface ShippingCustomerResponseRouteInput {
  senderId: string;
  text: string;
  sourceWebhookMessageId: string;
  inboundTimestamp: string;
}

export type ShippingCustomerResponseRouteOutcome =
  | { kind: 'accepted'; acceptance: ShippingCustomerAcceptance }
  | { kind: 'replayed_accept'; acceptance: ShippingCustomerAcceptance }
  | { kind: 'declined'; receipt: ShippingCustomerDeclineReceipt }
  | { kind: 'replayed_decline'; receipt: ShippingCustomerDeclineReceipt }
  | { kind: 'fenced' }
  | { kind: 'blocked' }
  | { kind: 'unrecognized' };

/** Narrow conversation seam: only the durable read and the single patch write. */
export interface ShippingCustomerResponseConversations {
  get(senderId: string): Promise<ConversationState | null>;
  update(
    senderId: string,
    patch: Partial<Omit<ConversationState, 'senderId'>>,
  ): Promise<ConversationState>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
};

/** True iff the current server re-derivation pins the same draft, expiry and
 *  disclosed amounts as the persisted offer. The offer's own `offeredAt` and
 *  `providerMessageId` are not part of the server-derived disclosure pin. */
function sameDisclosedAmounts(
  prepared: Omit<ShippingCustomerOffer, 'providerMessageId'>,
  offer: ShippingCustomerOffer,
): boolean {
  return (
    prepared.requestId === offer.requestId &&
    prepared.draftCreatedAt === offer.draftCreatedAt &&
    prepared.expiresAt === offer.expiresAt &&
    prepared.merchandiseCents === offer.merchandiseCents &&
    prepared.chargeCents === offer.chargeCents &&
    prepared.expectedTotalCents === offer.expectedTotalCents
  );
}

export class ShippingCustomerResponseRouter {
  constructor(
    private readonly conversations: ShippingCustomerResponseConversations,
    private readonly now: () => number,
  ) {}

  async route(
    input: ShippingCustomerResponseRouteInput,
  ): Promise<ShippingCustomerResponseRouteOutcome> {
    if (
      typeof input.senderId !== 'string' ||
      input.senderId.length === 0 ||
      typeof input.sourceWebhookMessageId !== 'string' ||
      input.sourceWebhookMessageId.length === 0
    ) {
      return { kind: 'fenced' };
    }
    // Store failures propagate: a caller must never read them as accepted.
    const state = await this.conversations.get(input.senderId);
    if (state === null || !isPlainObject(state.data)) return { kind: 'fenced' };
    const data = state.data;
    const lastMessageAt = state.lastMessageAt;
    const rawReceipt = data[SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY];
    if (
      matchShippingCustomerDeclineReceipt(
        rawReceipt,
        input.sourceWebhookMessageId,
      )
    ) {
      const stored = normalizeShippingCustomerDeclineReceipt(rawReceipt);
      return stored === null
        ? { kind: 'fenced' }
        : { kind: 'replayed_decline', receipt: stored };
    }
    const rawOffer = data[SHIPPING_CUSTOMER_OFFER_KEY];
    const rawAcceptance = data[SHIPPING_CUSTOMER_ACCEPTANCE_KEY];
    const offerFilled = rawOffer !== null && rawOffer !== undefined;
    const acceptanceFilled =
      rawAcceptance !== null && rawAcceptance !== undefined;
    if (!offerFilled && !acceptanceFilled) return { kind: 'fenced' };
    if (readPendingHumanRequest(state) !== null) return { kind: 'blocked' };
    const offer = normalizeShippingCustomerOffer(rawOffer);
    if (offerFilled && offer === null) return { kind: 'blocked' };
    const acceptance = normalizeShippingCustomerAcceptance(rawAcceptance);
    if (acceptanceFilled && acceptance === null) return { kind: 'blocked' };
    if (offer === null) return { kind: 'blocked' };
    if (
      acceptance !== null &&
      !matchShippingCustomerAcceptance(offer, acceptance)
    ) {
      return { kind: 'blocked' };
    }
    const decision = parseShippingCustomerDecision(input.text);
    if (decision === null) return { kind: 'unrecognized' };
    const nowMs = this.now();
    const classified = classifyShippingCustomerResponse(
      offer,
      input.text,
      input.inboundTimestamp,
      nowMs,
    );
    if (classified === null) return { kind: 'blocked' };
    if (decision === 'accept') {
      const prepared = prepareShippingCustomerDisclosure(data, nowMs);
      if (prepared === null || !sameDisclosedAmounts(prepared.offer, offer)) {
        return { kind: 'blocked' };
      }
      // A stored acceptance is a replay only when the incoming webhook id and
      // timestamp are byte-identical; any other id/time is an unproven claim and
      // must not be trusted as consent.
      if (acceptance !== null) {
        if (
          acceptance.inboundMessageId === input.sourceWebhookMessageId &&
          acceptance.acceptedAt === input.inboundTimestamp
        ) {
          return { kind: 'replayed_accept', acceptance };
        }
        return { kind: 'blocked' };
      }
      const accepted = normalizeShippingCustomerAcceptance({
        schemaVersion: 1,
        requestId: offer.requestId,
        draftCreatedAt: offer.draftCreatedAt,
        merchandiseCents: offer.merchandiseCents,
        chargeCents: offer.chargeCents,
        expectedTotalCents: offer.expectedTotalCents,
        acceptedAt: input.inboundTimestamp,
        inboundMessageId: input.sourceWebhookMessageId,
      });
      if (
        accepted === null ||
        !matchShippingCustomerAcceptance(offer, accepted)
      ) {
        return { kind: 'blocked' };
      }
      await this.conversations.update(input.senderId, {
        lastMessageAt,
        data: { ...data, [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: accepted },
      });
      return { kind: 'accepted', acceptance: accepted };
    }
    const declined = normalizeShippingCustomerDeclineReceipt({
      schemaVersion: 1,
      requestId: offer.requestId,
      draftCreatedAt: offer.draftCreatedAt,
      inboundMessageId: input.sourceWebhookMessageId,
      declinedAt: input.inboundTimestamp,
    });
    if (declined === null) return { kind: 'blocked' };
    const nextData: ConversationStateData = {
      ...data,
      [SHIPPING_CUSTOMER_OFFER_KEY]: null,
      [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: null,
      [SHIPPING_APPROVAL_KEY]: null,
      [SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY]: declined,
    };
    delete nextData[SHIPPING_QUOTE_DRAFT_KEY];
    delete nextData[SHIPPING_QUOTE_DRAFT_CONTEXT_KEY];
    await this.conversations.update(input.senderId, {
      lastMessageAt,
      data: nextData,
    });
    return { kind: 'declined', receipt: declined };
  }
}
