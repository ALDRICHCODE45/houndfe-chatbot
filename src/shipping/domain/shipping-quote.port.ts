/**
 * Provider-neutral shipping-quote PORT contracts (SQ-2B2B2).
 *
 * The provider boundary returns either a normalized quoted result or a
 * structured error envelope. `normalizeShippingQuoteProviderResult` treats
 * the input as an untrusted plain record, snapshots the top-level `kind`
 * once, delegates to the existing quoted/error normalizers, and rebuilds a
 * fresh exact envelope so extras, sentinel secrets, and untrusted nested
 * state can never leak. It never throws.
 */
import {
  normalizeShippingQuoteError,
  type ShippingQuoteError,
} from './shipping-quote.error';
import type { ShippingQuoteRequest } from './shipping-quote.request';
import {
  normalizeShippingQuoteQuotedResult,
  type ShippingQuoteQuotedResult,
} from './shipping-quote.result';

/** Unique DI token that stands for the active shipping-quote provider. */
export const SHIPPING_QUOTE_PROVIDER = Symbol('SHIPPING_QUOTE_PROVIDER');

export type ShippingQuoteProviderResult =
  | ShippingQuoteQuotedResult
  | { readonly kind: 'error'; readonly error: ShippingQuoteError };

export interface ShippingQuoteProviderPort {
  quote(request: ShippingQuoteRequest): Promise<ShippingQuoteProviderResult>;
}

const malformed = (): ShippingQuoteProviderResult => ({
  kind: 'error',
  error: { kind: 'malformed_response' },
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function normalizeShippingQuoteProviderResult(
  value: unknown,
): ShippingQuoteProviderResult {
  try {
    if (!isPlainObject(value)) return malformed();
    const kind: unknown = value.kind;
    if (kind === 'quoted') {
      const quoted = normalizeShippingQuoteQuotedResult(value);
      return quoted === null ? malformed() : quoted;
    }
    if (kind === 'error') {
      const rawError: unknown = value.error;
      return { kind: 'error', error: normalizeShippingQuoteError(rawError) };
    }
    return malformed();
  } catch {
    return malformed();
  }
}
