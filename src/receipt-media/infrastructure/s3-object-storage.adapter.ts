/** WU5A1 AWS SDK v3 S3-compatible adapter (ADR-3/ADR-7): one private one-shot
 *  PutObject with the exact key/ContentType/ContentLength, base64
 *  ChecksumSHA256, the caller's exact AbortSignal, streamed count/SHA-256
 *  verification, and same-key DeleteObject compensation for any post-start
 *  failure. No ACL, no public URL, no multipart, no logging, no raw causes.
 *  WU5A2a mapping: real caller aborts stay ABORTED; generic SDK/source/delete
 *  failures fail closed on one fixed permanent code; WU5A2b: detailed
 *  taxonomy/cleanup-pending; WU5B: get/head/delete. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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

class StreamViolation extends Error {}

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
    if (input.abortSignal?.aborted) throw safe('ABORTED');
    if (!isCanonicalObjectKey(input.key)) throw safe('OBJECT_KEY_INVALID');
    const invalid =
      !MIME_TYPES.includes(input.mimeType) ||
      !Number.isInteger(input.byteCount) ||
      input.byteCount < 1 ||
      input.byteCount > RECEIPT_MAX_BYTES ||
      input.sha256.length !== RECEIPT_SHA256_BYTES;
    if (invalid) throw safe('REQUEST_INVALID');
    const cleanup = input.cleanupSignal;
    if (!cleanup || cleanup.aborted || cleanup === input.abortSignal)
      throw safe('REQUEST_INVALID');
    if (!input.abortSignal) throw safe('REQUEST_INVALID');
    let bytes = 0;
    let digest: Buffer | null = null;
    const hasher = createHash('sha256');
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        bytes += chunk.length;
        if (bytes > input.byteCount) return cb(new StreamViolation());
        hasher.update(chunk);
        cb(null, chunk);
      },
      flush: (cb) => {
        if (bytes !== input.byteCount) return cb(new StreamViolation());
        digest = hasher.digest();
        cb();
      },
    });
    const body = Object.assign(counter, { source: input.content });
    const teardown = () => counter.destroy(new Error('failed'));
    input.abortSignal?.addEventListener('abort', teardown, { once: true });
    input.content.once('error', teardown);
    const settled = pipeline(input.content, counter).catch(() => {});
    const classify = (err: unknown): ObjectStorageError =>
      err instanceof StreamViolation || !input.abortSignal?.aborted
        ? safe('PERMANENT_FAILURE')
        : safe('ABORTED');
    try {
      let failure: ObjectStorageError | null = null;
      let etag: string | null = null;
      let versionId: string | null = null;
      try {
        const result = await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: input.key,
            Body: body,
            ContentType: input.mimeType,
            ContentLength: input.byteCount,
            ChecksumSHA256: input.sha256.toString('base64'),
          }),
          { abortSignal: input.abortSignal },
        );
        if (input.abortSignal?.aborted) failure = safe('ABORTED');
        else if (!digest || !timingSafeEqual(digest, input.sha256))
          failure = safe('PERMANENT_FAILURE');
        else {
          etag = typeof result.ETag === 'string' ? result.ETag : null;
          if (!etag) failure = safe('RESPONSE_INVALID');
          else versionId = result.VersionId ?? null;
        }
      } catch (err) {
        failure = classify(err);
      }
      if (failure) {
        if (!cleanup.aborted) {
          try {
            await this.client.send(
              new DeleteObjectCommand({
                Bucket: this.config.bucket,
                Key: input.key,
              }),
              { abortSignal: cleanup },
            );
          } catch {
            /* cleanup-pending taxonomy is WU5A2b; keep failing closed */
          }
        }
        throw failure;
      }
      return { etag: etag as string, versionId };
    } finally {
      input.abortSignal?.removeEventListener('abort', teardown);
      input.content.removeListener('error', teardown);
      counter.destroy();
      await settled;
    }
  }
}
