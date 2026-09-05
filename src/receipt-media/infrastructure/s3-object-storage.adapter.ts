/** WU5A1 AWS SDK v3 S3-compatible adapter (ADR-3/ADR-7): one private one-shot
 *  PutObject with the exact key/ContentType/ContentLength, base64
 *  ChecksumSHA256, the caller's exact AbortSignal, streamed count/SHA-256
 *  verification, and same-key DeleteObject compensation for any post-start
 *  failure. No ACL, no public URL, no multipart, no logging, no raw causes.
 *  WU5A2a mapping: real caller aborts stay ABORTED. WU5A2b structured-field
 *  taxonomy (HTTP 408/429/5xx → HTTP_RETRYABLE; other valid HTTP 100–599 →
 *  HTTP_PERMANENT; out-of-range/malformed status → PERMANENT; allowlisted
 *  network/timeout names → NETWORK_FAILURE;
 *  present-but-invalid `$metadata` → PERMANENT with fail-closed reads that
 *  never leak a throwing accessor; cleanup failure/abort → CLEANUP_PENDING).
 *  WU5A2b-R1b/R1c signal boundary: only genuine AbortSignal instances pass;
 *  forged duck-typed methods, shifting getters, stateful `aborted` accessors,
 *  and proxies around genuine signals fail REQUEST_INVALID before any side
 *  effect; proxies around genuine signals fail the fail-closed
 *  `util.types.isProxy` brand gate, and `aborted`/listener add/remove use
 *  prototype-captured native operations so no attacker-shadowed signal
 *  property is ever dynamically read or invoked. `aborted` is read once;
 *  listener add/remove is fail-closed.
 *  WU5B: get/head/delete. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { types as utilTypes } from 'node:util';
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

/** Structured fields only; messages/stacks are never read, parsed, or
 *  retained. Reads are fail-closed: throwing accessors never leak, and
 *  present-but-invalid `$metadata` is fixed permanent (no fall-through). */
const HTTP_RETRYABLE_STATUS = new Set([408, 429]);
const NETWORK_NAMES: ReadonlySet<string> = new Set([
  'NetworkingError',
  'TimeoutError',
  'SocketTimeoutError',
  'AbortError',
  'RequestAbortedError',
]);
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
]);

const fields = (err: unknown): Record<string, unknown> | null =>
  typeof err === 'object' && err !== null
    ? (err as Record<string, unknown>)
    : null;

const ABSENT = Symbol('absent');
const INVALID = Symbol('invalid');

/** Structured read outcome: absent, invalid (throwing/malformed), or the
 *  defined non-nullish provider value; `undefined` never crosses here. */
type FieldRead = typeof ABSENT | typeof INVALID | null | NonNullable<unknown>;

const read = (err: unknown, key: string): FieldRead => {
  const f = fields(err);
  if (!f) return ABSENT;
  try {
    if (!(key in f)) return ABSENT;
    const v = f[key];
    return v === undefined ? INVALID : v;
  } catch {
    return INVALID;
  }
};

/** Valid HTTP status is exactly an integer in 100–599; anything else is
 *  present-but-malformed metadata (fixed permanent, never allowlist
 *  fall-through). */
const isStatus = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599;

/** Fail-closed AbortSignal boundary (WU5A2b-R1b/R1c): only genuine platform
 *  AbortSignal instances are trusted. Duck-typed lookalikes — forged
 *  callable-looking methods that throw, method getters whose value changes
 *  after validation, delayed/stateful `aborted` accessors, proxies, and
 *  prototype spoofs — all fail closed to REQUEST_INVALID before any upload
 *  side effect. Proxies around genuine signals are rejected by the
 *  fail-closed `util.types.isProxy` brand gate, checked before any property
 *  access (including `instanceof`, so proxy `getPrototypeOf` traps cannot
 *  run). The captured native `aborted` getter and EventTarget calls bypass
 *  attacker-shadowed instance properties, but they do not by themselves
 *  reject proxies — the `isProxy` gate is the proxy rejection. `aborted`
 *  and listener add/remove go through the
 *  captured native AbortSignal getter and EventTarget methods invoked with
 *  the validated signal as receiver, so no attacker-shadowed or spoofed
 *  signal property is ever dynamically read or invoked. `aborted` is read
 *  exactly once; later abort detection relies only on our own guarded abort
 *  listener. Listener add is fail-closed and removal is swallowed so
 *  finally teardown can never override a safe projection. */
interface GuardedSignal {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  onAbort(listener: () => void): boolean;
  offAbort(listener: () => void): void;
}

/** Prototype-captured native brand operations (WU5A2b-R1c): the genuine
 *  `aborted` getter and EventTarget listener methods are captured once and
 * invoked with the validated signal as receiver, so attacker-shadowed
 *  instance properties are never dynamically read or invoked. Proxy
 *  receivers are rejected earlier by the fail-closed `util.types.isProxy`
 *  brand gate, checked before any property access; these captured native
 *  operations bypass attacker-shadowed instance properties but do not by
 *  themselves reject proxies. */
