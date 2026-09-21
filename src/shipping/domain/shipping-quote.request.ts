/**
 * Provider-neutral shipping-quote REQUEST contracts (SQ-2B1).
 *
 * Strings must be exact — no leading/trailing whitespace is accepted or
 * normalized away. `countryCode` is upper-case alpha-2; `postalCode` and
 * the administrative fields are nonblank and length-bounded. No rate,
 * result, error, port, or DI-token surface lives here; those belong to
 * SQ-2B2 and need their own runtime boundary validation.
 */
export interface ShippingQuoteAddress {
  readonly countryCode: string;
  readonly postalCode: string;
  readonly state: string;
  readonly municipality: string;
  readonly neighborhood: string;
}
export interface ShippingQuoteParcel {
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
  readonly weightGrams: number;
}
export interface ShippingQuoteRequest {
  readonly origin: ShippingQuoteAddress;
  readonly destination: ShippingQuoteAddress;
  readonly parcels: readonly [ShippingQuoteParcel, ...ShippingQuoteParcel[]];
}

const POSTAL_CODE_MAX_LENGTH = 12;
const ADMIN_FIELD_MAX_LENGTH = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isExactBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  );
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function isShippingQuoteAddress(
  value: unknown,
): value is ShippingQuoteAddress {
  if (!isPlainObject(value)) {
    return false;
  }
  if (
    typeof value.countryCode !== 'string' ||
    !/^[A-Z]{2}$/.test(value.countryCode)
  ) {
    return false;
  }
  return (
    isExactBoundedString(value.postalCode, POSTAL_CODE_MAX_LENGTH) &&
    isExactBoundedString(value.state, ADMIN_FIELD_MAX_LENGTH) &&
    isExactBoundedString(value.municipality, ADMIN_FIELD_MAX_LENGTH) &&
    isExactBoundedString(value.neighborhood, ADMIN_FIELD_MAX_LENGTH)
  );
}

export function isShippingQuoteParcel(
  value: unknown,
): value is ShippingQuoteParcel {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    isPositiveSafeInteger(value.lengthCm) &&
    isPositiveSafeInteger(value.widthCm) &&
    isPositiveSafeInteger(value.heightCm) &&
    isPositiveSafeInteger(value.weightGrams)
  );
}

export function isShippingQuoteRequest(
  value: unknown,
): value is ShippingQuoteRequest {
  if (!isPlainObject(value)) {
    return false;
  }
  if (
    !isShippingQuoteAddress(value.origin) ||
    !isShippingQuoteAddress(value.destination)
  ) {
    return false;
  }
  const parcels: unknown = value.parcels;
  if (!Array.isArray(parcels) || parcels.length === 0) {
    return false;
  }
  for (let index = 0; index < parcels.length; index += 1) {
    const parcel: unknown = parcels[index];
    if (!isShippingQuoteParcel(parcel)) {
      return false;
    }
  }
  return true;
}
