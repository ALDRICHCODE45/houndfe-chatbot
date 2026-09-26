/**
 * SQ-4C provider-to-draft orchestration.
 *
 * One stage-lazy membrane lets `assembleShippingQuoteRequest` consume exact
 * logistics fields while credit lines derive from the SAME per-item snapshot
 * (`quantity` + `unitPriceCents`); a legacy `creditLines` field is never read.
 * The provider is called once, its raw response passes the approved one-read
 * membrane, and the committed SQ-4A draft is composed. Outcomes are finite,
 * fresh, frozen, and secret-safe with no persistence, retry, timer, logging,
 * customer copy, or per-call state.
 */
import type { ShippingCreditLine } from '../domain/shipping-credit';
import type { ShippingQuoteError } from '../domain/shipping-quote.error';
import type { ShippingQuoteTelemetryPort } from '../domain/shipping-telemetry.port';
// prettier-ignore
import { normalizeShippingQuoteProviderResult, type ShippingQuoteProviderPort } from '../domain/shipping-quote.port';
// prettier-ignore
import { buildShippingQuoteDraft, type ShippingQuoteDraft, type ShippingQuoteDraftOutcome } from './shipping-quote-draft';
// prettier-ignore
import { assembleShippingQuoteRequest, type ShippingQuoteRequestUnavailableReason } from './shipping-quote-input';

// prettier-ignore
/** Narrow quote-only provider surface; runtime input carries the raw request. */
export type ShippingQuoteOrchestratorProvider = Pick<ShippingQuoteProviderPort, 'quote'>;
// prettier-ignore
export interface ShippingQuoteOrchestrationInput { readonly requestInput: unknown; }
// prettier-ignore
/** Assembly reasons plus orchestration-only unavailability reasons. */
export type ShippingQuoteOrchestrationUnavailableReason = ShippingQuoteRequestUnavailableReason | 'invalid_cart' | 'provider_disabled';
// prettier-ignore
/** Handoff reasons that carry no extra payload. */
export type ShippingQuoteOrchestrationHandoffReason = 'no_rates' | 'provider_rejected_request' | 'provider_failure' | 'credit_overflow';
// prettier-ignore
/** Exact finite orchestration result. */
export type ShippingQuoteOrchestrationResult =
  | { readonly kind: 'draft'; readonly draft: ShippingQuoteDraft }
  | { readonly kind: 'unavailable'; readonly reason: ShippingQuoteOrchestrationUnavailableReason }
  | { readonly kind: 'handoff'; readonly reason: 'manual_packing_required'; readonly minimumPackageCount: number }
  | { readonly kind: 'handoff'; readonly reason: ShippingQuoteOrchestrationHandoffReason };

/** Dense own-index 1..100 bound for conversation cart items. */
export const MAX_SHIPPING_QUOTE_ITEM_LINES = 100;

// prettier-ignore
const unavailable = (reason: ShippingQuoteOrchestrationUnavailableReason): ShippingQuoteOrchestrationResult => Object.freeze({ kind: 'unavailable', reason });
// prettier-ignore
const handoff = (reason: ShippingQuoteOrchestrationHandoffReason): ShippingQuoteOrchestrationResult => Object.freeze({ kind: 'handoff', reason });
// prettier-ignore
const manualHandoff = (minimumPackageCount: number): ShippingQuoteOrchestrationResult => Object.freeze({ kind: 'handoff', reason: 'manual_packing_required', minimumPackageCount });
// prettier-ignore
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const proto: unknown = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; } catch { return false; }
}
// prettier-ignore
const safeInt = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

/** Credit captured from the same item snapshot the assembler consumes. */
type CreditCapture = { lines: readonly ShippingCreditLine[] | null };

