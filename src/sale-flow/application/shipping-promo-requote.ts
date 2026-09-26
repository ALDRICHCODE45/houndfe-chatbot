/**
 * E4-2b1 — Pure, never-throwing binding of a backend `PROMO_RE_QUOTE` error to
 * the nonnegative merchandise remainder a guarded retry persists. The backend
 * recomputes `recomputedTotalCents = merchandise + shippingChargeCents`, so
 * freight is subtracted exactly once and never re-added twice.
 *
 * Every input must agree: the mapped `promoReQuote` cents, the raw
 * `responseBody` fields, and the server-owned pin. Hostile, missing, or
 * contradictory inputs fail closed to a frozen price-free `blocked` that
 * carries no money, PII, or model input. Pure: no I/O, store, HTTP, or wiring.
 */
import type { ToolErrorResult } from '../domain/tool-result';

/** The backend persists `totalCents` as a signed 32-bit integer. */
const INT32_MAX = 2_147_483_647;

/** The server-owned slice of a charged shipping verdict a retry may trust. */
export interface ShippingPromoChargePin {
  readonly chargeCents: number;
  readonly expectedTotalCents: number;
}

export type ShippingPromoReQuoteBinding =
  | {
      readonly kind: 'merchandise_remainder';
      readonly merchandiseTotalCents: number;
    }
  | { readonly kind: 'blocked' };

const BLOCKED: ShippingPromoReQuoteBinding = Object.freeze({ kind: 'blocked' });

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

const safeCents = (
  value: unknown,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;

export function bindShippingPromoReQuote(
  result: ToolErrorResult,
  responseBody: unknown,
  pinned: ShippingPromoChargePin,
): ShippingPromoReQuoteBinding {
  try {
    // 1) The mapped envelope must be the canonical `promoReQuote` error.
    const envelope: unknown = result;
    if (!isPlainRecord(envelope) || envelope.ok !== false) return BLOCKED;
    const error: unknown = envelope.error;
    if (!isPlainRecord(error) || error.kind !== 'promoReQuote') return BLOCKED;
    const recomputedTotalCents = error.recomputedTotalCents;
    const mappedExpectedTotalCents = error.expectedTotalCents;
    const discountCents = error.discountCents;
    if (
      !safeCents(recomputedTotalCents, 0, INT32_MAX) ||
      !safeCents(mappedExpectedTotalCents, 0) ||
      !safeCents(discountCents, 0)
    ) {
      return BLOCKED;
    }

    // 2) The pinned slice is server-owned: a positive int32 freight and a safe
    //    positive freight-inclusive sent total.
    const pin: unknown = pinned;
    if (!isPlainRecord(pin)) return BLOCKED;
    const chargeCents = pin.chargeCents;
    const pinnedExpectedTotalCents = pin.expectedTotalCents;
    if (!safeCents(chargeCents, 1, INT32_MAX)) return BLOCKED;
    if (!safeCents(pinnedExpectedTotalCents, 1)) return BLOCKED;

    // 3) The backend echoed the exact bot-sent total; any drift is hostile.
    if (mappedExpectedTotalCents !== pinnedExpectedTotalCents) return BLOCKED;

    // 4) The raw body must carry the charged freight and agree exactly with
    //    the mapped fields; a missing, hostile, or contradictory body blocks.
    if (!isPlainRecord(responseBody)) return BLOCKED;
    const rawShippingChargeCents = responseBody.shippingChargeCents;
    if (!safeCents(rawShippingChargeCents, 0)) return BLOCKED;
    if (rawShippingChargeCents !== chargeCents) return BLOCKED;
    const rawRecomputed = responseBody.recomputedTotalCents;
    const rawExpected = responseBody.expectedTotalCents;
    const rawDiscount = responseBody.discountCents;
    if (rawRecomputed !== recomputedTotalCents) return BLOCKED;
    if (rawExpected !== mappedExpectedTotalCents) return BLOCKED;
    if (rawDiscount !== discountCents) return BLOCKED;

    // 5) The recomputed total already includes freight; subtract it once to
    //    recover the merchandise remainder the retry persists.
    if (recomputedTotalCents < chargeCents) return BLOCKED;
    const merchandiseTotalCents = recomputedTotalCents - chargeCents;
    if (!safeCents(merchandiseTotalCents, 0)) return BLOCKED;

    return Object.freeze({
      kind: 'merchandise_remainder',
      merchandiseTotalCents,
    });
  } catch {
    return BLOCKED;
  }
}
