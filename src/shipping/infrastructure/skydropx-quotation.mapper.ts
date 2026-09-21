/**
 * SQ-3C2 Skydropx quotation filter/envelope mapper. Pure and never-throwing:
 * a shallow provider quotation (id + raw rate elements) becomes a fresh
 * provider-neutral quoted result, a `no_rates` error, or a
 * `malformed_response` error. It snapshots the rates-array length once, reads
 * each element once, delegates per-rate normalization to C1 `mapSkydropxRate`,
 * drops unusable rates while preserving order, and re-runs the neutral
 * quoted-result normalizer so no raw element, extra key, or sentinel can
 * reach output. The quotation id is validated up front with the exported
 * neutral `normalizeShippingQuoteId` (same result rule, no provider-specific
 * regex), so an invalid id fails closed even when no rate survives, and it is
 * reused verbatim when assembling the quoted output. `expiresAt` is always
 * null; no timestamp is fabricated.
 */
import type { ShippingQuoteProviderResult } from '../domain/shipping-quote.port';
import {
  normalizeShippingQuoteId,
  normalizeShippingQuoteQuotedResult,
  type ShippingQuoteRate,
} from '../domain/shipping-quote.result';
import { mapSkydropxRate } from './skydropx-rate.mapper';

const MAX_RATES = 100;

const malformed = (): ShippingQuoteProviderResult => ({
  kind: 'error',
  error: { kind: 'malformed_response' },
});
const noRates = (): ShippingQuoteProviderResult => ({
  kind: 'error',
  error: { kind: 'no_rates' },
});

/**
 * Snapshot a dense provider rates array, reading the length and each element
 * exactly once. Non-arrays, subclasses, null-prototype arrays, sparse arrays,
 * oversized/mutating lengths, and throwing proxy traps are rejected as `null`
 * so the caller emits `malformed_response` (boundary corruption), never
 * `no_rates`.
 */
function snapshotProviderRates(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const source = value as readonly unknown[];
    const rawLength: unknown = source.length;
    if (
      typeof rawLength !== 'number' ||
      !Number.isSafeInteger(rawLength) ||
      rawLength < 0 ||
      rawLength > MAX_RATES
    ) {
      return null;
    }
    const length = rawLength;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(source, index)) return null;
      out.push(source[index]);
    }
    return out;
  } catch {
    return null;
  }
}

export function mapSkydropxQuotation(
  quotationId: unknown,
  providerRates: unknown,
): ShippingQuoteProviderResult {
  try {
    const quoteId = normalizeShippingQuoteId(quotationId);
    if (quoteId === null) return malformed();
    const elements = snapshotProviderRates(providerRates);
    if (elements === null) return malformed();
    if (elements.length === 0) return noRates();
    const rates: ShippingQuoteRate[] = [];
    for (const element of elements) {
      const rate = mapSkydropxRate(element);
      if (rate !== null) rates.push(rate);
    }
    if (rates.length === 0) return noRates();
    const quoted = normalizeShippingQuoteQuotedResult({
      kind: 'quoted',
      quoteId: quotationId,
      rates,
      expiresAt: null,
    });
    return quoted === null ? malformed() : quoted;
  } catch {
    return malformed();
  }
}
