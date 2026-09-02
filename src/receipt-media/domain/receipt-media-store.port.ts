/** WU2B1 store port (RM1, RM3): reservation and outbox primitives only; domain
 * conflicts are returned as values, never thrown. Claim, lease, CAS, and
 * attempt-start primitives arrive with WU2B2. */
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
  ReceiptTemplateKey,
} from './receipt-media.types';

export type ReservationOutcome =
  | { kind: 'created'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-replayed'; receipt: ReceiptMediaRow }
  | { kind: 'provider-media-reused'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-media-conflict' }
  | { kind: 'sender-active' };

export interface ReserveInput {
  id: string;
  webhookMessageId: string;
  providerMediaId: string;
  senderId: string;
  capturedSaleId: string;
  objectKey: string;
  declaredMimeType?: string;
}

export interface OutboxIntentInput {
  dedupeKey: string;
  receiptMediaId?: string | null;
  receiptStateVersion?: string | null;
  sourceWebhookMessageId: string;
  recipientId: string;
  templateKey: ReceiptTemplateKey;
  templateArgs?: Record<string, number | 'PENDING'>;
}

export type DedupeOutcome = { created: boolean; intent: ReceiptMediaOutboxRow };

export interface ReceiptMediaStorePort {
  reserve(input: ReserveInput): Promise<ReservationOutcome>;
  insertOutboxIntent(input: OutboxIntentInput): Promise<DedupeOutcome>;
}
