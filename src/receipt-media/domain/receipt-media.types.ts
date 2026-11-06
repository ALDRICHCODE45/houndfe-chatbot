/**
 * Durable receipt-media projections (WU2A1).
 *
 * These types mirror what the receipt_media migrations persist (2000 through
 * 3500: the backend stores the file, R3). They deliberately exclude captions,
 * URLs, response bodies, and diagnostic PII: errors are kept as safe
 * category/code pairs.
 */

export const RECEIPT_MAX_BYTES = 10_485_760;
export const RECEIPT_SHA256_BYTES = 32;

export const RECEIPT_MEDIA_STATUSES = [
  'RESERVED',
  'DOWNLOADED',
  'ATTACHED',
  'FAILED',
  'ATTACH_OUTCOME_UNKNOWN',
] as const;
export type ReceiptMediaStatus = (typeof RECEIPT_MEDIA_STATUSES)[number];

export const RECEIPT_FAILURE_STAGES = [
  'MEDIA_VALIDATION_PRE_STORAGE',
  'META_EXHAUSTED_PRE_STORAGE',
  'ATTACH_DEFINITE',
  /** R2: the extraction says the image is not a payment receipt. */
  'NOT_A_RECEIPT',
  /** R2/S8: a password-protected PDF is never uploaded. */
  'PDF_ENCRYPTED',
] as const;
export type ReceiptFailureStage = (typeof RECEIPT_FAILURE_STAGES)[number];

export const RECEIPT_RECONCILIATION_DISPOSITIONS = [
  'BACKEND_CONFIRMED',
  'BACKEND_NOT_FOUND',
  'UNRESOLVED',
] as const;
export type ReceiptReconciliationDisposition =
  (typeof RECEIPT_RECONCILIATION_DISPOSITIONS)[number];

export const RECEIPT_OUTBOX_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
] as const;
export type ReceiptOutboxStatus = (typeof RECEIPT_OUTBOX_STATUSES)[number];

/** Fixed deterministic Spanish notification intents; never free text. */
export const RECEIPT_TEMPLATE_KEYS = [
  'RECEIPT_ATTACHED_PENDING',
  'RECEIPT_ATTACH_DEFINITE_FAILURE',
  'RECEIPT_ATTACH_UNKNOWN',
  'RECEIPT_UNAVAILABLE_LATER',
  'RECEIPT_UNSUPPORTED_FORMAT',
  'RECEIPT_SALE_ALREADY_PAID',
  'RECEIPT_SALE_NOT_PAYABLE',
  'RECEIPT_PDF_ENCRYPTED',
  'RECEIPT_NOT_A_RECEIPT',
  /** R5/S5: the human outcome relayed to the customer. */
  'RECEIPT_PAYMENT_CONFIRMED',
  'RECEIPT_PAYMENT_PARTIAL',
  'RECEIPT_PAYMENT_REJECTED',
] as const;
export type ReceiptTemplateKey = (typeof RECEIPT_TEMPLATE_KEYS)[number];

export type ReceiptMimeType = 'image/jpeg' | 'image/png' | 'application/pdf';
export type ReceiptBackendReceiptStatus = 'PENDING';

/** Durable `receipt_media` row (snake_case columns projected to camelCase). */
export interface ReceiptMediaRow {
  id: string;
  webhookMessageId: string;
  providerMediaId: string;
  senderId: string;
  capturedSaleId: string;
  status: ReceiptMediaStatus;
  version: string; // bigint via pg arrives as string
  createdAt: Date;
  updatedAt: Date;
  reservedAt: Date;
  downloadedAt: Date | null;
  attachStartedAt: Date | null;
  attachedAt: Date | null;
  terminalAt: Date | null;
  declaredMimeType: ReceiptMimeType | null;
  responseMimeType: ReceiptMimeType | null;
  detectedMimeType: ReceiptMimeType | null;
  providerDeclaredBytes: number | null;
  byteCount: number | null;
  contentSha256: Buffer | null;
  declaredAmountCents: number | null;
  backendReceiptId: string | null;
  backendReceiptStatus: ReceiptBackendReceiptStatus | null;
  metaAttempts: number;
  storageAttempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  failureStage: ReceiptFailureStage | null;
  lastErrorCategory: string | null;
  lastErrorCode: string | null;
  attachHttpStatus: number | null;
  attachTransportCode: string | null;
  attachOutcomeObservedAt: Date | null;
  reconciliationDisposition: ReceiptReconciliationDisposition | null;
  reconciledBackendReceiptId: string | null;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  /** R5: the order folio captured at upload, for the outcome texts. */
  saleFolio: string | null;
  /** R5: the human outcome, recorded once with its notification. */
  outcomeStatus: 'CONFIRMED' | 'REJECTED' | null;
  outcomeReason: string | null;
  outcomeDebtCents: string | null; // bigint via pg arrives as string
  outcomeObservedAt: Date | null;
  outcomePolledAt: Date | null;
  outcomeNotifiedAt: Date | null;
  outcomeDelivery: 'QUEUED' | 'OUTSIDE_WINDOW' | null;
}

/** Durable `receipt_media_outbox` row: committed deterministic intents only. */
export interface ReceiptMediaOutboxRow {
  id: string;
  dedupeKey: string;
  receiptMediaId: string | null;
  receiptStateVersion: string | null;
  sourceWebhookMessageId: string;
  recipientId: string;
  templateKey: ReceiptTemplateKey;
  /** Bounded arguments: integer cents, the order folio, backend status. */
  templateArgs: Record<string, number | string>;
  status: ReceiptOutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  providerMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}
