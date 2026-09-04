/** WU5A1 neutral private object-storage port (ADR-3/ADR-7): no AWS types in
 *  domain; keys and errors stay safe. The canonical `receipts/<uuid-v4>` key
 *  is random non-PII, reserved by the caller before upload and reused on safe
 *  retries. WU5A2a maps real caller aborts to fixed ABORTED and every generic
 *  failure to one fixed permanent code (detailed taxonomy/cleanup: WU5A2b);
 *  get/head/delete are WU5B. */
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
  cleanupSignal?: AbortSignal;
}

export interface ObjectStoragePort {
  put(
    input: PutObjectInput,
  ): Promise<{ etag: string; versionId: string | null }>;
}

export type ObjectStorageErrorCode =
  | 'OBJECT_KEY_INVALID'
  | 'REQUEST_INVALID'
  | 'RESPONSE_INVALID'
  | 'ABORTED'
  | 'PERMANENT_FAILURE';

/** Safe projection: fixed category/code only; no raw cause retained. */
export class ObjectStorageError extends Error {
  constructor(
    readonly category: 'OBJECT_STORAGE',
    readonly code: ObjectStorageErrorCode,
  ) {
    super(`receipt-media:${category}/${code}`);
  }
}
