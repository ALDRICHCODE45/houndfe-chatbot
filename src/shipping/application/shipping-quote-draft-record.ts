import type { ShippingQuoteDraft } from './shipping-quote-draft';
import { normalizeShippingQuoteQuotedResult } from '../domain/shipping-quote.result';

export const SHIPPING_QUOTE_DRAFT_TTL_MS = 30 * 60 * 1000;
export const SHIPPING_QUOTE_DRAFT_KEY = 'shippingQuoteDraft';

export interface ShippingQuoteDraftRecord {
  readonly schemaVersion: 1;
  readonly draft: ShippingQuoteDraft;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const isPO = (v: unknown): v is Record<string, unknown> => {
  try {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const p: unknown = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  } catch {
    return false;
  }
};
const safeInt = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

const validNow = (n: unknown): n is number =>
  safeInt(n, 0) &&
  Number.isFinite(new Date(n).getTime()) &&
  Number.isFinite(new Date(n + SHIPPING_QUOTE_DRAFT_TTL_MS).getTime());

const mkRec = (
  d: ShippingQuoteDraft,
  ca: string,
  ea: string,
): ShippingQuoteDraftRecord =>
  Object.freeze({
    schemaVersion: 1,
    draft: Object.freeze({
      quoteId: d.quoteId,
      selectedRate: Object.freeze({ ...d.selectedRate }),
      providerExpiresAt: d.providerExpiresAt,
      bestRateCents: d.bestRateCents,
      totalCreditCents: d.totalCreditCents,
      appliedCreditCents: d.appliedCreditCents,
      unusedCreditCents: d.unusedCreditCents,
      qualifyingUnitCount: d.qualifyingUnitCount,
      customerPaysCents: d.customerPaysCents,
    }),
    createdAt: ca,
    expiresAt: ea,
  });

function snapshotDraft(raw: unknown): ShippingQuoteDraft | null {
  try {
    if (!isPO(raw)) return null;
    const sr = raw.selectedRate;
    if (!isPO(sr)) return null;
    const q = raw.quoteId,
      pe = raw.providerExpiresAt,
      m = raw.bestRateCents,
      t = raw.totalCreditCents,
      a = raw.appliedCreditCents,
      u = raw.unusedCreditCents,
      n = raw.qualifyingUnitCount,
      p = raw.customerPaysCents;
    const rid = sr.rateId,
      cn = sr.carrierName,
      sn = sr.serviceName,
      pc = sr.priceCents,
      cur = sr.currency,
      eta = sr.estimatedDeliveryDays,
      vu = sr.validUntil;
    const normalized = normalizeShippingQuoteQuotedResult({
      kind: 'quoted',
      quoteId: q,
      rates: [
        {
          rateId: rid,
          carrierName: cn,
          serviceName: sn,
          priceCents: pc,
          currency: cur,
          estimatedDeliveryDays: eta,
          validUntil: vu,
        },
      ],
      expiresAt: pe,
    });
    if (
      normalized === null ||
      !safeInt(m, 0) ||
      !safeInt(t, 0) ||
      !safeInt(a, 0) ||
      !safeInt(u, 0) ||
      !safeInt(n, 0) ||
      !safeInt(p, 0)
    )
      return null;
    const rate = normalized.rates[0];
    if (
      rate.priceCents !== m ||
      t !== n * 12_000 ||
      a !== Math.min(t, m) ||
      u !== t - a ||
      p !== m - a
    )
      return null;
    return {
      quoteId: normalized.quoteId,
      selectedRate: rate,
      providerExpiresAt: normalized.expiresAt,
      bestRateCents: m,
      totalCreditCents: t,
      appliedCreditCents: a,
      unusedCreditCents: u,
      qualifyingUnitCount: n,
      customerPaysCents: p,
    };
  } catch {
    return null;
  }
}

export function buildShippingQuoteDraftRecord(
  rawDraft: unknown,
  nowMs: number,
): ShippingQuoteDraftRecord | null {
  if (!validNow(nowMs)) return null;
  const draft = snapshotDraft(rawDraft);
  if (draft === null) return null;
  let e = nowMs + SHIPPING_QUOTE_DRAFT_TTL_MS;
  for (const iso of [
    draft.providerExpiresAt,
    draft.selectedRate.validUntil,
  ] as const) {
    if (iso === null) continue;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || t <= nowMs) return null;
    if (t < e) e = t;
  }
  return mkRec(draft, new Date(nowMs).toISOString(), new Date(e).toISOString());
}

export function normalizeShippingQuoteDraftRecord(
  value: unknown,
): ShippingQuoteDraftRecord | null {
  try {
    if (!isPO(value) || value.schemaVersion !== 1) return null;
    const ca = value.createdAt,
      ea = value.expiresAt;
    if (typeof ca !== 'string' || typeof ea !== 'string') return null;
    const cMs = new Date(ca).getTime(),
      eMs = new Date(ea).getTime();
    if (
      !Number.isFinite(cMs) ||
      !Number.isFinite(eMs) ||
      cMs >= eMs ||
      eMs - cMs > SHIPPING_QUOTE_DRAFT_TTL_MS
    )
      return null;
    if (new Date(ca).toISOString() !== ca || new Date(ea).toISOString() !== ea)
      return null;
    const draft = snapshotDraft(value.draft);
    if (draft === null) return null;
    for (const iso of [
      draft.providerExpiresAt,
      draft.selectedRate.validUntil,
    ]) {
      if (iso !== null && eMs > new Date(iso).getTime()) return null;
    }
    return mkRec(draft, ca, ea);
  } catch {
    return null;
  }
}
