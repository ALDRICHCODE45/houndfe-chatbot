/**
 * Provider-neutral shipping-quote ERROR contracts (SQ-2B2B1).
 *
 * The error union is finite and secret-safe: it never carries an arbitrary
 * external string (body, payload, token, address, message, providerCode).
 * `normalizeShippingQuoteError` is a runtime boundary that never throws,
 * snapshots each field once, and rebuilds exact fresh objects, so untrusted
 * provider values cannot leak or mutate state.
 */
export type ShippingQuoteField =
  | 'origin'
  | 'destination'
  | 'parcels'
  | 'unknown';

export type ShippingQuoteError =
  | { readonly kind: 'auth_failed' }
  | { readonly kind: 'invalid_request'; readonly field: ShippingQuoteField }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  | {
      readonly kind: 'upstream_unavailable';
      readonly httpStatus: number | null;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'malformed_response' }
  | { readonly kind: 'no_rates' }
  | { readonly kind: 'provider_disabled' };

const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const isField = (value: unknown): value is ShippingQuoteField =>
  value === 'origin' ||
  value === 'destination' ||
  value === 'parcels' ||
  value === 'unknown';
const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isHttpStatus = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 100 &&
  value <= 599;

/** Never throws; any unknown or malformed input becomes `malformed_response`. */
export function normalizeShippingQuoteError(
  value: unknown,
): ShippingQuoteError {
  try {
    if (!isObject(value)) return { kind: 'malformed_response' };
    const kind: unknown = value.kind;
    switch (kind) {
      case 'auth_failed':
        return { kind: 'auth_failed' };
      case 'invalid_request': {
        const field: unknown = value.field;
        return isField(field)
          ? { kind: 'invalid_request', field }
          : { kind: 'malformed_response' };
      }
      case 'rate_limited': {
        const retryAfterSeconds: unknown = value.retryAfterSeconds;
        return retryAfterSeconds === null ||
          isNonNegativeSafeInteger(retryAfterSeconds)
          ? { kind: 'rate_limited', retryAfterSeconds }
          : { kind: 'malformed_response' };
      }
      case 'upstream_unavailable': {
        const httpStatus: unknown = value.httpStatus;
        return httpStatus === null || isHttpStatus(httpStatus)
          ? { kind: 'upstream_unavailable', httpStatus }
          : { kind: 'malformed_response' };
      }
      case 'timeout':
        return { kind: 'timeout' };
      case 'malformed_response':
        return { kind: 'malformed_response' };
      case 'no_rates':
        return { kind: 'no_rates' };
      case 'provider_disabled':
        return { kind: 'provider_disabled' };
      default:
        return { kind: 'malformed_response' };
    }
  } catch {
    return { kind: 'malformed_response' };
  }
}
