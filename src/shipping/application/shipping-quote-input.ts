import * as readiness from '../domain/package-readiness';
import * as request from '../domain/shipping-quote.request';

export const MAX_SHIPPING_QUOTE_PARCELS = 20;
const MAX_ITEMS = 100;
const COUNTRY_CODE = 'MX';
// prettier-ignore
/**
 * Finite assembly outcomes. Address and readiness stages short-circuit so
 * later categories are never read once an earlier stage has failed.
 */
export type ShippingQuoteRequestUnavailableReason =
  | 'invalid_input' | 'invalid_origin' | 'invalid_destination' | 'invalid_items'
  | 'missing_measurements' | 'packing_required' | 'parcel_limit_exceeded' | 'overflow';
type Reason = ShippingQuoteRequestUnavailableReason;
export type ShippingQuoteRequestAssemblyResult =
  | { readonly kind: 'ready'; readonly request: request.ShippingQuoteRequest }
  | { readonly kind: 'unavailable'; readonly reason: Reason }
  | {
      readonly kind: 'manual_packing_required';
      readonly minimumPackageCount: number;
    };
type Collected<T> =
  | { readonly kind: 'ok'; readonly items: T[] }
  | { readonly kind: 'over' }
  | { readonly kind: 'bad' };
type ParcelList = request.ShippingQuoteParcel[];
type Parcels =
  | { readonly kind: 'parcels'; readonly parcels: ParcelList }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'limit' };
type FieldRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };
const plain = (v: unknown): v is Record<string, unknown> => {
  try {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const proto: unknown = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
};
const read = (source: Record<string, unknown>, key: string): FieldRead => {
  try {
    return { ok: true, value: source[key] };
  } catch {
    return { ok: false };
  }
};
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const stop = (reason: Reason): ShippingQuoteRequestAssemblyResult =>
  Object.freeze({ kind: 'unavailable', reason });
const manual = (n: number): ShippingQuoteRequestAssemblyResult =>
  Object.freeze({ kind: 'manual_packing_required', minimumPackageCount: n });
function collect<T>(
  value: unknown,
  max: number,
  build: (raw: Record<string, unknown>) => T | null,
): Collected<T> {
  try {
    if (!Array.isArray(value)) return { kind: 'bad' };
    const length: unknown = value.length;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1
    ) {
      return { kind: 'bad' };
    }
    if (length > max) return { kind: 'over' };
    const items: T[] = [];
    for (let i = 0; i < length; i += 1) {
      // Own index only: never accept inherited/exotic prototype entries.
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        return { kind: 'bad' };
      }
      const raw: unknown = value[i];
      if (!plain(raw)) return { kind: 'bad' };
      const built = build(raw);
      if (built === null) return { kind: 'bad' };
      items.push(built);
    }
    return { kind: 'ok', items };
  } catch {
    return { kind: 'bad' };
  }
}
function address(
  value: unknown,
  field: 'postalCode' | 'zipCode',
): request.ShippingQuoteAddress | null {
  try {
    if (!plain(value)) return null;
    const postalCode: unknown = value[field];
    const state: unknown = value.state;
    const municipality: unknown = value.municipality;
    const neighborhood: unknown = value.neighborhood;
    const snapshot = Object.freeze({
      countryCode: COUNTRY_CODE,
      postalCode,
      state,
      municipality,
      neighborhood,
    });
    return request.isShippingQuoteAddress(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}
const toItem = (
  raw: Record<string, unknown>,
): readiness.PackageReadinessItemInput | null => {
  const productId: unknown = raw.productId;
  if (typeof productId !== 'string') return null;
  const variantId: unknown = raw.variantId;
  if (variantId != null && typeof variantId !== 'string') return null;
  const source: unknown = raw.measurement;
  const measurement: readiness.PackageMeasurementInput | null = plain(source)
    ? {
        weightGrams: num(source.weightGrams),
        lengthCm: num(source.lengthCm),
        widthCm: num(source.widthCm),
        heightCm: num(source.heightCm),
      }
    : null;
  const quantity: unknown = raw.quantity;
  return {
    productId,
    variantId: variantId ?? null,
    quantity: typeof quantity === 'number' ? quantity : 0,
    measurement,
  };
};
const toParcel = (
  raw: Record<string, unknown>,
): request.ShippingQuoteParcel | null => {
  const candidate = {
    lengthCm: raw.lengthCm,
    widthCm: raw.widthCm,
    heightCm: raw.heightCm,
    weightGrams: raw.weightGrams,
  };
  return request.isShippingQuoteParcel(candidate)
    ? Object.freeze(candidate)
    : null;
};
function items(value: unknown): readiness.PackageReadinessInput | null {
  const result = collect(value, MAX_ITEMS, toItem);
  return result.kind === 'ok' ? { items: result.items } : null;
}
function parcels(value: unknown): Parcels {
  const result = collect(value, MAX_SHIPPING_QUOTE_PARCELS, toParcel);
  if (result.kind === 'ok') return { kind: 'parcels', parcels: result.items };
  return result.kind === 'over' ? { kind: 'limit' } : { kind: 'invalid' };
}
/**
 * Pure, never-throwing assembly. Each input category is read exactly once,
 * only when its stage is reached; invalid addresses short-circuit before
 * items and non-single-package readiness short-circuits before parcels.
 */
export function assembleShippingQuoteRequest(
  value: unknown,
): ShippingQuoteRequestAssemblyResult {
  if (!plain(value)) return stop('invalid_input');
  const originRaw = read(value, 'origin');
  if (!originRaw.ok) return stop('invalid_origin');
  const origin = address(originRaw.value, 'postalCode');
  if (origin === null) return stop('invalid_origin');
  const destinationRaw = read(value, 'destination');
  if (!destinationRaw.ok) return stop('invalid_destination');
  const destination = address(destinationRaw.value, 'zipCode');
  if (destination === null) return stop('invalid_destination');
  const itemsRaw = read(value, 'items');
  if (!itemsRaw.ok) return stop('invalid_items');
  const readinessInput = items(itemsRaw.value);
  if (readinessInput === null) return stop('invalid_items');
  const assessed = readiness.assessPackageReadiness(readinessInput);
  if (assessed.kind === 'unavailable') return stop('missing_measurements');
  if (assessed.kind === 'overflow') return stop('overflow');
  if (assessed.kind === 'balanced_split_required') {
    return manual(assessed.minimumPackageCount);
  }
  const parcelsRaw = read(value, 'parcels');
  if (!parcelsRaw.ok) return stop('packing_required');
  const prepared = parcels(parcelsRaw.value);
  if (prepared.kind === 'invalid') return stop('packing_required');
  if (prepared.kind === 'limit') return stop('parcel_limit_exceeded');
  if (prepared.parcels.length !== 1) return manual(1);
  if (prepared.parcels[0].weightGrams !== assessed.totalWeightGrams) {
    return stop('packing_required');
  }
  const assembled: request.ShippingQuoteRequest = Object.freeze({
    origin,
    destination,
    // SAFETY: exactly one validated parcel here satisfies the nonempty tuple.
    parcels: Object.freeze([prepared.parcels[0]]) as unknown as readonly [
      request.ShippingQuoteParcel,
      ...request.ShippingQuoteParcel[],
    ],
  });
  if (!request.isShippingQuoteRequest(assembled)) {
    return stop('invalid_input');
  }
  return Object.freeze({ kind: 'ready', request: assembled });
}
