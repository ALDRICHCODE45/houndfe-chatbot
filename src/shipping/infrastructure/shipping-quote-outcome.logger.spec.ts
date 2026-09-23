/**
 * SQ-6C redacted shipping-outcome logger spec.
 *
 * The logger is the only production telemetry sink. It must emit exactly the
 * allowlisted finite labels, ignore any other value without ever coercing it
 * into output, and swallow a throwing log sink so logging can never become a
 * failure source. No payload, raw error, price, address, reference, or token
 * may appear in any emitted line.
 */
import { Logger } from '@nestjs/common';
import type {
  ShippingQuoteTelemetryKind,
  ShippingQuoteTelemetryReason,
} from '../domain/shipping-telemetry.port';
import { ShippingQuoteOutcomeLogger } from './shipping-quote-outcome.logger';

const SECRET = 'svc_leaked_secret_token_value';
const sink = (): jest.SpyInstance =>
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

describe('SQ-6C ShippingQuoteOutcomeLogger', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = sink();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // prettier-ignore
  it.each<[ShippingQuoteTelemetryKind, ShippingQuoteTelemetryReason | undefined, string]>([
    ['draft', undefined, 'shipping_quote_outcome kind=draft'],
    ['unavailable', 'invalid_input', 'shipping_quote_outcome kind=unavailable reason=invalid_input'],
    ['unavailable', 'invalid_origin', 'shipping_quote_outcome kind=unavailable reason=invalid_origin'],
    ['unavailable', 'invalid_destination', 'shipping_quote_outcome kind=unavailable reason=invalid_destination'],
    ['unavailable', 'invalid_items', 'shipping_quote_outcome kind=unavailable reason=invalid_items'],
    ['unavailable', 'missing_measurements', 'shipping_quote_outcome kind=unavailable reason=missing_measurements'],
    ['unavailable', 'packing_required', 'shipping_quote_outcome kind=unavailable reason=packing_required'],
    ['unavailable', 'parcel_limit_exceeded', 'shipping_quote_outcome kind=unavailable reason=parcel_limit_exceeded'],
    ['unavailable', 'overflow', 'shipping_quote_outcome kind=unavailable reason=overflow'],
    ['unavailable', 'invalid_cart', 'shipping_quote_outcome kind=unavailable reason=invalid_cart'],
    ['unavailable', 'provider_disabled', 'shipping_quote_outcome kind=unavailable reason=provider_disabled'],
    ['handoff', 'manual_packing_required', 'shipping_quote_outcome kind=handoff reason=manual_packing_required'],
    ['handoff', 'no_rates', 'shipping_quote_outcome kind=handoff reason=no_rates'],
    ['handoff', 'provider_rejected_request', 'shipping_quote_outcome kind=handoff reason=provider_rejected_request'],
    ['handoff', 'provider_failure', 'shipping_quote_outcome kind=handoff reason=provider_failure'],
    ['handoff', 'credit_overflow', 'shipping_quote_outcome kind=handoff reason=credit_overflow'],
  ])('emits exactly one finite label for %s/%s', (kind, reason, expected) => {
    new ShippingQuoteOutcomeLogger().record(kind, reason);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expected);
  });

  // prettier-ignore
  it.each<[unknown, unknown]>([
    ['mystery', undefined],
    ['', undefined],
    [SECRET, undefined],
    [undefined, undefined],
    [null, undefined],
    [42, undefined],
    [{ toString: () => SECRET }, undefined],
    ['unavailable', 'raw_secret_reason'],
    ['unavailable', SECRET],
    ['unavailable', ''],
    ['handoff', { toString: () => SECRET }],
    ['draft', 'unexpected_reason'],
    ['draft', 'provider_failure'],
    ['draft', 'invalid_input'],
    ['unavailable', 'no_rates'],
    ['unavailable', 'manual_packing_required'],
    ['unavailable', 'credit_overflow'],
    ['handoff', 'invalid_input'],
    ['handoff', 'provider_disabled'],
    ['unavailable', undefined],
    ['handoff', undefined],
  ])('ignores invalid labels %# without emitting raw output', (kind, reason) => {
    new ShippingQuoteOutcomeLogger().record(
      kind as ShippingQuoteTelemetryKind,
      reason as ShippingQuoteTelemetryReason | undefined,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('swallows a throwing log sink instead of propagating', () => {
    log.mockImplementation(() => {
      throw new Error(SECRET);
    });
    expect(() =>
      new ShippingQuoteOutcomeLogger().record('handoff', 'provider_failure'),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      'shipping_quote_outcome kind=handoff reason=provider_failure',
    );
  });
});
