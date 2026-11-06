/** R2 ingestion processor: downloads the WhatsApp media through the
 * MetaMediaPort (origin policy + structure validator), reads it with the
 * vision pre-fill (R4), and uploads it to the backend (S2) in the same pass.
 *
 * RESERVED pass: fenced Meta attempt → download → commitDownload →
 * (encrypted PDF or not a receipt → refused without upload) → upload attempt.
 * DOWNLOADED pass: a same-key retry of an unknown upload outcome; the file is
 * downloaded again under the upload attempt fence (`storage_attempts`), so a
 * failed re-download is one more unknown attempt, never a Meta exhaustion.
 * The lease (60 s) is renewed while the extraction and the upload (up to
 * 90 s for a PDF) run. The bot never confirms or rejects a payment (S1). */
import { promises as fs } from 'node:fs';
import type { ConversationState } from '../../conversation/domain/conversation-store';
import {
  MetaMediaError,
  type MetaMediaPort,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import { readPlacedOrder, type PlacedOrder } from '../domain/placed-order';
import type {
  ReceiptExtraction,
  ReceiptExtractionPort,
} from '../domain/receipt-extraction.port';
import {
  MAX_UPLOAD_ATTEMPTS,
  type LeaseFenceInput,
  type MetaTerminalFailureStage,
  type ReceiptMediaStorePort,
  type UploadCommitOutcome,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import { isEncryptedPdf } from '../infrastructure/media-structure.validator';
import type {
  ReceiptAttachmentService,
  UploadReport,
} from './receipt-attachment.service';

export type ReceiptIngestionOutcome =
  | { kind: 'aborted'; stage: 'meta' }
  | { kind: 'blocked'; stage: 'meta' | 'upload' }
  | { kind: 'fence-lost'; stage: 'download' }
  | { kind: 'meta-retry-scheduled'; attempt: number; code: string }
  | {
      kind: 'meta-terminal';
      failureStage: MetaTerminalFailureStage;
      code: string;
    }
  | { kind: 'meta-fenced'; code: string }
  | {
      kind: 'rejected';
      reason: 'NOT_A_RECEIPT' | 'PDF_ENCRYPTED';
      outcome: UploadCommitOutcome;
    }
  | { kind: 'upload'; report: UploadReport }
  | { kind: 'upload-unknown'; outcome: UploadCommitOutcome }
  | { kind: 'cleanup-failed' }
  | { kind: 'unsupported-claimed-status'; status: string };

/** Narrow conversation seam: the placed order (folio, total) of the sale. */
export interface ReceiptIngestionConversations {
  get(senderId: string): Promise<ConversationState | null>;
}

export interface ReceiptIngestionOptions {
  /** Lease renewal period while the extraction and the upload run. */
  heartbeatMs?: number;
  readFile?: (path: string) => Promise<Buffer>;
}

type IngestionStore = Pick<
  ReceiptMediaStorePort,
  | 'startMetaAttempt'
  | 'startStorageAttempt'
  | 'commitDownload'
  | 'commitMetaFailureDisposition'
  | 'commitUploadUnknown'
  | 'commitRejectedMedia'
  | 'renewLease'
>;

const PROCESSABLE: ReadonlySet<string> = new Set(['RESERVED', 'DOWNLOADED']);
const DEFAULT_HEARTBEAT_MS = 20_000;

export class ReceiptIngestionProcessor {
  private readonly heartbeatMs: number;
  private readonly readFile: (path: string) => Promise<Buffer>;

  constructor(
    private readonly meta: MetaMediaPort,
    private readonly store: IngestionStore,
    private readonly extraction: ReceiptExtractionPort,
    private readonly attachment: Pick<ReceiptAttachmentService, 'upload'>,
    private readonly conversations: ReceiptIngestionConversations,
    options: ReceiptIngestionOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.readFile = options.readFile ?? ((path) => fs.readFile(path));
  }

  async process(
    receipt: ReceiptMediaRow,
    owner: string,
    signal?: AbortSignal,
  ): Promise<ReceiptIngestionOutcome> {
    const abort = signal ?? new AbortController().signal;
    if (!PROCESSABLE.has(receipt.status) || receipt.declaredMimeType === null)
      return { kind: 'unsupported-claimed-status', status: receipt.status };
    const fence = { id: receipt.id, owner, expectedVersion: receipt.version };
    return receipt.status === 'RESERVED'
      ? this.firstPass(receipt, fence, abort)
      : this.retryPass(receipt, fence, abort);
  }

  private async firstPass(
    receipt: ReceiptMediaRow,
    fence: LeaseFenceInput,
    signal: AbortSignal,
  ): Promise<ReceiptIngestionOutcome> {
    if (signal.aborted) return { kind: 'aborted', stage: 'meta' };
    if (receipt.metaAttempts >= 3)
      return this.metaFailure(
        fence,
        new MetaMediaError('META_TRANSPORT', 'HTTP_RETRYABLE'),
        'META_EXHAUSTED',
      );
    const start = await this.store.startMetaAttempt({ ...fence });
    if (start === null) return { kind: 'blocked', stage: 'meta' };
    fence.expectedVersion = start.version;
    let file: ValidatedMediaFile;
    try {
      file = await this.download(receipt, signal);
    } catch (err) {
      if (!(err instanceof MetaMediaError)) throw err;
      return this.metaFailure(fence, err);
    }
    return this.withFile(file, async () => {
      const moved = await this.store.commitDownload({
        ...fence,
        responseMimeType: file.mimeType,
        detectedMimeType: file.mimeType,
        byteCount: file.byteCount,
        contentSha256: file.sha256,
      });
      if (moved.kind === 'fenced')
        return { kind: 'fence-lost', stage: 'download' };
      // The download commit bumps the version by exactly one.
      fence.expectedVersion = String(BigInt(fence.expectedVersion) + 1n);
      return this.withHeartbeat(fence, async () => {
        const bytes = await this.readFile(file.filePath);
        if (file.mimeType === 'application/pdf' && isEncryptedPdf(bytes))
          return this.reject(fence, 'PDF_ENCRYPTED');
        const order = await this.orderOf(receipt);
        const extraction = await this.extract(bytes, file, order);
        if (extraction.kind === 'not_receipt')
          return this.reject(fence, 'NOT_A_RECEIPT');
        const attempt = await this.store.startStorageAttempt({ ...fence });
        if (attempt === null) return { kind: 'blocked', stage: 'upload' };
        fence.expectedVersion = attempt.version;
        return this.upload(
          receipt,
          fence,
          file,
          bytes,
          extraction,
          order,
          signal,
        );
      });
    });
  }

  /** Same-key retry of an unknown upload outcome. */
  private async retryPass(
    receipt: ReceiptMediaRow,
    fence: LeaseFenceInput,
    signal: AbortSignal,
  ): Promise<ReceiptIngestionOutcome> {
    if (receipt.storageAttempts >= MAX_UPLOAD_ATTEMPTS)
      // A reclaimed last attempt whose outcome was never recorded.
      return {
        kind: 'upload-unknown',
        outcome: await this.store.commitUploadUnknown({
          ...fence,
          httpStatus: null,
          transportCode: 'TRANSPORT_FAILURE',
        }),
      };
    const attempt = await this.store.startStorageAttempt({ ...fence });
    if (attempt === null) return { kind: 'blocked', stage: 'upload' };
    fence.expectedVersion = attempt.version;
    return this.withHeartbeat(fence, async () => {
      let file: ValidatedMediaFile;
      try {
        file = await this.download(receipt, signal);
      } catch (err) {
        if (!(err instanceof MetaMediaError)) throw err;
        return {
          kind: 'upload-unknown',
          outcome: await this.store.commitUploadUnknown({
            ...fence,
            httpStatus: null,
            transportCode: `META_${err.code}`,
          }),
        };
      }
      return this.withFile(file, async () => {
        const bytes = await this.readFile(file.filePath);
        const order = await this.orderOf(receipt);
        const extraction = await this.extract(bytes, file, order);
        // The first pass already decided to submit this file.
        const submitted: ReceiptExtraction =
          extraction.kind === 'not_receipt'
            ? { kind: 'unavailable', reason: 'error' }
            : extraction;
        return this.upload(
          receipt,
          fence,
          file,
          bytes,
          submitted,
          order,
          signal,
        );
      });
    });
  }

  private download(
    receipt: ReceiptMediaRow,
    signal: AbortSignal,
  ): Promise<ValidatedMediaFile> {
    return this.meta.resolveAndDownload({
      providerMediaId: receipt.providerMediaId,
      declaredMimeType: receipt.declaredMimeType!,
      signal,
    });
  }

  private async upload(
    receipt: ReceiptMediaRow,
    fence: LeaseFenceInput,
    file: ValidatedMediaFile,
    bytes: Buffer,
    extraction: ReceiptExtraction,
    order: PlacedOrder | null,
    signal: AbortSignal,
  ): Promise<ReceiptIngestionOutcome> {
    const report = await this.attachment.upload({
      receipt,
      fence: { ...fence },
      file: { bytes, mimeType: file.mimeType },
      extraction,
      order,
      signal,
    });
    return { kind: 'upload', report };
  }

  private async reject(
    fence: LeaseFenceInput,
    reason: 'NOT_A_RECEIPT' | 'PDF_ENCRYPTED',
  ): Promise<ReceiptIngestionOutcome> {
    return {
      kind: 'rejected',
      reason,
      outcome: await this.store.commitRejectedMedia({ ...fence, reason }),
    };
  }

  /** The vision pre-fill never decides (S1) and never throws. */
  private extract(
    bytes: Buffer,
    file: ValidatedMediaFile,
    order: PlacedOrder | null,
  ): Promise<ReceiptExtraction> {
    return this.extraction.extract({
      bytes,
      mimeType: file.mimeType,
      expectedAmountCents: order?.totalCents ?? null,
    });
  }

  /** The placed order only when it is still the receipt's sale. */
  private async orderOf(receipt: ReceiptMediaRow): Promise<PlacedOrder | null> {
    const order = readPlacedOrder(
      await this.conversations.get(receipt.senderId),
    );
    return order?.saleId === receipt.capturedSaleId ? order : null;
  }

  private async metaFailure(
    fence: LeaseFenceInput,
    err: MetaMediaError,
    code: string = err.code,
  ): Promise<ReceiptIngestionOutcome> {
    const disposition = await this.store.commitMetaFailureDisposition({
      ...fence,
      category: code === 'META_EXHAUSTED' ? 'META_TRANSPORT' : err.category,
      code: code as MetaMediaError['code'] | 'META_EXHAUSTED',
    });
    if (code === 'ABORTED') return { kind: 'aborted', stage: 'meta' };
    if (disposition.kind === 'terminal' || disposition.kind === 'replayed')
      return {
        kind: 'meta-terminal',
        failureStage: disposition.failureStage,
        code,
      };
    if (disposition.kind === 'retry-scheduled')
      return {
        kind: 'meta-retry-scheduled',
        attempt: disposition.attempt,
        code,
      };
    return { kind: 'meta-fenced', code };
  }

  /** Runs `work`, then always removes the temp file; a failed removal is
   * reported after the durable outcome is committed. */
  private async withFile(
    file: ValidatedMediaFile,
    work: () => Promise<ReceiptIngestionOutcome>,
  ): Promise<ReceiptIngestionOutcome> {
    let outcome: ReceiptIngestionOutcome;
    try {
      outcome = await work();
    } finally {
      try {
        await file.cleanup();
      } catch {
        // eslint-disable-next-line no-unsafe-finally
        return { kind: 'cleanup-failed' };
      }
    }
    return outcome;
  }

  /** Keeps the lease alive under the CURRENT fence version. */
  private async withHeartbeat<T>(
    fence: LeaseFenceInput,
    work: () => Promise<T>,
  ): Promise<T> {
    const timer = setInterval(() => {
      this.store.renewLease({ ...fence }).catch(() => false);
    }, this.heartbeatMs);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }
}
