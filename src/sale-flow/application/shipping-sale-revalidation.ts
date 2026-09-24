/**
 * SQ-5E4a pure local shipping-sale snapshot revalidation of ONE already-validated
 * plain JSONB `data` snapshot: `ordinary_free` (no shipping marker), `charged`
 * (fresh draft + pinned context + approved marker on one `draftCreatedAt` pin,
 * cart matching the stored context, charge in 1..int32, merchandise total >= 0,
 * safe positive freight-inclusive total bounded to the backend int32 max), or
 * `blocked` (all else, fail closed).
 * Pure: no I/O, backend lookup, provider, store, or mutation, and never a
 * model-supplied customer/money/address/identity. Point-in-time only: no
 * cross-store CAS or freshness claim; SQ-5E2 re-fetches before key/store.
 */
import type { ConversationStateData } from '../../conversation/domain/conversation-store';
import {
  SHIPPING_APPROVAL_KEY,
  readShippingApprovalMarker,
} from '../../human-handoff/application/shipping-approval-persistence';
import {
  buildShippingQuoteDraftContext,
  compareShippingQuoteDraftContext,
  normalizeShippingQuoteDraftContext,
  SHIPPING_QUOTE_DRAFT_CONTEXT_KEY,
  type ShippingQuoteDraftDestination,
} from '../../shipping/application/shipping-quote-draft-context';
import { readShippingQuoteDraft } from '../../shipping/application/shipping-quote-draft-persistence';
import { SHIPPING_QUOTE_DRAFT_KEY } from '../../shipping/application/shipping-quote-draft-record';
import { readCart } from '../domain/cart-state';

export interface ShippingSaleChargedVerdict {
  readonly kind: 'charged';
  readonly customerId: string;
  readonly shippingAddressId: string;
  readonly destination: ShippingQuoteDraftDestination;
  readonly approvalId: string;
  readonly quoteId: string;
  readonly chargeCents: number;
  readonly merchandiseTotalCents: number;
  readonly expectedTotalCents: number;
}

export type ShippingSaleRevalidationVerdict =
  | { readonly kind: 'ordinary_free' }
  | ShippingSaleChargedVerdict
  | { readonly kind: 'blocked' };

const ORDINARY_FREE: ShippingSaleRevalidationVerdict = Object.freeze({
  kind: 'ordinary_free',
});
const BLOCKED: ShippingSaleRevalidationVerdict = Object.freeze({
  kind: 'blocked',
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

const present = (value: unknown): boolean =>
  value !== null && value !== undefined;

const INT32_MAX_CENTS = 2_147_483_647;
const safeCents = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

export function evaluateShippingSaleRevalidation(
  data: ConversationStateData | null,
  nowMs: number,
): ShippingSaleRevalidationVerdict {
  try {
    if (data === null) return ORDINARY_FREE;
    if (!isPlainRecord(data)) return BLOCKED;
    const draftValue = data[SHIPPING_QUOTE_DRAFT_KEY];
    const contextValue = data[SHIPPING_QUOTE_DRAFT_CONTEXT_KEY];
    const approvalValue = data[SHIPPING_APPROVAL_KEY];
    const hasDraft = present(draftValue);
    const hasContext = present(contextValue);
    const hasApproval = present(approvalValue);
    if (!hasDraft && !hasContext && !hasApproval) return ORDINARY_FREE;
    if (present(data.pendingHumanRequest)) return BLOCKED;
    if (!hasDraft || !hasContext || !hasApproval) return BLOCKED;
    const state = { senderId: '', lastMessageAt: '', data };
    const record = readShippingQuoteDraft(state, nowMs);
    if (record === null) return BLOCKED;
    const context = normalizeShippingQuoteDraftContext(contextValue);
    if (context === null || context.draftCreatedAt !== record.createdAt) {
      return BLOCKED;
    }
    const marker = readShippingApprovalMarker({ data });
    if (marker === null || marker.decision !== 'SHIPPING_APPROVED') {
      return BLOCKED;
    }
    if (marker.draftCreatedAt !== record.createdAt) return BLOCKED;
    const chargeCents = record.draft.customerPaysCents;
    if (!safeCents(chargeCents, 1) || chargeCents > INT32_MAX_CENTS) {
      return BLOCKED;
    }
    // A persisted cart line may omit `variantId` (JSON drops `undefined`) while
    // the shared builder requires the exact key; normalize it to `null`.
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
      return BLOCKED;
    }
    const merchandiseTotalCents = cart.expectedTotalCents;
    if (!safeCents(merchandiseTotalCents, 0)) return BLOCKED;
    const expectedTotalCents = merchandiseTotalCents + chargeCents;
    // The final backend `confirmBotSale` rejects a freight-inclusive total
    // above signed int32, so block it here before key mint/store/HTTP.
    if (
      !Number.isSafeInteger(expectedTotalCents) ||
      expectedTotalCents > INT32_MAX_CENTS
    ) {
      return BLOCKED;
    }
    return Object.freeze({
      kind: 'charged',
      customerId: context.customerId,
      shippingAddressId: context.shippingAddressId,
      destination: context.destination,
      approvalId: marker.requestId,
      quoteId: record.draft.quoteId,
      chargeCents,
      merchandiseTotalCents,
      expectedTotalCents,
    });
  } catch {
    return BLOCKED;
  }
}
