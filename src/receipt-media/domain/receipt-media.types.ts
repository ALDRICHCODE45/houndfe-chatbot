/**
 * Durable receipt-media projections (WU2A1).
 *
 * These types mirror exactly what `migrations/2000000000000_receipt_media.js`
 * persists. They deliberately exclude captions, URLs, raw capability tokens,
 * response bodies, and diagnostic PII: errors are kept as safe category/code
 * pairs and the capability token is stored only as its SHA-256 hash.
 */

export const RECEIPT_MAX_BYTES = 10_485_760;
export const RECEIPT_SHA256_BYTES = 32;

export const RECEIPT_MEDIA_STATUSES = [
  'RESERVED',
  'DOWNLOADED',
  'STORED',
  'AWAITING_AMOUNT',
  'AWAITING_CONFIRMATION',
  'ATTACHING',
  'ATTACHED',
  'FAILED',
  'CANCELLED',
  'ATTACH_OUTCOME_UNKNOWN',
] as const;
export type ReceiptMediaStatus = (typeof RECEIPT_MEDIA_STATUSES)[number];

export const RECEIPT_FAILURE_STAGES = [
  'MEDIA_VALIDATION_PRE_STORAGE',
  'META_EXHAUSTED_PRE_STORAGE',
  'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
  'ATTACH_DEFINITE',
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
  'RECEIPT_AMOUNT_PROMPT',
  'RECEIPT_AMOUNT_CONFIRM',
  'RECEIPT_AMOUNT_REASK',
  'RECEIPT_CANCELLED',
  'RECEIPT_ATTACHED_PENDING',
  'RECEIPT_ATTACH_DEFINITE_FAILURE',
  'RECEIPT_ATTACH_UNKNOWN',
  'RECEIPT_UNAVAILABLE_LATER',
  'RECEIPT_IN_PROGRESS',
  'RECEIPT_FINISH_OR_CANCEL',
  'RECEIPT_PLACE_SALE_FIRST',
  'RECEIPT_UNSUPPORTED_FORMAT',
  'RECEIPT_RECEIPTS_ONLY',
] as const;
export type ReceiptTemplateKey = (typeof RECEIPT_TEMPLATE_KEYS)[number];

export type ReceiptMimeType = 'image/jpeg' | 'image/png';
export type ReceiptBackendReceiptStatus = 'PENDING';

/** Durable `receipt_media` row (snake_case columns projected to camelCase). */
export interface ReceiptMediaRow {
  id: string;
  webhookMessageId: string;
  providerMediaId: string;
  senderId: string;
  capturedSaleId: string;
  /** Opaque `receipts/<uuid>` storage key; contains no sender/PII data. */
  objectKey: string;
  status: ReceiptMediaStatus;
  version: string; // bigint via pg arrives as string
  createdAt: Date;
  updatedAt: Date;
  reservedAt: Date;
  downloadedAt: Date | null;
  storedAt: Date | null;
  amountProposedAt: Date | null;
  attachStartedAt: Date | null;
  attachRequestStartedAt: Date | null;
  attachedAt: Date | null;
  terminalAt: Date | null;
  declaredMimeType: ReceiptMimeType | null;
  responseMimeType: ReceiptMimeType | null;
  detectedMimeType: ReceiptMimeType | null;
  providerDeclaredBytes: number | null;
  byteCount: number | null;
  contentSha256: Buffer | null;
  objectEtag: string | null;
  objectVersionId: string | null;
  /** SHA-256 of the capability token; the token itself is never stored. */
  capabilityTokenHash: Buffer | null;
  capabilityKeyVersion: number | null;
  capabilityIssuedAt: Date | null;
  capabilityRevokedAt: Date | null;
  declaredAmountCents: number | null;
  backendReceiptId: string | null;
  backendReceiptStatus: ReceiptBackendReceiptStatus | null;
  attachAttemptId: string | null;
  attachAttempts: number;
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
  cleanupPending: boolean;
  cleanupAttempts: number;
  reconciliationDisposition: ReceiptReconciliationDisposition | null;
  reconciledBackendReceiptId: string | null;
  reconciledAt: Date | null;
  reconciledBy: string | null;
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
  /** Bounded arguments: integer cents and backend status only. */
  templateArgs: Record<string, number | ReceiptBackendReceiptStatus>;
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