const NATIVE_ABORTED_GETTER: ((this: AbortSignal) => boolean) | undefined =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated signal receiver
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const NATIVE_ADD_LISTENER: (
  this: EventTarget,
  type: string,
  listener: () => void,
  options?: { once: boolean },
) => void =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated signal receiver
  EventTarget.prototype.addEventListener;
const NATIVE_REMOVE_LISTENER: (
  this: EventTarget,
  type: string,
  listener: () => void,
) => void =
  // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional detach; always invoked with the validated signal receiver
  EventTarget.prototype.removeEventListener;

const guardSignal = (v: unknown): GuardedSignal | null => {
  try {
    if (utilTypes.isProxy(v) || !(v instanceof AbortSignal)) return null;
    if (typeof NATIVE_ABORTED_GETTER !== 'function') return null;
    const aborted = NATIVE_ABORTED_GETTER.call(v);
    if (typeof aborted !== 'boolean') return null;
    return {
      signal: v,
      aborted,
      onAbort: (listener) => {
        try {
          NATIVE_ADD_LISTENER.call(v, 'abort', listener, { once: true });
          return true;
        } catch {
          return false;
        }
      },
      offAbort: (listener) => {
        try {
          NATIVE_REMOVE_LISTENER.call(v, 'abort', listener);
        } catch {
          /* fail-closed: teardown must never override a safe projection */
        }
      },
    };
  } catch {
    return null;
  }
};

const classifyProvider = (err: unknown): ObjectStorageError => {
  const meta = read(err, '$metadata');
  if (meta !== ABSENT) {
    const status = read(meta, 'httpStatusCode');
    if (isStatus(status))
      return HTTP_RETRYABLE_STATUS.has(status) ||
        (status >= 500 && status <= 599)
        ? safe('HTTP_RETRYABLE')
        : safe('HTTP_PERMANENT');
    return safe('PERMANENT_FAILURE');
  }
  const name = read(err, 'name');
  const code = read(err, 'code');
  if (
    (typeof name === 'string' && NETWORK_NAMES.has(name)) ||
    (typeof code === 'string' && NETWORK_CODES.has(code))
  )
    return safe('NETWORK_FAILURE');
  return safe('PERMANENT_FAILURE');
};

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
    const upload = guardSignal(input.abortSignal);
    if (!upload) throw safe('REQUEST_INVALID');
    if (upload.aborted) throw safe('ABORTED');
    if (!isCanonicalObjectKey(input.key)) throw safe('OBJECT_KEY_INVALID');
    const invalid =
      !MIME_TYPES.includes(input.mimeType) ||
      !Number.isInteger(input.byteCount) ||
      input.byteCount < 1 ||
      input.byteCount > RECEIPT_MAX_BYTES ||
      input.sha256.length !== RECEIPT_SHA256_BYTES;
    if (invalid) throw safe('REQUEST_INVALID');
    const cleanup = guardSignal(input.cleanupSignal);
    if (!cleanup || cleanup.aborted || cleanup.signal === upload.signal)
      throw safe('REQUEST_INVALID');
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
    let callerAborted = false;
    const destroyBody = () => counter.destroy(new Error('failed'));
    const onCallerAbort = () => {
      callerAborted = true;
      destroyBody();
    };
    if (!upload.onAbort(onCallerAbort)) throw safe('REQUEST_INVALID');
    let cleanupAborted = false;
    const onCleanupAbort = () => {
      cleanupAborted = true;
    };
    if (!cleanup.onAbort(onCleanupAbort)) {
      upload.offAbort(onCallerAbort);
      throw safe('REQUEST_INVALID');
    }
    const body = Object.assign(counter, { source: input.content });
    input.content.once('error', destroyBody);
    const settled = pipeline(input.content, counter).catch(() => {});
    const classify = (err: unknown): ObjectStorageError =>
      err instanceof StreamViolation
        ? safe('PERMANENT_FAILURE')
        : callerAborted
          ? safe('ABORTED')
          : classifyProvider(err);
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
          { abortSignal: upload.signal },
        );
        if (callerAborted) failure = safe('ABORTED');
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
        let pending: boolean = cleanupAborted;
        if (!pending) {
          try {
            await this.client.send(
              new DeleteObjectCommand({
                Bucket: this.config.bucket,
                Key: input.key,
              }),
              { abortSignal: cleanup.signal },
            );
            if (cleanupAborted) pending = true;
          } catch {
            pending = true;
          }
        }
        throw pending ? safe('CLEANUP_PENDING') : failure;
      }
      return { etag: etag as string, versionId };
    } finally {
      upload.offAbort(onCallerAbort);
      cleanup.offAbort(onCleanupAbort);
      input.content.removeListener('error', destroyBody);
      counter.destroy();
      await settled;
    }
  }
}
