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
  sha256: Buffer;
}
export interface MetaMediaPort {
  resolveAndDownload(input: MetaMediaRequest): Promise<ValidatedMediaFile>;
}

export type MetaMediaErrorCategory = 'MEDIA_VALIDATION' | 'META_TRANSPORT';
export type MetaMediaErrorCode =
  | 'UNSUPPORTED_MIME'
  | 'PNG_STRUCTURE_INVALID'
  | 'JPEG_STRUCTURE_INVALID'
  | 'NETWORK_FAILURE'
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
