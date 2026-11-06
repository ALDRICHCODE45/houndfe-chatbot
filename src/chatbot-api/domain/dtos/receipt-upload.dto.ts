/** Multipart transfer-receipt upload (docs/contracts/transfer-receipts.md):
 *  `POST /chatbot-api/sales/:saleId/receipts`, scope `sales:write`. */

/** A PDF upload can take about 60 s on the backend (preview rendering). */
export const RECEIPT_UPLOAD_TIMEOUT_MS = 90_000;

/** `X-Idempotency-Key` bound: the WhatsApp media id, 1–200 chars. */
export const RECEIPT_UPLOAD_KEY_MAX_LENGTH = 200;

/** Every `body.error` code of the upload contract. */
export const RECEIPT_UPLOAD_ERROR = {
  INVALID_IDEMPOTENCY_KEY: 'INVALID_IDEMPOTENCY_KEY',
  FILE_REQUIRED: 'RECEIPT_FILE_REQUIRED',
  INVALID_FIELDS: 'INVALID_RECEIPT_FIELDS',
  INVALID_EXTRACTED: 'INVALID_RECEIPT_EXTRACTED',
  SALE_NOT_FOUND: 'SALE_NOT_FOUND',
  SALE_NOT_PAYABLE: 'SALE_NOT_PAYABLE',
  SALE_ALREADY_PAID: 'SALE_ALREADY_PAID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  FILE_TOO_LARGE: 'RECEIPT_FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED: 'RECEIPT_FILE_TYPE_NOT_ALLOWED',
  STORAGE_FAILED: 'RECEIPT_STORAGE_FAILED',
} as const;
export type ReceiptUploadErrorCode =
  (typeof RECEIPT_UPLOAD_ERROR)[keyof typeof RECEIPT_UPLOAD_ERROR];

export type ReceiptUploadMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'application/pdf';

export interface ReceiptUploadFile {
  bytes: Buffer;
  mimeType: ReceiptUploadMimeType;
  filename: string;
}

/** What the customer stated (caption), kept apart from the extraction (S4). */
export interface ReceiptUploadDeclared {
  amountCents?: number;
  date?: string;
  reference?: string;
}

/** Vision pre-fill; `confidence` is 0..1. Never a payment decision (S1). */
export interface ReceiptUploadExtracted {
  amountCents?: number;
  date?: string;
  reference?: string;
  bank?: string;
  confidence?: number;
}

export interface ReceiptUploadFields {
  declared?: ReceiptUploadDeclared;
  extracted?: ReceiptUploadExtracted;
}

export interface ReceiptUploadResponse {
  receiptId: string;
  status: 'PENDING';
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  previewStatus: 'READY' | 'UNAVAILABLE';
}

export function isReceiptUploadResponse(
  body: unknown,
): body is ReceiptUploadResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.receiptId === 'string' &&
    b.receiptId.length > 0 &&
    b.status === 'PENDING' &&
    typeof b.mimeType === 'string' &&
    Number.isSafeInteger(b.sizeBytes) &&
    (b.sizeBytes as number) >= 0 &&
    typeof b.sha256 === 'string' &&
    b.sha256.length > 0 &&
    (b.previewStatus === 'READY' || b.previewStatus === 'UNAVAILABLE')
  );
}

/** Multipart body: optional parts are omitted, never sent empty. */
export function toReceiptUploadForm(
  file: ReceiptUploadFile,
  fields: ReceiptUploadFields,
): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
    file.filename,
  );
  const { declared, extracted } = fields;
  if (declared?.amountCents !== undefined)
    form.append('declaredAmountCents', String(declared.amountCents));
  if (declared?.date !== undefined) form.append('declaredDate', declared.date);
  if (declared?.reference !== undefined)
    form.append('declaredReference', declared.reference);
  if (extracted !== undefined && Object.keys(extracted).length > 0)
    form.append('extracted', JSON.stringify(extracted));
  return form;
}
