/** Pure SQ-4A shipping-quote draft boundary: normalizer + credit rule reuse. */
import {
  calculateShippingCredit,
  type ShippingCreditLine,
  type ShippingCreditResult,
} from '../domain/shipping-credit';
import {
  normalizeShippingQuoteQuotedResult as normalizeQuoted,
  type ShippingQuoteRate,
} from '../domain/shipping-quote.result';
export interface ShippingQuoteDraft {
  readonly quoteId: string;
  readonly selectedRate: ShippingQuoteRate;
  readonly providerExpiresAt: string | null;
  readonly bestRateCents: number;
  readonly totalCreditCents: number;
  readonly appliedCreditCents: number;
  readonly unusedCreditCents: number;
  readonly qualifyingUnitCount: number;
  readonly customerPaysCents: number;
}
type InvalidReason = 'invalid_quote' | 'invalid_cart';
export type ShippingQuoteDraftOutcome =
  | { readonly kind: 'draft'; readonly draft: ShippingQuoteDraft }
  | { readonly kind: 'unavailable'; readonly reason: InvalidReason }
  | { readonly kind: 'handoff'; readonly reason: 'credit_overflow' };
const SELECT_QUOTED = { kind: 'quoted', quoteId: 'select', expiresAt: null };
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const codeUnits = (a: string, b: string): number =>
  a === b ? 0 : a < b ? -1 : 1;
const compareRates = (a: ShippingQuoteRate, b: ShippingQuoteRate): number => {
  if (a.priceCents !== b.priceCents) {
    return a.priceCents < b.priceCents ? -1 : 1;
  }
  if (a.estimatedDeliveryDays !== b.estimatedDeliveryDays) {
    if (a.estimatedDeliveryDays === null) return 1;
    if (b.estimatedDeliveryDays === null) return -1;
    return a.estimatedDeliveryDays < b.estimatedDeliveryDays ? -1 : 1;
  }
  return (
    codeUnits(a.carrierName, b.carrierName) ||
    codeUnits(a.serviceName, b.serviceName) ||
    codeUnits(a.rateId, b.rateId)
  );
};
/** One-read normalize, compare fresh snapshots, return fresh exact-key frozen copy. */
export function selectBestEligibleRate(
  rates: unknown,
): ShippingQuoteRate | null {
  try {
    const quoted = normalizeQuoted({ ...SELECT_QUOTED, rates });
    if (quoted === null) return null;
    const list = quoted.rates;
    let best = list[0];
    for (let i = 1; i < list.length; i += 1) {
      if (compareRates(list[i], best) < 0) best = list[i];
    }
    return Object.freeze({
      rateId: best.rateId,
      carrierName: best.carrierName,
      serviceName: best.serviceName,
      priceCents: best.priceCents,
      currency: best.currency,
      estimatedDeliveryDays: best.estimatedDeliveryDays,
      validUntil: best.validUntil,
    });
  } catch {
    return null;
  }
}
function snapshotCartLines(value: unknown): ShippingCreditLine[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length: unknown = value.length;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 100
    ) {
      return null;
    }
    const lines: ShippingCreditLine[] = [];
    for (let i = 0; i < length; i += 1) {
      if (!(i in value)) return null;
      const raw: unknown = value[i];
      if (!isPlainRecord(raw)) return null;
      lines.push({
        unitPriceCents: raw.unitPriceCents as number,
        quantity: raw.quantity as number,
      });
    }
    return lines;
  } catch {
    return null;
  }
}
const unavailable = (reason: InvalidReason): ShippingQuoteDraftOutcome =>
  Object.freeze<ShippingQuoteDraftOutcome>({ kind: 'unavailable', reason });
const handoff = (): ShippingQuoteDraftOutcome =>
  Object.freeze<ShippingQuoteDraftOutcome>({
    kind: 'handoff',
    reason: 'credit_overflow',
  });
export function buildShippingQuoteDraft(
  quoted: unknown,
  cartLines: unknown,
): ShippingQuoteDraftOutcome {
  const normalized = normalizeQuoted(quoted);
  if (normalized === null) return unavailable('invalid_quote');
  const items = snapshotCartLines(cartLines);
  if (items === null) return unavailable('invalid_cart');
  const best = selectBestEligibleRate(normalized.rates);
  if (best === null) return unavailable('invalid_quote');
  let credit: ShippingCreditResult | undefined;
  try {
    credit = calculateShippingCredit({ bestRateCents: best.priceCents, items });
  } catch {
    return unavailable('invalid_cart');
  }
  if (credit === undefined) return unavailable('invalid_cart');
  if (credit.kind === 'invalid_input') return unavailable('invalid_cart');
  if (credit.kind === 'overflow') return handoff();
  const draft = Object.freeze<ShippingQuoteDraft>({
    quoteId: normalized.quoteId,
    selectedRate: best,
    providerExpiresAt: normalized.expiresAt,
    bestRateCents: credit.bestRateCents,
    totalCreditCents: credit.totalCreditCents,
    appliedCreditCents: credit.appliedCreditCents,
    unusedCreditCents: credit.unusedCreditCents,
    qualifyingUnitCount: credit.qualifyingUnitCount,
    customerPaysCents: credit.customerPaysCents,
  });
  const outcome: ShippingQuoteDraftOutcome = { kind: 'draft', draft };
  return Object.freeze(outcome);
}
