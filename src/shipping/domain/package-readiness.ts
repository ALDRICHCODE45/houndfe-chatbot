/**
 * Pure package-readiness rule (SQ-1B). Never invents measurements: any
 * missing/null/invalid weight or dimension returns `unavailable`, naming
 * only product/variant identifiers and missing fields. Fully measured
 * carts at or below `PACKAGE_MAX_TOTAL_WEIGHT_GRAMS` are a single-package
 * candidate (readiness only); above it a balanced split is required with
 * minimum package count `ceil(total/max)`, items never assigned to parcels
 * (manual/unresolved). Unsafe arithmetic fails explicitly.
 */
export const PACKAGE_MAX_TOTAL_WEIGHT_GRAMS = 25_000;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface PackageMeasurementInput {
  readonly weightGrams: number | null;
  readonly lengthCm: number | null;
  readonly widthCm: number | null;
  readonly heightCm: number | null;
}

export interface PackageReadinessItemInput {
  readonly productId: string;
  readonly variantId?: string | null;
  readonly quantity: number;
  readonly measurement: PackageMeasurementInput | null;
}

export interface PackageReadinessInput {
  readonly items: readonly PackageReadinessItemInput[];
}

export type PackageReadinessField =
  | 'weightGrams'
  | 'lengthCm'
  | 'widthCm'
  | 'heightCm'
  | 'quantity';

export interface PackageReadinessUnavailableItem {
  readonly productId: string;
  readonly variantId: string | null;
  readonly missingFields: readonly PackageReadinessField[];
}

export type PackageReadinessResult =
  | {
      readonly kind: 'unavailable';
      readonly items: readonly PackageReadinessUnavailableItem[];
    }
  | {
      readonly kind: 'single_package_candidate';
      readonly totalWeightGrams: number;
      readonly totalUnits: number;
      readonly readiness: 'candidate_only';
    }
  | {
      readonly kind: 'balanced_split_required';
      readonly totalWeightGrams: number;
      readonly totalUnits: number;
      readonly minimumPackageCount: number;
      readonly resolution: 'manual_unresolved';
    }
  | { readonly kind: 'overflow' };

function positiveInt(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

function ceilDiv(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  return quotient * denominator === numerator ? quotient : quotient + 1;
}

/**
 * Pure assessment. Never throws and never fabricates packing, weights, or
 * dimensions; missing/invalid fields are reported instead of guessed.
 */
export function assessPackageReadiness(
  input: PackageReadinessInput,
): PackageReadinessResult {
  const unavailableItems: PackageReadinessUnavailableItem[] = [];
  const lines: Array<{ quantity: number; weightGrams: number }> = [];
  for (const item of input.items) {
    const m = item.measurement;
    const quantity = positiveInt(item.quantity);
    const weightGrams = positiveInt(m?.weightGrams);
    const lengthCm = positiveInt(m?.lengthCm);
    const widthCm = positiveInt(m?.widthCm);
    const heightCm = positiveInt(m?.heightCm);
    if (
      quantity === null ||
      weightGrams === null ||
      lengthCm === null ||
      widthCm === null ||
      heightCm === null
    ) {
      const missingFields: PackageReadinessField[] = [];
      if (quantity === null) missingFields.push('quantity');
      if (weightGrams === null) missingFields.push('weightGrams');
      if (lengthCm === null) missingFields.push('lengthCm');
      if (widthCm === null) missingFields.push('widthCm');
      if (heightCm === null) missingFields.push('heightCm');
      unavailableItems.push({
        productId: item.productId,
        variantId: item.variantId ?? null,
        missingFields,
      });
      continue;
    }
    lines.push({ quantity, weightGrams });
  }
  if (unavailableItems.length > 0) {
    return { kind: 'unavailable', items: unavailableItems };
  }
  let totalWeightGrams = 0;
  let totalUnits = 0;
  for (const { quantity, weightGrams } of lines) {
    const lineWeightGrams = quantity * weightGrams;
    if (
      quantity > Math.floor(MAX_SAFE_INTEGER / weightGrams) ||
      totalWeightGrams > MAX_SAFE_INTEGER - lineWeightGrams ||
      totalUnits > MAX_SAFE_INTEGER - quantity
    ) {
      return { kind: 'overflow' };
    }
    totalWeightGrams += lineWeightGrams;
    totalUnits += quantity;
  }
  return totalWeightGrams <= PACKAGE_MAX_TOTAL_WEIGHT_GRAMS
    ? {
        kind: 'single_package_candidate',
        totalWeightGrams,
        totalUnits,
        readiness: 'candidate_only',
      }
    : {
        kind: 'balanced_split_required',
        totalWeightGrams,
        totalUnits,
        minimumPackageCount: ceilDiv(
          totalWeightGrams,
          PACKAGE_MAX_TOTAL_WEIGHT_GRAMS,
        ),
        resolution: 'manual_unresolved',
      };
}
