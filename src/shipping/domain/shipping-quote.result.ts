/** Provider-neutral shipping-quote RESULT contracts (SQ-2B2A). */
export interface ShippingQuoteRate {
  readonly rateId: string;
  readonly carrierName: string;
  readonly serviceName: string;
  readonly priceCents: number;
  readonly currency: 'MXN';
  readonly estimatedDeliveryDays: number | null;
  readonly validUntil: string | null;
}

export interface ShippingQuoteQuotedResult {
  readonly kind: 'quoted';
  readonly quoteId: string;
  readonly rates: readonly [ShippingQuoteRate, ...ShippingQuoteRate[]];
  readonly expiresAt: string | null;
}

const STRING_MAX_LENGTH = 128;
const MAX_RATE_COUNT = 100;
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isQuoteString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STRING_MAX_LENGTH &&
    value === value.trim()
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Only zoned ISO date-times; calendar day/month/hour are validated to reject rollovers. */
function canonicalIsoOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) return undefined;
  const parts = [match[1], match[2], match[3], match[4]].map(Number);
  const [year, month, day, hour] = parts;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 ? (leap ? 29 : 28) : DAYS_IN_MONTH[month - 1];
  if (month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23) {
    return undefined;
  }
  const epochMs = new Date(value).getTime();
  if (!Number.isFinite(epochMs)) return undefined;
  return new Date(epochMs).toISOString();
}

function normalizeRate(raw: unknown): ShippingQuoteRate | null {
  if (!isPlainObject(raw)) return null;
  const rateId: unknown = raw.rateId;
  const carrierName: unknown = raw.carrierName;
  const serviceName: unknown = raw.serviceName;
  const priceCents: unknown = raw.priceCents;
  const currency: unknown = raw.currency;
  const eta: unknown = raw.estimatedDeliveryDays;
  const rawValidUntil: unknown = raw.validUntil;
  if (
    !isQuoteString(rateId) ||
    !isQuoteString(carrierName) ||
    !isQuoteString(serviceName) ||
    !isNonNegativeSafeInteger(priceCents) ||
    currency !== 'MXN'
  ) {
    return null;
  }
  if (eta !== null && !isNonNegativeSafeInteger(eta)) return null;
  const validUntil = canonicalIsoOrNull(rawValidUntil);
  if (validUntil === undefined) return null;
  return {
    rateId,
    carrierName,
    serviceName,
    priceCents,
    currency: 'MXN',
    estimatedDeliveryDays: eta === null ? null : eta,
    validUntil,
  };
}

export function normalizeShippingQuoteQuotedResult(
  value: unknown,
): ShippingQuoteQuotedResult | null {
  try {
    if (!isPlainObject(value)) return null;
    const kind: unknown = value.kind;
    const quoteId: unknown = value.quoteId;
    const rawRates: unknown = value.rates;
    const rawExpiresAt: unknown = value.expiresAt;
    if (kind !== 'quoted' || !isQuoteString(quoteId)) return null;
    if (!Array.isArray(rawRates)) return null;
    const length = rawRates.length;
    if (length === 0 || length > MAX_RATE_COUNT) return null;
    const firstRate = normalizeRate(rawRates[0]);
    if (firstRate === null) return null;
    const rates: [ShippingQuoteRate, ...ShippingQuoteRate[]] = [firstRate];
    for (let index = 1; index < length; index += 1) {
      if (!(index in rawRates)) return null;
      const rate = normalizeRate(rawRates[index]);
      if (rate === null) return null;
      rates.push(rate);
    }
    const expiresAt = canonicalIsoOrNull(rawExpiresAt);
    if (expiresAt === undefined) return null;
    return { kind: 'quoted', quoteId, rates, expiresAt };
  } catch {
    return null;
  }
}
