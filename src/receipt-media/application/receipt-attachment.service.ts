/** R2 backend upload (S2): the downloaded receipt file goes to the backend
 * as multipart with `X-Idempotency-Key` = the WhatsApp media id, and exactly
 * one durable outcome is committed per call. A definite refusal (4xx) is
 * terminal; any unknown outcome (timeout, network, 5xx, 401/403/429,
 * invalid 201) is retried later by the store with the same key. The bot
 * never confirms or rejects the payment (S1): the backend keeps the receipt
 * PENDING. */
import { Logger } from '@nestjs/common';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  destinationKeysOf,
  RECEIPT_DESTINATION_KEYS,
  RECEIPT_UPLOAD_ERROR,
  withoutDestinationFields,
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
import {
  computeAmountMismatch,
  type ReceiptExtraction,
  type ReceiptExtractionConfidence,
} from '../domain/receipt-extraction.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';

/** Backend statuses that prove the receipt was refused (no retry helps).
 * 429 (rate limit) and 401/403 (credential/config, fixable by an operator)
 * are unknown outcomes retried with the same key. */
const DEFINITE_STATUSES = new Set([400, 404, 409, 413, 415, 422]);
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
  /** The exact fields of the first attempt (`toUploadFields`), reused
   * byte-for-byte by every retry under the same idempotency key (an N18
   * destination fallback replaces them with the stripped ones). */
  fields: ReceiptUploadFields;
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

export interface ReceiptAttachmentOptions {
  /** `RECEIPT_DESTINATION_FIELDS_ENABLED` (N18 kill switch), default true:
   * false strips the destination/origin keys from every upload, retries
   * included. */
  destinationFieldsEnabled?: boolean;
}

type SendResult =
  | { ok: true; receiptId: string }
  | { ok: false; error: unknown };

export class ReceiptAttachmentService {
  private readonly logger = new Logger(ReceiptAttachmentService.name);
  private readonly destinationFieldsEnabled: boolean;

  constructor(
    private readonly store: UploadStore,
    private readonly client: Pick<ChatbotApiClient, 'uploadReceipt'>,
    options: ReceiptAttachmentOptions = {},
  ) {
    this.destinationFieldsEnabled = options.destinationFieldsEnabled ?? true;
  }

  async upload(invocation: UploadInvocation): Promise<UploadReport> {
    const { receipt, fence, order } = invocation;
    const folioArgs: UploadTemplateArgs =
      order?.folio == null ? {} : { folio: order.folio };
    let fields = this.destinationFieldsEnabled
      ? invocation.fields
      : withoutDestinationFields(invocation.fields);
    /** Set only by the N18 fallback: the fields later retries must send. */
    let replacedFields: ReceiptUploadFields | undefined;
    let result = await this.send(invocation, fields);
    const sentKeys = destinationKeysOf(fields);
    if (!result.ok && sentKeys.length > 0 && isInvalidExtracted(result.error)) {
      // Field names only: the values are customer data.
      this.logger.warn(
        `receipt ${receipt.id}: backend refused the destination fields (${RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED}, HTTP ${statusOf(result.error)}); retrying once without ${sentKeys.join(', ')}`,
      );
      fields = withoutDestinationFields(fields);
      replacedFields = fields;
      result = await this.send(invocation, fields);
    }
    if (!result.ok)
      return this.failure(result.error, invocation, folioArgs, replacedFields);
    const backendReceiptId = result.receiptId;
    const extractedAmountCents = fields.extracted?.amountCents ?? null;
    const totalCents = order?.totalCents ?? null;
    const mismatch =
      extractedAmountCents !== null &&
      totalCents !== null &&
      computeAmountMismatch(extractedAmountCents, totalCents)
        ? { extractedAmountCents, totalCents }
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

  /** One backend call under the receipt's idempotency key. */
  private async send(
    { receipt, file, signal }: UploadInvocation,
    fields: ReceiptUploadFields,
  ): Promise<SendResult> {
    try {
      const { receiptId } = await this.client.uploadReceipt(
        receipt.capturedSaleId,
        {
          bytes: file.bytes,
          mimeType: file.mimeType,
          filename: FILENAME[file.mimeType],
        },
        fields,
        receipt.providerMediaId,
        { signal },
      );
      return { ok: true, receiptId };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private async failure(
    error: unknown,
    { fence, signal }: UploadInvocation,
    folioArgs: UploadTemplateArgs,
    replacedFields: ReceiptUploadFields | undefined,
  ): Promise<UploadReport> {
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
        ...(replacedFields === undefined
          ? {}
          : { uploadFields: replacedFields }),
      }),
    };
  }
}

/** N18 fallback trigger: the backend refused the `extracted` part. */
const isInvalidExtracted = (error: unknown): boolean => {
  const status = statusOf(error);
  return (
    (status === 400 || status === 422) &&
    codeOf(error) === RECEIPT_UPLOAD_ERROR.INVALID_EXTRACTED
  );
};

/** Declared (caption) and extracted (vision) data travel apart (S4). */
export function toUploadFields(
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
    for (const key of RECEIPT_DESTINATION_KEYS) {
      const value = extraction[key];
      if (value !== null) extracted[key] = value;
    }
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
