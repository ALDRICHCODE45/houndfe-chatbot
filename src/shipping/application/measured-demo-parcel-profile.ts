/**
 * SQ-5B1 measured-demo-profile membrane.
 *
 * One versioned, exactly-shaped real measured demo cart profile. These values
 * are future controlled configuration, never production packing logic: absent,
 * invalid, or mismatched input returns `null` and never quotes. Measurements
 * are observed, never inferred. Every declared source property is read once
 * into fresh, exact-key, deeply frozen values that retain no source reference.
 */
import { PACKAGE_MAX_TOTAL_WEIGHT_GRAMS } from '../domain/package-readiness';

export const MEASURED_DEMO_PARCEL_PROFILE_VERSION = 1;
export const MAX_MEASURED_DEMO_PROFILE_ITEM_LINES = 20;

// prettier-ignore
export interface MeasuredDemoParcelMeasurement { readonly weightGrams: number; readonly lengthCm: number; readonly widthCm: number; readonly heightCm: number; }
// prettier-ignore
export interface MeasuredDemoParcelProfileItem { readonly productId: string; readonly variantId: string | null; readonly quantity: number; readonly measurement: MeasuredDemoParcelMeasurement; }
// prettier-ignore
export interface MeasuredDemoParcelProfile { readonly version: typeof MEASURED_DEMO_PARCEL_PROFILE_VERSION; readonly items: readonly MeasuredDemoParcelProfileItem[]; readonly parcel: MeasuredDemoParcelMeasurement; }
// prettier-ignore
export interface MeasuredDemoPreparedItem { readonly productId: string; readonly variantId: string | null; readonly quantity: number; readonly unitPriceCents: number; readonly measurement: MeasuredDemoParcelMeasurement; }
// prettier-ignore
export interface MeasuredDemoPreparedInput { readonly items: readonly MeasuredDemoPreparedItem[]; readonly parcels: readonly [MeasuredDemoParcelMeasurement]; }
// prettier-ignore
interface CartLine { readonly quantity: number; readonly unitPriceCents: number; }

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i;
// prettier-ignore
const isPlainRecord = (value: unknown): value is Record<string, unknown> => { try { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const proto: unknown = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; } catch { return false; } };
const positiveSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const nonNegativeSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
// prettier-ignore
const canonicalUuid = (value: unknown): string | null | undefined => { if (value === null || value === undefined) return null; return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined; };
const keyOf = (productId: string, variantId: string | null): string =>
  `${productId}\u0000${variantId ?? ''}`;

/** Reads the four observed dimensions once each; never infers a measurement. */
// prettier-ignore
function measurement(source: unknown): MeasuredDemoParcelMeasurement | null { if (!isPlainRecord(source)) return null; const w: unknown = source.weightGrams, l: unknown = source.lengthCm, wd: unknown = source.widthCm, h: unknown = source.heightCm; if (!positiveSafeInt(w) || !positiveSafeInt(l) || !positiveSafeInt(wd) || !positiveSafeInt(h)) return null; return Object.freeze({ weightGrams: w, lengthCm: l, widthCm: wd, heightCm: h }); }

/** Dense own-index snapshot: rejects empty, sparse, inherited, and exotic arrays. */
// prettier-ignore
function dense(value: unknown, max: number): unknown[] | null { try { if (!Array.isArray(value)) return null; const length: unknown = value.length; if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > max) return null; const out: unknown[] = []; for (let i = 0; i < length; i += 1) { if (!Object.prototype.hasOwnProperty.call(value, i)) return null; out.push(value[i]); } return out; } catch { return null; } }

/** Overflow-safe `quantity * weightGrams`; `null` when the product is unsafe. */
// prettier-ignore
function lineWeight(quantity: number, weightGrams: number): number | null { if (quantity > Math.floor(MAX_SAFE / weightGrams)) return null; const product = quantity * weightGrams; return Number.isSafeInteger(product) ? product : null; }

