/** R2 backend upload (S2): the downloaded receipt file goes to the backend
 * as multipart with `X-Idempotency-Key` = the WhatsApp media id, and exactly
 * one durable outcome is committed per call. A definite refusal (4xx) is
 * terminal; any unknown outcome (timeout, network, 5xx, invalid 201) is
 * retried later by the store with the same key. The bot never confirms or
 * rejects the payment (S1): the backend keeps the receipt PENDING. */
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  RECEIPT_UPLOAD_ERROR,
  type ReceiptUploadExtracted,
  type ReceiptUploadFields,
  type ReceiptUploadMimeType,
} from '../../chatbot-api/domain/dtos/receipt-upload.dto';
import type { PlacedOrder } from '../domain/placed-order';
import type {
  LeaseFenceInput,
  ReceiptMediaStorePort,
  UploadCommitOutcome,
  UploadDefiniteTemplateKey,
  UploadTemplateArgs,
} from '../domain/receipt-media-store.port';
import type {
  ReceiptExtraction,
  ReceiptExtractionConfidence,
} from '../domain/receipt-extraction.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';

/** Backend statuses that prove the receipt was refused (no retry helps). */
const DEFINITE_STATUSES = new Set([
  400, 401, 403, 404, 409, 413, 415, 422, 429,
]);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The backend `extracted.confidence` is 0..1. */
const CONFIDENCE: Record<ReceiptExtractionConfidence, number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

const FILENAME: Record<ReceiptUploadMimeType, string> = {
  'image/jpeg': 'receipt.jpg',
  'image/png': 'receipt.png',
  'application/pdf': 'receipt.pdf',
};

const DEFINITE_TEMPLATE: Partial<Record<string, UploadDefiniteTemplateKey>> = {
  [RECEIPT_UPLOAD_ERROR.SALE_ALREADY_PAID]: 'RECEIPT_SALE_ALREADY_PAID',
  [RECEIPT_UPLOAD_ERROR.SALE_NOT_PAYABLE]: 'RECEIPT_SALE_NOT_PAYABLE',
  [RECEIPT_UPLOAD_ERROR.FILE_TOO_LARGE]: 'RECEIPT_UNSUPPORTED_FORMAT',
  [RECEIPT_UPLOAD_ERROR.FILE_TYPE_NOT_ALLOWED]: 'RECEIPT_UNSUPPORTED_FORMAT',
};

export interface UploadInvocation {
  receipt: ReceiptMediaRow;
  /** Fence of the already-started upload attempt. */
  fence: LeaseFenceInput;
  file: { bytes: Buffer; mimeType: ReceiptUploadMimeType };
  extraction: ReceiptExtraction;
  /** The placed order bound to the receipt's sale, when still known. */
  order: PlacedOrder | null;
  signal?: AbortSignal;
}

export type UploadReport =
  | { kind: 'uploaded'; backendReceiptId: string; outcome: UploadCommitOutcome }
  | { kind: 'refused'; httpStatus: number; outcome: UploadCommitOutcome }
  | { kind: 'unknown'; outcome: UploadCommitOutcome };

type UploadStore = Pick<
  ReceiptMediaStorePort,
  'commitUploadSuccess' | 'commitUploadDefiniteFailure' | 'commitUploadUnknown'
>;

export class ReceiptAttachmentService {
  constructor(
    private readonly store: UploadStore,
    private readonly client: Pick<ChatbotApiClient, 'uploadReceipt'>,
  ) {}

  async upload(invocation: UploadInvocation): Promise<UploadReport> {
    const { receipt, fence, file, extraction, order, signal } = invocation;
    const folioArgs: UploadTemplateArgs =
      order?.folio == null ? {} : { folio: order.folio };
    let backendReceiptId: string;
    try {
      ({ receiptId: backendReceiptId } = await this.client.uploadReceipt(
        receipt.capturedSaleId,
        {
          bytes: file.bytes,
          mimeType: file.mimeType,
          filename: FILENAME[file.mimeType],
        },
        uploadFields(receipt, extraction),
        receipt.providerMediaId,
        { signal },
      ));
    } catch (error) {
      const status = statusOf(error);
      if (status !== null && DEFINITE_STATUSES.has(status)) {
        const errorCode = codeOf(error);
        return {
          kind: 'refused',
          httpStatus: status,
          outcome: await this.store.commitUploadDefiniteFailure({
            ...fence,
            httpStatus: status,
            errorCode,
            templateKey:
              (errorCode === null ? undefined : DEFINITE_TEMPLATE[errorCode]) ??
              'RECEIPT_ATTACH_DEFINITE_FAILURE',
            templateArgs: folioArgs,
          }),
        };
      }
      return {
        kind: 'unknown',
        outcome: await this.store.commitUploadUnknown({
          ...fence,
          ...unknownEvidence(status, signal),
        }),
      };
    }
    const mismatch =
      extraction.kind === 'receipt' &&
      extraction.amountMismatch &&
      extraction.amountCents !== null &&
      order?.totalCents != null
        ? {
            extractedAmountCents: extraction.amountCents,
            totalCents: order.totalCents,
          }
        : {};
    return {
      kind: 'uploaded',
      backendReceiptId,
      outcome: await this.store.commitUploadSuccess({
        ...fence,
        backendReceiptId,
        templateArgs: { ...folioArgs, ...mismatch },
      }),
    };
  }
}

/** Declared (caption) and extracted (vision) data travel apart (S4). */
function uploadFields(
  receipt: ReceiptMediaRow,
  extraction: ReceiptExtraction,
): ReceiptUploadFields {
  const fields: ReceiptUploadFields = {};
  if (receipt.declaredAmountCents !== null)
    fields.declared = { amountCents: receipt.declaredAmountCents };
  if (extraction.kind === 'receipt') {
    const extracted: ReceiptUploadExtracted = {
      confidence: CONFIDENCE[extraction.confidence],
    };
    if (extraction.amountCents !== null)
      extracted.amountCents = extraction.amountCents;
    if (extraction.date !== null) extracted.date = extraction.date;
    if (extraction.reference !== null)
      extracted.reference = extraction.reference;
    if (extraction.bank !== null) extracted.bank = extraction.bank;
    fields.extracted = extracted;
  }
  return fields;
}

const statusOf = (error: unknown): number | null => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
};

const codeOf = (error: unknown): string | null => {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : null;
};

/** Exactly one safe evidence channel for an unknown outcome. */
function unknownEvidence(
  status: number | null,
  signal: AbortSignal | undefined,
): { httpStatus: number | null; transportCode: string | null } {
  if (signal?.aborted === true)
    return { httpStatus: null, transportCode: 'ABORTED' };
  if (status !== null && status >= 200 && status <= 299)
    return { httpStatus: null, transportCode: 'RESPONSE_INVALID' };
  if (status !== null && status >= 100 && status <= 599)
    return { httpStatus: status, transportCode: null };
  return { httpStatus: null, transportCode: 'TRANSPORT_FAILURE' };
}
