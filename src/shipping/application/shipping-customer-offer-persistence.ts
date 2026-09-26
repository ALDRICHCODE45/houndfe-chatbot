/**
 * SCA-3b1: durable sent-offer marker seam. Requires a real caller-supplied
 * provider message id, a matching `freshState.senderId` and a fresh state that
 * re-derives the exact committed disclosure; rejects drift, pending/older
 * offers and a malformed/orphan/future acceptance replay before the single
 * write. A new disclosure clears any prior acceptance. Returns `null` on
 * failure, never sends, and is not delivery proof (SCA-3b2 is its only caller).
 */
import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import { readShippingApprovalMarker } from '../../human-handoff/application/shipping-approval-persistence';
import {
  matchShippingCustomerAcceptance,
  normalizeShippingCustomerAcceptance,
  normalizeShippingCustomerOffer,
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY,
} from './shipping-customer-acceptance';
import { prepareShippingCustomerDisclosure } from './shipping-customer-disclosure';

// prettier-ignore
const isPlainObject = (v: unknown): v is Record<string, unknown> => { try { const p: unknown = typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.getPrototypeOf(v) : undefined; return p === Object.prototype || p === null; } catch { return false; } };

export async function persistSentShippingCustomerOffer(
  store: ConversationStore,
  senderId: string,
  freshState: ConversationState | null,
  rawOffer: unknown,
  nowMs: number,
): Promise<ConversationState | null> {
  try {
    if (typeof senderId !== 'string' || senderId.length === 0) return null;
    const offer = normalizeShippingCustomerOffer(rawOffer);
    if (offer === null) return null;
    if (freshState === null || freshState.senderId !== senderId) return null;
    const lastMessageAt: unknown = freshState.lastMessageAt;
    const rawData: unknown = freshState.data;
    if (typeof lastMessageAt !== 'string' || lastMessageAt.length === 0) {
      return null;
    }
    if (!isPlainObject(rawData)) return null;
    const data: ConversationStateData = { ...rawData };
    const disclosure = prepareShippingCustomerDisclosure(data, nowMs);
    if (disclosure === null) return null;
    const prepared = disclosure.offer;
    if (
      prepared.requestId !== offer.requestId ||
      prepared.draftCreatedAt !== offer.draftCreatedAt ||
      prepared.expiresAt !== offer.expiresAt ||
      prepared.merchandiseCents !== offer.merchandiseCents ||
      prepared.chargeCents !== offer.chargeCents ||
      prepared.expectedTotalCents !== offer.expectedTotalCents
    ) {
      return null;
    }
    const decidedAt = readShippingApprovalMarker({ data })?.decidedAt;
    const offeredMs = Date.parse(offer.offeredAt);
    if (
      decidedAt === undefined ||
      offeredMs < Date.parse(decidedAt) ||
      offeredMs > nowMs ||
      nowMs >= Date.parse(offer.expiresAt)
    ) {
      return null;
    }
    const currentOffer = normalizeShippingCustomerOffer(
      data[SHIPPING_CUSTOMER_OFFER_KEY],
    );
    if (
      currentOffer !== null &&
      currentOffer.requestId === offer.requestId &&
      currentOffer.draftCreatedAt === offer.draftCreatedAt &&
      currentOffer.merchandiseCents === offer.merchandiseCents &&
      currentOffer.chargeCents === offer.chargeCents &&
      currentOffer.expectedTotalCents === offer.expectedTotalCents &&
      currentOffer.offeredAt === offer.offeredAt &&
      currentOffer.expiresAt === offer.expiresAt &&
      currentOffer.providerMessageId === offer.providerMessageId
    ) {
      const rawAcceptance = data[SHIPPING_CUSTOMER_ACCEPTANCE_KEY];
      if (rawAcceptance !== null && rawAcceptance !== undefined) {
        const accepted = normalizeShippingCustomerAcceptance(rawAcceptance);
        if (
          accepted === null ||
          !matchShippingCustomerAcceptance(currentOffer, accepted) ||
          Date.parse(accepted.acceptedAt) > nowMs
        ) {
          return null;
        }
      }
      return freshState;
    }
    if (
      currentOffer !== null &&
      currentOffer.requestId === offer.requestId &&
      Date.parse(currentOffer.offeredAt) > offeredMs
    ) {
      return null;
    }
    return await store.update(senderId, {
      lastMessageAt,
      data: {
        ...data,
        [SHIPPING_CUSTOMER_OFFER_KEY]: offer,
        [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: null,
      },
    });
  } catch {
    return null;
  }
}