function profileItem(raw: unknown): MeasuredDemoParcelProfileItem | null {
  if (!isPlainRecord(raw)) return null;
  const productId = canonicalUuid(raw.productId);
  if (productId === null || productId === undefined) return null;
  const variantId = canonicalUuid(raw.variantId);
  if (variantId === undefined) return null;
  const quantity: unknown = raw.quantity;
  if (!positiveSafeInt(quantity)) return null;
  const observed = measurement(raw.measurement);
  if (observed === null) return null;
  // prettier-ignore
  return Object.freeze({ productId, variantId, quantity, measurement: observed });
}

/**
 * Never-throwing one-read boundary. Returns a fresh, exact-key, deeply frozen
 * version-1 profile or `null` for anything absent, malformed, duplicated,
 * overflowed, or above the committed 25,000g one-parcel readiness cap.
 */
// prettier-ignore
export function normalizeMeasuredDemoParcelProfile(value: unknown): MeasuredDemoParcelProfile | null {
  try {
    if (!isPlainRecord(value)) return null;
    if (value.version !== MEASURED_DEMO_PARCEL_PROFILE_VERSION) return null;
    const rawItems = dense(value.items, MAX_MEASURED_DEMO_PROFILE_ITEM_LINES);
    if (rawItems === null) return null;
    const items: MeasuredDemoParcelProfileItem[] = []; const seen = new Set<string>();
    // prettier-ignore
    for (const raw of rawItems) { const item = profileItem(raw); if (item === null) return null; const key = keyOf(item.productId, item.variantId); if (seen.has(key)) return null; seen.add(key); items.push(item); }
    let total = 0;
    // prettier-ignore
    for (const item of items) { const line = lineWeight(item.quantity, item.measurement.weightGrams); if (line === null || total > MAX_SAFE - line) return null; total += line; }
    if (total > PACKAGE_MAX_TOTAL_WEIGHT_GRAMS) return null;
    const parcel = measurement(value.parcel);
    if (parcel === null || parcel.weightGrams !== total) return null;
    // prettier-ignore
    return Object.freeze({ version: MEASURED_DEMO_PARCEL_PROFILE_VERSION, items: Object.freeze(items), parcel });
  } catch { return null; }
}

/**
 * Pure matcher. Normalizes the profile and accepts only an identical bounded
 * cart by exact productId/normalized variantId/quantity multiset. Cart order
 * may differ; output uses profile order and copies each matching cart price.
 * No subset, superset, or weight-only match; every other case returns `null`.
 */
// prettier-ignore
export function matchMeasuredDemoParcelProfile(profileValue: unknown, cartValue: unknown): MeasuredDemoPreparedInput | null {
  const profile = normalizeMeasuredDemoParcelProfile(profileValue);
  if (profile === null) return null;
  try {
    const rawCart = dense(cartValue, MAX_MEASURED_DEMO_PROFILE_ITEM_LINES);
    if (rawCart === null || rawCart.length !== profile.items.length) return null;
    const byKey = new Map<string, CartLine>();
    // prettier-ignore
    for (const raw of rawCart) { if (!isPlainRecord(raw)) return null; const productId = canonicalUuid(raw.productId); if (productId === null || productId === undefined) return null; const variantId = canonicalUuid(raw.variantId); if (variantId === undefined) return null; const quantity: unknown = raw.quantity; if (!positiveSafeInt(quantity)) return null; const unitPriceCents: unknown = raw.unitPriceCents; if (!nonNegativeSafeInt(unitPriceCents)) return null; const key = keyOf(productId, variantId); if (byKey.has(key)) return null; byKey.set(key, { quantity, unitPriceCents }); }
    const items: MeasuredDemoPreparedItem[] = [];
    // prettier-ignore
    for (const item of profile.items) { const line = byKey.get(keyOf(item.productId, item.variantId)); if (line === undefined || line.quantity !== item.quantity) return null; items.push(Object.freeze({ productId: item.productId, variantId: item.variantId, quantity: item.quantity, unitPriceCents: line.unitPriceCents, measurement: Object.freeze({ ...item.measurement }) })); }
    const parcel = Object.freeze({ ...profile.parcel });
    // SAFETY: a one-element literal is narrowed to the required nonempty single-parcel tuple after freezing.
    // prettier-ignore
    const parcels = Object.freeze([parcel]) as unknown as readonly [MeasuredDemoParcelMeasurement];
    return Object.freeze({ items: Object.freeze(items), parcels });
  } catch { return null; }
}
