/** WU5A1 AWS SDK v3 S3-compatible adapter (ADR-3/ADR-7): one private one-shot
 *  PutObject with the exact key/ContentType/ContentLength, base64
 *  ChecksumSHA256, and the caller's exact AbortSignal. No ACL, no public URL,
 *  no multipart, no logging, no raw causes. Failure mapping is WU5A2;
 *  get/head/delete are WU5B. */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  isCanonicalObjectKey,
  ObjectStorageError,
  type ObjectStorageErrorCode,
  type PutObjectInput,
} from '../domain/object-storage.port';
import {
  RECEIPT_MAX_BYTES,
  RECEIPT_SHA256_BYTES,
  type ReceiptMimeType,
} from '../domain/receipt-media.types';

const MIME_TYPES: readonly ReceiptMimeType[] = ['image/jpeg', 'image/png'];

export interface S3ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const safe = (code: ObjectStorageErrorCode) =>
  new ObjectStorageError('OBJECT_STORAGE', code);

export class S3ObjectStorageAdapter {
  private readonly client: Pick<S3Client, 'send'>;

  constructor(
    private readonly config: S3ObjectStorageConfig,
    client?: Pick<S3Client, 'send'>,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: config.forcePathStyle,
      });
  }

  async put(
    input: PutObjectInput,
  ): Promise<{ etag: string; versionId: string | null }> {
    if (!isCanonicalObjectKey(input.key)) throw safe('OBJECT_KEY_INVALID');
    const invalid =
      !MIME_TYPES.includes(input.mimeType) ||
      !Number.isInteger(input.byteCount) ||
      input.byteCount < 1 ||
      input.byteCount > RECEIPT_MAX_BYTES ||
      input.sha256.length !== RECEIPT_SHA256_BYTES;
    if (invalid) throw safe('REQUEST_INVALID');
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.content,
        ContentType: input.mimeType,
        ContentLength: input.byteCount,
        ChecksumSHA256: input.sha256.toString('base64'),
      }),
      { abortSignal: input.abortSignal },
    );
    const etag =
      typeof result.ETag === 'string' && result.ETag ? result.ETag : null;
    if (!etag) throw safe('RESPONSE_INVALID');
    return { etag, versionId: result.VersionId ?? null };
  }
}
