/**
 * Pure shipping-credit rule (SQ-1). Integer cents only; invalid input or
 * unsafe arithmetic fails explicitly. Each unit strictly above
 * `SHIPPING_CREDIT_QUALIFYING_UNIT_PRICE_CENTS` contributes
 * `SHIPPING_CREDIT_PER_QUALIFYING_UNIT_CENTS` per quantity; credits sum;
 * `customerPaysCents = max(0, bestRateCents - totalCreditCents)`.
 */
export const SHIPPING_CREDIT_QUALIFYING_UNIT_PRICE_CENTS = 50_000;
export const SHIPPING_CREDIT_PER_QUALIFYING_UNIT_CENTS = 12_000;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_QUALIFYING_UNITS = Math.floor(
  MAX_SAFE_INTEGER / SHIPPING_CREDIT_PER_QUALIFYING_UNIT_CENTS,
);

export interface ShippingCreditLine {
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export interface ShippingCreditInput {
  readonly bestRateCents: number;
  readonly items: readonly ShippingCreditLine[];
}

export type ShippingCreditField =
  | 'bestRateCents'
  | 'unitPriceCents'
  | 'quantity';

export type ShippingCreditResult =
  | {
      readonly kind: 'calculated';
      readonly bestRateCents: number;
      readonly totalCreditCents: number;
      readonly appliedCreditCents: number;
      readonly unusedCreditCents: number;
      readonly qualifyingUnitCount: number;
      readonly customerPaysCents: number;
    }
  | {
      readonly kind: 'invalid_input';
      readonly field: ShippingCreditField;
      readonly itemIndex: number | null;
    }
  | { readonly kind: 'overflow' };

const safeInt = (value: number, min: number): boolean =>
  Number.isSafeInteger(value) && value >= min;

/**
 * Pure calculator. Never throws, never rounds, and never mixes floats into
 * money: invalid inputs and unsafe arithmetic become explicit members.
 */
export function calculateShippingCredit(
  input: ShippingCreditInput,
): ShippingCreditResult {
  if (!safeInt(input.bestRateCents, 0)) {
    return { kind: 'invalid_input', field: 'bestRateCents', itemIndex: null };
  }
  let totalCreditCents = 0;
  let qualifyingUnitCount = 0;
  for (let index = 0; index < input.items.length; index += 1) {
    const { unitPriceCents, quantity } = input.items[index];
    if (!safeInt(unitPriceCents, 0)) {
      return {
        kind: 'invalid_input',
        field: 'unitPriceCents',
        itemIndex: index,
      };
    }
    if (!safeInt(quantity, 1)) {
      return { kind: 'invalid_input', field: 'quantity', itemIndex: index };
    }
    if (unitPriceCents <= SHIPPING_CREDIT_QUALIFYING_UNIT_PRICE_CENTS) {
      continue;
    }
    const lineCreditCents =
      quantity * SHIPPING_CREDIT_PER_QUALIFYING_UNIT_CENTS;
    if (
      quantity > MAX_QUALIFYING_UNITS ||
      totalCreditCents > MAX_SAFE_INTEGER - lineCreditCents ||
      qualifyingUnitCount > MAX_SAFE_INTEGER - quantity
    ) {
      return { kind: 'overflow' };
    }
    totalCreditCents += lineCreditCents;
    qualifyingUnitCount += quantity;
  }
  const appliedCreditCents = Math.min(totalCreditCents, input.bestRateCents);
  return {
    kind: 'calculated',
    bestRateCents: input.bestRateCents,
    totalCreditCents,
    appliedCreditCents,
    unusedCreditCents: totalCreditCents - appliedCreditCents,
    qualifyingUnitCount,
    customerPaysCents: input.bestRateCents - appliedCreditCents,
  };
}
