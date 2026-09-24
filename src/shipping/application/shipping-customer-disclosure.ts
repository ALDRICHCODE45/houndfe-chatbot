/**
 * SCA-3a: pure pre-send preparation of the measured-product Spanish shipping
 * disclosure from ONE validated plain `ConversationStateData` snapshot + clock;
 * `null` for any malformed, mismatched, hostile or thrown input. No I/O.
 */
import type { ConversationStateData } from '../../conversation/domain/conversation-store';
import { readShippingApprovalMarker } from '../../human-handoff/application/shipping-approval-persistence';
import { readCart } from '../../sale-flow/domain/cart-state';
import type { ShippingCustomerOffer } from './shipping-customer-acceptance';
import { renderShippingCustomerAmounts } from './shipping-customer-decision';
import {
  buildShippingQuoteDraftContext,
  compareShippingQuoteDraftContext,
  normalizeShippingQuoteDraftContext,
  SHIPPING_QUOTE_DRAFT_CONTEXT_KEY,
} from './shipping-quote-draft-context';
import { readShippingQuoteDraft } from './shipping-quote-draft-persistence';

export interface ShippingCustomerDisclosure {
  readonly offer: Omit<ShippingCustomerOffer, 'providerMessageId'>;
  readonly text: string;
}

const INT32_MAX_CENTS = 2_147_483_647;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

const isSafeClock = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  Number.isFinite(new Date(value).getTime());

const safeCents = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

export function prepareShippingCustomerDisclosure(
  data: ConversationStateData | null,
  nowMs: number,
): ShippingCustomerDisclosure | null {
  try {
    if (data === null || !isPlainRecord(data)) return null;
    if (!isSafeClock(nowMs)) return null;
    if (
      data.pendingHumanRequest !== null &&
      data.pendingHumanRequest !== undefined
    ) {
      return null;
    }
    const state = { senderId: '', lastMessageAt: '', data };
    const record = readShippingQuoteDraft(state, nowMs);
    if (record === null) return null;
    const context = normalizeShippingQuoteDraftContext(
      data[SHIPPING_QUOTE_DRAFT_CONTEXT_KEY],
    );
    if (context === null || context.draftCreatedAt !== record.createdAt) {
      return null;
    }
    const marker = readShippingApprovalMarker({ data });
    if (marker === null || marker.decision !== 'SHIPPING_APPROVED') return null;
    if (marker.draftCreatedAt !== record.createdAt) return null;
    if (nowMs < Date.parse(marker.decidedAt)) return null;
    // JSON drops `undefined` variant ids; the shared builder requires the key.
    const cart = readCart(state);
    const lines = cart.items.map((line) => ({
      productId: line.productId,
      variantId: line.variantId ?? null,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
    }));
    const candidate = buildShippingQuoteDraftContext(
      {
        customerId: context.customerId,
        shippingAddressId: context.shippingAddressId,
        destination: context.destination,
        cart: lines,
      },
      context.draftCreatedAt,
    );
    if (
      candidate === null ||
      !compareShippingQuoteDraftContext(candidate, context)
    ) {
      return null;
    }
    const chargeCents = record.draft.customerPaysCents;
    if (!safeCents(chargeCents, 1) || chargeCents > INT32_MAX_CENTS)
      return null;
    const merchandiseCents = cart.expectedTotalCents;
    if (!safeCents(merchandiseCents, 0)) return null;
    const expectedTotalCents = merchandiseCents + chargeCents;
    // Never disclose a total the backend `confirmBotSale` could not register.
    if (expectedTotalCents > INT32_MAX_CENTS) return null;
    const text = renderShippingCustomerAmounts(
      merchandiseCents,
      chargeCents,
      expectedTotalCents,
    );
    if (text === null) return null;
    const offer: Omit<ShippingCustomerOffer, 'providerMessageId'> =
      Object.freeze({
        schemaVersion: 1,
        requestId: marker.requestId,
        draftCreatedAt: record.createdAt,
        offeredAt: new Date(nowMs).toISOString(),
        expiresAt: record.expiresAt,
        merchandiseCents,
        chargeCents,
        expectedTotalCents,
      });
    return Object.freeze({ offer, text });
  } catch {
    return null;
  }
}
