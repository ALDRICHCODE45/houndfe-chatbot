/**
 * SQ-6C production shipping-outcome logger.
 *
 * The only production telemetry sink. It emits exactly the allowlisted finite
 * kind/reason labels through the Nest `Logger` and nothing else: it never
 * reads a payload, raw error, price, address, reference, or token, silently
 * ignores any kind or reason outside its per-kind allowlists (no coercion, no
 * raw output), and swallows a throwing log sink so logging can never change a
 * quote outcome. A reason paired with the wrong kind (including `draft` with
 * any reason or a non-draft kind without one) is dropped, never logged. It is
 * registered only inside the enabled shipping module graph, so it is inert
 * when shipping is disabled.
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  ShippingQuoteTelemetryKind,
  ShippingQuoteTelemetryPort,
  ShippingQuoteTelemetryReason,
} from '../domain/shipping-telemetry.port';

const PREFIX = 'shipping_quote_outcome';
const KINDS: readonly string[] = Object.freeze([
  'draft',
  'unavailable',
  'handoff',
]);
const UNAVAILABLE_REASONS: readonly string[] = Object.freeze([
  'invalid_input',
  'invalid_origin',
  'invalid_destination',
  'invalid_items',
  'missing_measurements',
  'packing_required',
  'parcel_limit_exceeded',
  'overflow',
  'invalid_cart',
  'provider_disabled',
]);
const HANDOFF_REASONS: readonly string[] = Object.freeze([
  'manual_packing_required',
  'no_rates',
  'provider_rejected_request',
  'provider_failure',
  'credit_overflow',
]);

@Injectable()
export class ShippingQuoteOutcomeLogger implements ShippingQuoteTelemetryPort {
  private readonly logger = new Logger(ShippingQuoteOutcomeLogger.name);

  record(
    kind: ShippingQuoteTelemetryKind,
    reason?: ShippingQuoteTelemetryReason,
  ): void {
    // Per-kind validation against frozen allowlists before any output: a
    // reason only emits with its own kind, `draft` never carries a reason, a
    // non-draft kind always requires one, and an unknown value is ignored
    // without ever being coerced to text.
    if (!KINDS.includes(kind)) return;
    if (kind === 'draft') {
      if (reason !== undefined) return;
      this.safeLog(`${PREFIX} kind=${kind}`);
      return;
    }
    const allowed =
      kind === 'unavailable' ? UNAVAILABLE_REASONS : HANDOFF_REASONS;
    if (reason === undefined || !allowed.includes(reason)) return;
    this.safeLog(`${PREFIX} kind=${kind} reason=${reason}`);
  }

  private safeLog(line: string): void {
    try {
      this.logger.log(line);
    } catch {
      // Best-effort only: a sink failure must not change a quote outcome.
    }
  }
}
