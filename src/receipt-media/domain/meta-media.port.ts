/** Provider-neutral boundary: provider URLs and credentials stay in infrastructure. */
export const META_MEDIA = Symbol('META_MEDIA');
export type ReceiptMimeType = 'image/jpeg' | 'image/png';

export interface MetaMediaRequest {
  providerMediaId: string;
  declaredMimeType: ReceiptMimeType;
  signal: AbortSignal;
}
export interface ValidatedMediaFile {
  filePath: string;
  mimeType: ReceiptMimeType;
  byteCount: number;
  /** Provider-declared size from the metadata hop, before download-time validation. */
  providerDeclaredBytes: number;
  sha256: Buffer;
  /**
   * Caller-owned technical cleanup of the validated temp file.
   * Idempotent: after a successful return, repeating the call is a no-op.
   */
  cleanup(): Promise<void>;
}
export interface MetaMediaPort {
  resolveAndDownload(input: MetaMediaRequest): Promise<ValidatedMediaFile>;
}

export type MetaMediaErrorCategory = 'MEDIA_VALIDATION' | 'META_TRANSPORT';
export type MetaMediaErrorCode =
  | 'UNSUPPORTED_MIME'
  | 'INVALID_MEDIA_SIZE'
  | 'MIME_MISMATCH'
  | 'PNG_STRUCTURE_INVALID'
  | 'JPEG_STRUCTURE_INVALID'
  | 'FILE_IO_FAILURE'
  | 'NETWORK_FAILURE'
  | 'HTTP_RETRYABLE'
  | 'HTTP_PERMANENT'
  | 'TIMEOUT'
  | 'ABORTED';

/** Safe projection: callers cannot attach arbitrary diagnostics to the error. */
export class MetaMediaError extends Error {
  constructor(
    readonly category: MetaMediaErrorCategory,
    readonly code: MetaMediaErrorCode,
  ) {
    super(`receipt-media:${category}/${code}`);
  }
}
