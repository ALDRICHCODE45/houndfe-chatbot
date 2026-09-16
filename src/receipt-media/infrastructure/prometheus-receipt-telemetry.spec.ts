/** WU15-2 behavior spec: Prometheus telemetry adapter for ReceiptTelemetryPort.
 *
 * Runtime regression coverage; historical RED/GREEN evidence and its
 * limitations are recorded separately in the WU15 task tracker.
 *
 * Scope: isolated per-instance Registry, three fixed TX2 events, finite
 * runtime-validated event/template allowlists, safe label spreading,
 * flag-gated no-op, no business flow escape, no arbitrary PII/URL/token/
 * filename/caption/error in labels, time series created only after record()
 * call, truly independent registries (no shared state), and global
 * registry unchanged.
 */
import {
  PrometheusReceiptTelemetry,
  RECEIPT_TELEMETRY,
} from './prometheus-receipt-telemetry';
import { register, type Registry } from 'prom-client';

describe('PrometheusReceiptTelemetry (behavior spec)', () => {
  afterEach(() => jest.restoreAllMocks());
  describe('module-level exports', () => {
    it('exports PrometheusReceiptTelemetry as a function constructor', () => {
      expect(typeof PrometheusReceiptTelemetry).toBe('function');
    });

    it('exports RECEIPT_TELEMETRY as a symbol', () => {
      expect(typeof RECEIPT_TELEMETRY).toBe('symbol');
    });
  });

  describe('construction and registry isolation', () => {
    it('creates an instance without throwing', () => {
      const instance = new PrometheusReceiptTelemetry(false);
      expect(instance).toBeDefined();
    });

    it('each instance has its own isolated Registry', () => {
      const a = new PrometheusReceiptTelemetry(false);
      const b = new PrometheusReceiptTelemetry(false);
      const regA = (a as unknown as { registry: Registry }).registry;
      const regB = (b as unknown as { registry: Registry }).registry;
      expect(regA).not.toBe(regB);
    });

    it('records no TX2 metric until record() is called even when enabled', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      const registry = (instance as unknown as { registry: Registry }).registry;
      const metricsBefore = await registry.metrics();
      expect(metricsBefore).toContain('receipt_media_metrics_enabled');
      expect(metricsBefore).not.toContain('receipt_outbox_tx2');
    });

    it('does not use or mutate the global prom-client default registry', () => {
      const before = register.getMetricsAsArray();
      const instance = new PrometheusReceiptTelemetry(true);
      instance.record('receipt_outbox_tx2_committed');
      const registry = (instance as unknown as { registry: Registry }).registry;
      expect(registry).not.toBe(register);
      expect(register.getMetricsAsArray()).toEqual(before);
    });

    it('two adapters never share increments — independent Registry state', async () => {
      // Each adapter owns its own Registry and counters. Incrementing on one
      // adapter never affects another adapter's counters.
      const a = new PrometheusReceiptTelemetry(true);
      const b = new PrometheusReceiptTelemetry(true);
      a.record('receipt_outbox_tx2_committed');
      a.record('receipt_outbox_tx2_committed');
      b.record('receipt_outbox_tx2_committed');
      const regA = (a as unknown as { registry: Registry }).registry;
      const regB = (b as unknown as { registry: Registry }).registry;
      const metricsA = await regA.metrics();
      const metricsB = await regB.metrics();
      const linesA = metricsA.split('\n');
      const linesB = metricsB.split('\n');
      const committedA = linesA.find((l) =>
        l.startsWith('receipt_outbox_tx2_committed_total'),
      );
      const committedB = linesB.find((l) =>
        l.startsWith('receipt_outbox_tx2_committed_total'),
      );
      // Adapter A: 2, Adapter B: 1 — independent.
      expect(committedA).toMatch(/\b2\b/);
      expect(committedB).toMatch(/\b1\b/);
    });
  });

  describe('record() — flag gating', () => {
    it('record() is a no-op when metricsFlag is false', async () => {
      const instance = new PrometheusReceiptTelemetry(false);
      instance.record('receipt_outbox_tx2_committed');
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).not.toContain('receipt_outbox_tx2');
    });

    it('record() produces a metric when metricsFlag is true', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      instance.record('receipt_outbox_tx2_committed');
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).toContain('receipt_outbox_tx2_committed_total');
    });

    it('multiple record() calls accumulate counter values', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      instance.record('receipt_outbox_tx2_committed');
      instance.record('receipt_outbox_tx2_committed');
      instance.record('receipt_outbox_tx2_failed');
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).toContain('receipt_outbox_tx2_committed_total');
      expect(metrics).toContain('receipt_outbox_tx2_failed_total');
      const lines = metrics.split('\n');
      const committedLine = lines.find((l) =>
        l.startsWith('receipt_outbox_tx2_committed_total'),
      );
      const failedLine = lines.find((l) =>
        l.startsWith('receipt_outbox_tx2_failed_total'),
      );
      expect(committedLine).toMatch(/\b2\b/);
      expect(failedLine).toMatch(/\b1\b/);
    });
  });

  describe('record() — event allowlist', () => {
    it('records all three TX2 events when flag is true', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      const events = [
        'receipt_outbox_tx2_committed',
        'receipt_outbox_tx2_transition_lost',
        'receipt_outbox_tx2_failed',
      ] as const;
      for (const event of events) instance.record(event);
      const lines = (await instance.metrics()).split('\n');
      for (const event of events) expect(lines).toContain(`${event}_total 1`);
    });

    it('rejects an unknown event name silently when flag is true', async () => {
      const instance = new PrometheusReceiptTelemetry(true);

      (instance as unknown as { record: (event: string) => void }).record(
        'unknown_event_total',
      );
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).not.toContain('unknown_event_total');
    });

    it('ignores unknown event silently when flag is false', () => {
      const instance = new PrometheusReceiptTelemetry(false);
      expect(() =>
        (instance as unknown as { record: (event: string) => void }).record(
          'totally_unknown',
        ),
      ).not.toThrow();
    });
  });

  describe('record() — template label allowlist', () => {
    it('accepts a valid templateKey label', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      instance.record('receipt_outbox_tx2_committed', {
        templateKey: 'RECEIPT_AMOUNT_CONFIRM',
      });
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).toContain('templateKey="RECEIPT_AMOUNT_CONFIRM"');
    });

    it('rejects an unknown templateKey label silently', async () => {
      const instance = new PrometheusReceiptTelemetry(true);

      (
        instance as unknown as {
          record: (event: string, labels?: Record<string, unknown>) => void;
        }
      ).record('receipt_outbox_tx2_committed', {
        templateKey: 'NOT_A_REAL_KEY',
      });
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).not.toContain('NOT_A_REAL_KEY');
    });

    it('ignores arbitrary extra keys — no unsafe spreading', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      // Exercise extra runtime keys without spreading them into labels.
      (
        instance as unknown as {
          record: (event: string, labels?: unknown) => void;
        }
      ).record('receipt_outbox_tx2_committed', {
        templateKey: 'RECEIPT_AMOUNT_CONFIRM',
        __proto__: { admin: true },
        constructor: { prototype: { evil: 'injected' } },
      });
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).not.toContain('admin');
      expect(metrics).not.toContain('evil');
      expect(metrics).not.toContain('__proto__');
      expect(metrics).not.toContain('constructor');
    });
  });

  describe('record() — PII/sensitive-data safety', () => {
    it('does not emit supplied PII, credentials or arbitrary text as labels', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      const sensitive = {
        senderId: '+525500009999',
        saleId: 'synthetic-sale-id',
        url: 'https://example.invalid/private',
        token: 'svc_synthetic-secret',
        filename: 'private-receipt.png',
        caption: 'synthetic-private-caption',
        error: 'synthetic-private-error',
      };
      const labels = { templateKey: 'RECEIPT_AMOUNT_CONFIRM', ...sensitive };
      instance.record('receipt_outbox_tx2_committed', labels);
      instance.record('receipt_outbox_tx2_committed', {
        templateKey: sensitive.token,
      });
      const metrics = await instance.metrics();
      expect(metrics).toContain('templateKey="RECEIPT_AMOUNT_CONFIRM"');
      for (const value of Object.values(sensitive))
        expect(metrics).not.toContain(value);
    });
  });

  describe('record() — failure isolation', () => {
    it('counter registration failure never escapes to the caller', () => {
      const instance = new PrometheusReceiptTelemetry(true);
      const registry = (instance as unknown as { registry: Registry }).registry;
      const registration = jest
        .spyOn(registry, 'registerMetric')
        .mockImplementation(() => {
          throw new Error('synthetic-registration-error');
        });
      expect(() =>
        instance.record('receipt_outbox_tx2_committed'),
      ).not.toThrow();
      expect(registration).toHaveBeenCalledTimes(1);
    });

    it('a throwing template getter neither escapes nor logs or creates a counter', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const getter = jest.fn((): string => {
        throw new Error('synthetic-label-error');
      });
      const labels = {
        get templateKey(): string {
          return getter();
        },
      };
      expect(() =>
        instance.record('receipt_outbox_tx2_committed', labels),
      ).not.toThrow();
      expect(getter).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(await instance.metrics()).not.toContain('receipt_outbox_tx2');
    });
  });

  describe('metrics() — serialization', () => {
    it('returns Prometheus text format', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      instance.record('receipt_outbox_tx2_committed');
      const output = await instance.metrics();
      expect(typeof output).toBe('string');
      expect(output).toContain('receipt_outbox_tx2_committed_total');
    });

    it('metrics() propagates Registry errors to the caller', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      instance.record('receipt_outbox_tx2_committed');

      // Replace only the downstream registry operation, never the method under test.
      const registry = (instance as unknown as { registry: Registry }).registry;
      const serialize = jest
        .spyOn(registry, 'metrics')
        .mockRejectedValue(new Error('Registry unavailable'));
      await expect(instance.metrics()).rejects.toThrow('Registry unavailable');
      expect(serialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('configuration-state gauge', () => {
    it('exposes a receipt_media_metrics_enabled gauge', async () => {
      const instance = new PrometheusReceiptTelemetry(true);
      const metrics = await (
        instance as unknown as { registry: Registry }
      ).registry.metrics();
      expect(metrics).toContain('receipt_media_metrics_enabled');
      expect(metrics).not.toContain('receipt_media_admission_enabled');
    });

    it('the gauge reflects the constructor flag value', async () => {
      const enabled = new PrometheusReceiptTelemetry(true);
      const disabled = new PrometheusReceiptTelemetry(false);
      const metricsOn = await (
        enabled as unknown as { registry: Registry }
      ).registry.metrics();
      const metricsOff = await (
        disabled as unknown as { registry: Registry }
      ).registry.metrics();
      const gaugeLineOn = metricsOn
        .split('\n')
        .find((l) => l.startsWith('receipt_media_metrics_enabled'));
      const gaugeLineOff = metricsOff
        .split('\n')
        .find((l) => l.startsWith('receipt_media_metrics_enabled'));
      expect(gaugeLineOn).toMatch(/\b1\b/);
      expect(gaugeLineOff).toMatch(/\b0\b/);
    });
  });
});
