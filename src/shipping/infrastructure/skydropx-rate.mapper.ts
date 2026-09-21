/**
 * SQ-3C1 Skydropx `/api/v1/quotations/{id}` rate-element mapper. Pure and
 * never-throwing: one shallow provider rate element becomes a fresh
 * provider-neutral `ShippingQuoteRate` or `null`. It reads only documented
 * fields, snapshots each value once, converts decimal MXN `total` to integer
 * cents with exact BigInt arithmetic (no float, no coercion), and never
 * retains or re-serializes the raw object. C2 filters untrusted rates.
 */
import type { ShippingQuoteRate } from '../domain/shipping-quote.result';

const MAX_STRING_LENGTH = 128;
const MAX_DECIMAL_LENGTH = 32;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const CURRENCY = 'MXN';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRequiredString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_STRING_LENGTH &&
    value === value.trim()
  );
}

function isEta(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Canonical nonnegative decimal MXN to exact integer cents. Strings must be
 * canonical; finite numbers must have a <=2-decimal canonical string and a
 * cent value no adjacent cent collapses onto, rejecting float artifacts.
 */
function decimalToCents(value: unknown): number | null {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    if (Object.is(value, -0)) return null;
    text = String(value);
  } else {
    return null;
  }
  if (text.length === 0 || text.length > MAX_DECIMAL_LENGTH) return null;
  const match = DECIMAL.exec(text);
  if (match === null) return null;
  const cents =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (cents > MAX_SAFE_CENTS) return null;
  const exact = Number(cents);
  if (typeof value === 'string') return exact;
  if (exact / 100 !== value) return null;
  if (Number(cents + 1n) / 100 === value) return null;
  return cents > 0n && Number(cents - 1n) / 100 === value ? null : exact;
}

export function mapSkydropxRate(raw: unknown): ShippingQuoteRate | null {
  try {
    if (!isPlainRecord(raw)) return null;
    const id: unknown = raw.id;
    const success: unknown = raw.success;
    const carrier: unknown = raw.provider_display_name;
    const service: unknown = raw.provider_service_name;
    const currency: unknown = raw.currency_code;
    const total: unknown = raw.total;
    const days: unknown = raw.days;
    if (
      success !== true ||
      currency !== CURRENCY ||
      !isRequiredString(id) ||
      !isRequiredString(carrier) ||
      !isRequiredString(service) ||
      !isEta(days)
    ) {
      return null;
    }
    const priceCents = decimalToCents(total);
    if (priceCents === null) return null;
    return Object.freeze({
      rateId: id,
      carrierName: carrier,
      serviceName: service,
      priceCents,
      currency: CURRENCY,
      estimatedDeliveryDays: days,
      validUntil: null,
    });
  } catch {
    return null;
  }
}
