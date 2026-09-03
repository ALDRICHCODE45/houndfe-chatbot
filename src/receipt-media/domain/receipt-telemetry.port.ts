/** WU3 telemetry port: fixed events/labels only — never sender, sale, URL,
 * key, token, caption, or arbitrary error text. */
import type { ReceiptTemplateKey } from './receipt-media.types';

export type ReceiptTelemetryEvent =
  | 'receipt_outbox_tx2_committed'
  | 'receipt_outbox_tx2_transition_lost'
  | 'receipt_outbox_tx2_failed';

export interface ReceiptTelemetryPort {
  record(
    event: ReceiptTelemetryEvent,
    labels?: { templateKey?: ReceiptTemplateKey },
  ): void;
}
