/**
 * SQ-6C redacted shipping-outcome telemetry port.
 *
 * Fixed, finite result labels only — never a request payload, raw provider
 * error, price, address, reference, or token. Implementations must be
 * best-effort: a sink failure must never propagate back into the orchestrator
 * or change a quote outcome.
 */

/** Finite, non-sensitive shipping-quote result kinds. */
export type ShippingQuoteTelemetryKind = 'draft' | 'unavailable' | 'handoff';

/**
 * Finite, non-sensitive reason labels. Paired with a kind where the result
 * carries a reason; `draft` never has one.
 */
export type ShippingQuoteTelemetryReason =
  | 'invalid_input'
  | 'invalid_origin'
  | 'invalid_destination'
  | 'invalid_items'
  | 'missing_measurements'
  | 'packing_required'
  | 'parcel_limit_exceeded'
  | 'overflow'
  | 'invalid_cart'
  | 'provider_disabled'
  | 'manual_packing_required'
  | 'no_rates'
  | 'provider_rejected_request'
  | 'provider_failure'
  | 'credit_overflow';

export interface ShippingQuoteTelemetryPort {
  record(
    kind: ShippingQuoteTelemetryKind,
    reason?: ShippingQuoteTelemetryReason,
  ): void;
}