// prettier-ignore
/** Dense own-index 1..100 item snapshot: exact logistics fields plus credit. */
function snapshotItems(raw: unknown, capture: CreditCapture): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  const length: unknown = raw.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > MAX_SHIPPING_QUOTE_ITEM_LINES) return null;
  const items: Record<string, unknown>[] = []; const lines: ShippingCreditLine[] = []; let bad = false;
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) return null;
    const item: unknown = raw[index];
    if (!isPlainRecord(item)) return null;
    const productId: unknown = item.productId, variantId: unknown = item.variantId, quantity: unknown = item.quantity;
    const source: unknown = item.measurement;
    const measurement = isPlainRecord(source) ? { weightGrams: source.weightGrams, lengthCm: source.lengthCm, widthCm: source.widthCm, heightCm: source.heightCm } : null;
    items.push({ productId, variantId, quantity, measurement });
    let price: unknown;
    try { price = item.unitPriceCents; } catch { price = undefined; }
    if (safeInt(price, 0) && safeInt(quantity, 1)) lines.push(Object.freeze({ unitPriceCents: price, quantity })); else bad = true;
  }
  capture.lines = bad ? null : Object.freeze(lines);
  return items;
}

// prettier-ignore
/** Stage-lazy request membrane: categories read once, only when reached. */
function requestMembrane(raw: unknown, capture: CreditCapture): Record<string, unknown> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return new Proxy(raw, { get: (target, key) => { const value: unknown = target[String(key)]; return key === 'items' ? snapshotItems(value, capture) : value; } });
}

// prettier-ignore
function mapDraft(outcome: ShippingQuoteDraftOutcome): ShippingQuoteOrchestrationResult {
  if (outcome.kind === 'draft') return outcome;
  if (outcome.kind === 'handoff') return handoff('credit_overflow');
  return outcome.reason === 'invalid_cart' ? unavailable('invalid_cart') : handoff('provider_failure');
}
// prettier-ignore
function mapProviderError(error: ShippingQuoteError): ShippingQuoteOrchestrationResult {
  switch (error.kind) {
    case 'provider_disabled': return unavailable('provider_disabled');
    case 'no_rates': return handoff('no_rates');
    case 'invalid_request': return handoff('provider_rejected_request');
    default: return handoff('provider_failure');
  }
}
// prettier-ignore
/** Never-throwing one-read membrane over the raw top-level provider response. */
function snapshotProviderResponse(value: unknown): Record<string, unknown> {
  try {
    if (!isPlainRecord(value)) return {};
    const kind: unknown = value.kind;
    if (kind === 'quoted') return { kind: 'quoted', quoteId: value.quoteId, rates: value.rates, expiresAt: value.expiresAt };
    if (kind === 'error') return { kind: 'error', error: value.error };
    return { kind };
  } catch { return {}; }
}

// prettier-ignore
/** Stateless: no per-call state, so concurrent requests stay isolated. */
export class ShippingQuoteOrchestrator {
  constructor(
    private readonly provider: ShippingQuoteOrchestratorProvider,
    private readonly telemetry?: ShippingQuoteTelemetryPort,
  ) {}
  async quote(value: unknown): Promise<ShippingQuoteOrchestrationResult> {
    const result = await this.evaluate(value);
    this.record(result);
    return result;
  }
  // prettier-ignore
  /** One non-throwing redacted record per final outcome; never changes it. */
  private record(result: ShippingQuoteOrchestrationResult): void {
    try {
      if (result.kind === 'draft') this.telemetry?.record('draft');
      else this.telemetry?.record(result.kind, result.reason);
    } catch {
      // Telemetry is best-effort and cannot alter the quote outcome.
    }
  }
  // prettier-ignore
  private async evaluate(value: unknown): Promise<ShippingQuoteOrchestrationResult> {
    let requestInput: unknown;
    try { requestInput = isPlainRecord(value) ? value.requestInput : undefined; } catch { requestInput = undefined; }
    const capture: CreditCapture = { lines: null };
    const assembly = assembleShippingQuoteRequest(requestMembrane(requestInput, capture));
    if (assembly.kind === 'unavailable') return unavailable(assembly.reason);
    if (assembly.kind === 'manual_packing_required') return manualHandoff(assembly.minimumPackageCount);
    const creditLines = capture.lines;
    if (creditLines === null) return unavailable('invalid_cart');
    let raw: unknown;
    try { raw = await this.provider.quote(assembly.request); } catch { return handoff('provider_failure'); }
    const normalized = normalizeShippingQuoteProviderResult(snapshotProviderResponse(raw));
    if (normalized.kind === 'quoted') return mapDraft(buildShippingQuoteDraft(normalized, creditLines));
    return mapProviderError(normalized.error);
  }
}
