import { ReceiptMediaError } from '../domain/receipt-media.errors';
import type { ReceiptErrorCode } from '../domain/receipt-media.errors';
import type { OutboxIntentInput } from '../domain/receipt-media-store.port';
import type { StatusCasInput } from '../domain/receipt-media-store.port';
import type { ReceiptTelemetryPort } from '../domain/receipt-telemetry.port';
import { RECEIPT_TEMPLATE_KEYS } from '../domain/receipt-media.types';
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';
import type { ReceiptTemplateKey } from '../domain/receipt-media.types';
const ARG: Partial<Record<ReceiptTemplateKey, string>> = {
  RECEIPT_AMOUNT_CONFIRM: 'amountCents',
  RECEIPT_ATTACHED_PENDING: 'backendStatus',
};
export type ReceiptTx2CommitResult =
  | { kind: 'committed'; created: boolean; intent: ReceiptMediaOutboxRow }
  | { kind: 'transition-lost' };
type Tx2Input = ReceiptTx2Request & { intent: OutboxIntentInput };
export interface ReceiptTx2CommitPort {
  commitTransitionWithIntent(input: Tx2Input): Promise<ReceiptTx2CommitResult>;
}
export interface ReceiptTx2Request {
  transition: StatusCasInput;
  sourceWebhookMessageId: string;
  recipientId: string;
  templateKey: ReceiptTemplateKey;
  templateArgs?: Record<string, number | 'PENDING'>;
}
export class ReceiptOutboxService {
  constructor(
    private readonly tx2: ReceiptTx2CommitPort,
    private readonly telemetry?: ReceiptTelemetryPort,
  ) {}
  private invalid(code: ReceiptErrorCode): never {
    throw new ReceiptMediaError('RECEIPT_OUTBOX_INVALID_INTENT', code);
  }
  renderIntent(request: ReceiptTx2Request): OutboxIntentInput {
    const { transition, templateKey, templateArgs = {} } = request;
    const { sourceWebhookMessageId: src, recipientId } = request;
    if (!RECEIPT_TEMPLATE_KEYS.includes(templateKey))
      this.invalid('TEMPLATE_KEY_UNKNOWN');
    const expected = ARG[templateKey];
    const value = expected && templateArgs[expected];
    const badArgs =
      Object.keys(templateArgs).length !== Number(Boolean(expected)) ||
      (expected === 'amountCents'
        ? typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
        : expected === 'backendStatus' && value !== 'PENDING');
    if (badArgs) this.invalid('TEMPLATE_ARGS_INVALID');
    if (!transition.id || !transition.expectedVersion || !src || !recipientId)
      this.invalid('IDENTITY_INVALID');
    return {
      dedupeKey: `receipt:${templateKey}:${src}:${transition.id}:${transition.expectedVersion}`,
      receiptMediaId: transition.id,
      receiptStateVersion: transition.expectedVersion,
      sourceWebhookMessageId: src,
      recipientId,
      templateKey,
      templateArgs,
    };
  }
  async commit(request: ReceiptTx2Request): Promise<ReceiptTx2CommitResult> {
    const intent = this.renderIntent(request);
    const label = { templateKey: request.templateKey };
    try {
      const result = await this.tx2.commitTransitionWithIntent({
        ...request,
        intent,
      });
      try {
        this.telemetry?.record(
          result.kind === 'committed'
            ? 'receipt_outbox_tx2_committed'
            : 'receipt_outbox_tx2_transition_lost',
          label,
        );
      } catch {
        // Telemetry is best-effort and cannot alter a committed TX2 outcome.
      }
      return result;
    } catch {
      try {
        this.telemetry?.record('receipt_outbox_tx2_failed', label);
      } catch {
        // Preserve the fixed safe TX2 error when telemetry is unavailable.
      }
      throw new ReceiptMediaError(
        'RECEIPT_OUTBOX_TX2_FAILED',
        'TX2_COMMIT_FAILED',
      );
    }
  }
}
