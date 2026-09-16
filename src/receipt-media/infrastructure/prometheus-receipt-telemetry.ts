/** WU15-2 telemetry adapter: Prometheus metrics via prom-client@15.1.3.
 *
 * Implements the three-event ReceiptTelemetryPort contract with an isolated
 * per-instance Registry (no global/default/process collectors), a fixed
 * configuration-state gauge, and a finite runtime-validated event/template
 * allowlist. Telemetry failures never escape to the business flow. The
 * adapter is a singleton provider composed into ReceiptMediaModule.
 *
 * Design notes:
 * - Metrics are created lazily: event time series appear only after the
 *   first record() call (not at boot). The configuration-state gauge is
 *   the only metric that may exist before any record() call.
 * - No IDs, PII, URLs, tokens, filenames, captions, or arbitrary error
 *   text ever appears in metric labels.
 * - record() is a no-op when metricsFlag is false.
 * - Serialization failures propagate to the caller for HTTP-level handling.
 */
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';
import type { ReceiptTelemetryEvent } from '../domain/receipt-telemetry.port';
import { RECEIPT_TEMPLATE_KEYS } from '../domain/receipt-media.types';

/** Injection token for ReceiptTelemetryPort. */
export const RECEIPT_TELEMETRY = Symbol('RECEIPT_TELEMETRY');

/** Set of allowed event names (the three TX2 events from the port). */
const ALLOWED_EVENTS = new Set<ReceiptTelemetryEvent>([
  'receipt_outbox_tx2_committed',
  'receipt_outbox_tx2_transition_lost',
  'receipt_outbox_tx2_failed',
] as const);

/** Set of allowed templateKey values. */
const ALLOWED_TEMPLATE_KEYS = new Set(RECEIPT_TEMPLATE_KEYS);

/** Configuration-state gauge name: reflects the metrics flag, not receipt admission. */
const METRICS_GAUGE_NAME = 'receipt_media_metrics_enabled';

/** Guards a string label value against unsafe characters allowed by Prometheus.
 * Only alphanumerics, underscores, and hyphens are permitted; no quotes,
 * brackets, newlines, or control characters. */
function safeLabelValue(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Guards an unknown labels record: extracts only the known keys, validates
 * templateKey against the allowlist, and rejects arbitrary extra keys including
 * prototype-pollution attempts. Returns a safe plain object or undefined. */
function buildSafeLabels(labels?: {
  templateKey?: string;
}): Record<string, string> | undefined {
  if (labels === undefined) return undefined;
  if (typeof labels !== 'object' || labels === null) return undefined;
  const result: Record<string, string> = {};
  if (labels.templateKey !== undefined) {
    const key = labels.templateKey;
    if (
      ALLOWED_TEMPLATE_KEYS.has(key as (typeof RECEIPT_TEMPLATE_KEYS)[number])
    ) {
      result.templateKey = safeLabelValue(key);
    }
    // Unknown templateKey values are silently dropped — no metric with them.
  }
  // Always return a clean object; never spread unknown keys.
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Lazily-created counters keyed by event name. */
type CounterMap = Map<ReceiptTelemetryEvent, Counter<string>>;

@Injectable()
export class PrometheusReceiptTelemetry {
  private readonly registry: Registry;
  private readonly counters: CounterMap = new Map();
  private readonly configGauge: Gauge<string>;
  private readonly metricsFlag: boolean;

  /** Constructor: creates an isolated per-instance Registry and the config gauge.
   * Each adapter instance owns its own Registry — no shared state between instances.
   * @param metricsFlag   Controls whether record() emits counters. Independent
   *                      of receipt-media admission/enabled flag.
   */
  constructor(metricsFlag: boolean) {
    this.metricsFlag = metricsFlag;
    this.registry = new Registry();

    this.configGauge = new Gauge({
      name: METRICS_GAUGE_NAME,
      help: 'Whether receipt-media metrics collection is enabled (1) or disabled (0). This reflects the metrics flag only, not ingestion or TX2 health.',
      registers: [this.registry],
    });
    this.configGauge.set(metricsFlag ? 1 : 0);
  }

  /**
   * Records a TX2 event as a Prometheus counter increment.
   *
   * Behavior:
   * - If metricsFlag is false: no-op, no counter is created.
   * - Unknown event names: safely ignored, no metric emitted.
   * - Unknown templateKey labels: safely dropped.
   * - record() failures (e.g. closed registry) are swallowed silently.
   * - All label extraction and counter work is inside the best-effort boundary;
   *   no error escapes to the business flow.
   * - Never emits PII, IDs, URLs, tokens, filenames, captions, or error text.
   */
  record(
    event: ReceiptTelemetryEvent,
    labels?: { templateKey?: string },
  ): void {
    if (!this.metricsFlag) return;
    if (!ALLOWED_EVENTS.has(event)) return;

    // All counter work (including label extraction) is inside the best-effort
    // boundary so no label-getter or counter error escapes to the caller.
    try {
      const safeLabels = buildSafeLabels(labels);
      const counter = this.getOrCreateCounter(event);
      if (safeLabels) {
        counter.inc(safeLabels);
      } else {
        counter.inc();
      }
    } catch {
      // Fail silently: business flow must never be disrupted.
    }
  }

  /** Returns the current Registry metrics as Prometheus text format.
   * Propagates errors to the caller for HTTP-level handling (e.g. 503).
   */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /** Returns the Registry contentType for the text format. */
  contentType(): string {
    return this.registry.contentType;
  }

  private getOrCreateCounter(event: ReceiptTelemetryEvent): Counter<string> {
    let counter = this.counters.get(event);
    if (counter !== undefined) return counter;
    counter = new Counter({
      name: `${event}_total`,
      help: `TX2 event: ${event}`,
      labelNames: ['templateKey'] as const,
      registers: [this.registry],
    });
    this.counters.set(event, counter);
    return counter;
  }
}
