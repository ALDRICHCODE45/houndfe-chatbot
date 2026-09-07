/** WU5A1 neutral private object-storage port (ADR-3/ADR-7): no AWS types in
 *  domain; keys and errors stay safe. The canonical `receipts/<uuid-v4>` key
 *  is random non-PII, reserved by the caller before upload and reused on safe
 *  retries. WU5A2a maps real caller aborts to fixed ABORTED and every generic
 *  failure to one fixed permanent code. WU5A2b adds the structured-field
 *  upload taxonomy (HTTP 408/429/5xx retryable; other HTTP, malformed, and
 *  unclassified permanent; allowlisted network/timeout names), deterministic
 *  `retryable`/`cleanupPending` flags, and fixed CLEANUP_PENDING (get/head/
 *  delete are WU5B). */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ReceiptMimeType } from './receipt-media.types';

const OBJECT_KEY_PATTERN =
  /^receipts\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Random non-PII canonical key; reserved once by the caller. */
export const newObjectKey = (): string => `receipts/${randomUUID()}`;

export const isCanonicalObjectKey = (key: string): boolean =>
  OBJECT_KEY_PATTERN.test(key);

export const OBJECT_STORAGE_PORT: unique symbol = Symbol('OBJECT_STORAGE_PORT');

export interface PutObjectInput {
  key: string;
  content: Readable;
  byteCount: number;
  mimeType: ReceiptMimeType;
  sha256: Buffer;
  abortSignal: AbortSignal;
  cleanupSignal: AbortSignal;
}

export interface ObjectStoragePort {
  put(
    input: PutObjectInput,
  ): Promise<{ etag: string; versionId: string | null }>;
  /** WU5B1a2: private streaming GetObject; fixed nonretryable
   *  OBJECT_NOT_FOUND for exact structured `$metadata.httpStatusCode===404`. */
  getStream(input: GetObjectInput): Promise<GetObjectResult>;
  /** WU5B1b: private metadata HeadObject; same safe result/taxonomy
   *  mapping as `getStream` without any body surface. */
  head(input: HeadObjectInput): Promise<HeadObjectResult>;
}

/** WU5B1a1: neutral private-read input/result shapes. WU5B1a2 integrates
 *  the port-level `getStream` (adapter + 404 mapping). */
export interface GetObjectInput {
  key: string;
  abortSignal: AbortSignal;
}

export interface GetObjectResult {
  stream: Readable;
  byteCount: number;
  mimeType: ReceiptMimeType;
  etag: string;
  versionId: string | null;
}

/** WU5B1b: neutral private metadata-read input/result shapes; identical
 *  safe metadata fields as `GetObjectResult` minus the stream. */
export interface HeadObjectInput {
  key: string;
  abortSignal: AbortSignal;
}

export interface HeadObjectResult {
  byteCount: number;
  mimeType: ReceiptMimeType;
  etag: string;
  versionId: string | null;
}

export type ObjectStorageErrorCode =
  | 'OBJECT_KEY_INVALID'
  | 'REQUEST_INVALID'
  | 'RESPONSE_INVALID'
  | 'ABORTED'
  | 'HTTP_RETRYABLE'
  | 'HTTP_PERMANENT'
  | 'NETWORK_FAILURE'
  | 'CLEANUP_PENDING'
  | 'PERMANENT_FAILURE'
  | 'OBJECT_NOT_FOUND';

const RETRYABLE_CODES: ReadonlySet<ObjectStorageErrorCode> = new Set([
  'ABORTED',
  'HTTP_RETRYABLE',
  'NETWORK_FAILURE',
  'CLEANUP_PENDING',
]);

/** Safe projection: fixed category/code plus deterministic retry/cleanup
 *  flags only; no raw cause, stack, provider message, or metadata. */
export class ObjectStorageError extends Error {
  readonly retryable: boolean;
  readonly cleanupPending: boolean;

  constructor(
    readonly category: 'OBJECT_STORAGE',
    readonly code: ObjectStorageErrorCode,
  ) {
    super(`receipt-media:${category}/${code}`);
    this.retryable = RETRYABLE_CODES.has(code);
    this.cleanupPending = code === 'CLEANUP_PENDING';
  }
}
