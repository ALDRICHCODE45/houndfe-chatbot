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
 *  WU5B1a2 getStream: one private GetObject via the verified safe-read
 *  boundary (genuine-signal guard + listener before send, exactly
 *  `{Bucket, Key}`, own-DATA-descriptor-only fail-closed extraction, verified
 *  assembler, caller-abort-wins, exact structured 404 → fixed nonretryable
 *  OBJECT_NOT_FOUND, existing taxonomy otherwise). No ACL/public URL/pipe/
 *  buffering/compensation/raw retention. HeadObject/delete are later WU5B. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { types as utilTypes } from 'node:util';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  isCanonicalObjectKey,
  ObjectStorageError,
  type GetObjectInput,
  type GetObjectResult,
  type ObjectStorageErrorCode,
  type ObjectStoragePort,
  type PutObjectInput,
} from '../domain/object-storage.port';
import {
  RECEIPT_MAX_BYTES,
  RECEIPT_SHA256_BYTES,
  type ReceiptMimeType,
} from '../domain/receipt-media.types';
import {
  guardObjectReadBody,
  guardObjectReadSignal,
} from './safe-object-read-guards';
import { assembleSafeObjectReadResult } from './safe-object-read-result';

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

/** WU5B1a2: exact structured 404 only; malformed fields fall through to the
 *  existing taxonomy; messages/stacks/causes never read. */
const isStructuredNotFound = (err: unknown): boolean => {
  const meta = read(err, '$metadata');
  if (meta === ABSENT || meta === INVALID) return false;
  return read(meta, 'httpStatusCode') === 404;
};

/** Captured non-invoking native descriptor/prototype reads for fail-closed
 *  GetObject response-field extraction; `NonNullObject` mirrors the
 *  guards-module alias (prototype links are genuinely shapeless). */
type NonNullObject = object;
const NATIVE_GET_OWN_DESCRIPTOR: typeof Object.getOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;
const NATIVE_GET_PROTOTYPE_OF: (target: NonNullObject) => NonNullObject | null =
  Object.getPrototypeOf;

const RESPONSE_FIELD_KEYS: readonly string[] = [
  'Body',
  'ContentLength',
  'ContentType',
  'ETag',
  'VersionId',
];

/** Normalized invalid sentinel for accessor-descriptor fields; the
 *  assembler's exact validators reject it. */
const UNUSABLE = Symbol('unusable');

/** Chain-wide proxy rejection before any property access (trap-count 0). */
const proxyFreeChain = (value: NonNullObject): boolean => {
  let link: object | null = value;
  while (link !== null) {
    if (utilTypes.isProxy(link)) return false;
    link = NATIVE_GET_PROTOTYPE_OF(link);
  }
  return true;
};

type ExtractedResponse =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; body: unknown };

/** Fail-closed extraction of raw response fields: own DATA descriptors
 *  only, one read per field, no getter invocation, no prototype fields, no
 *  coercion; absent → undefined, accessor/unsafe → UNUSABLE; on failure the
 *  already-extracted body (if guardable) is returned for destruction; the
 *  raw response is never retained. */
const extractResponseFields = (response: unknown): ExtractedResponse => {
  let body: unknown;
  try {
    if (typeof response !== 'object' || response === null)
      return { ok: false, body };
    if (!proxyFreeChain(response)) return { ok: false, body };
    const fields: Record<string, unknown> = {};
    for (const key of RESPONSE_FIELD_KEYS) {
      const desc = NATIVE_GET_OWN_DESCRIPTOR(response, key);
      if (desc === undefined) {
        fields[key] = undefined;
        continue;
      }
      if (desc.get !== undefined || desc.set !== undefined) {
        fields[key] = UNUSABLE;
        continue;
      }
      fields[key] = desc.value;
      if (key === 'Body') body = desc.value;
    }
    return { ok: true, fields };
  } catch {
    return { ok: false, body };
  }
};

export class S3ObjectStorageAdapter implements ObjectStoragePort {
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

  /** WU5B1a2: one private streaming GetObject — signal/key validated and
   *  listener registered before send, exactly `{Bucket, Key}`, fail-closed
   *  extraction + verified assembler, caller abort wins, exact structured
   *  404 → OBJECT_NOT_FOUND, taxonomy otherwise; never the provider Body. */
  async getStream(input: GetObjectInput): Promise<GetObjectResult> {
    const signal = guardObjectReadSignal(input.abortSignal);
    if (!signal) throw safe('REQUEST_INVALID');
    if (signal.aborted) throw safe('ABORTED');
    if (!isCanonicalObjectKey(input.key)) throw safe('OBJECT_KEY_INVALID');
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
    };
    if (!signal.addAbortListener(onCallerAbort)) throw safe('REQUEST_INVALID');
    try {
      let response: unknown;
      try {
        response = await this.client.send(
          new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
          { abortSignal: signal.signal },
        );
      } catch (err) {
        if (callerAborted) throw safe('ABORTED');
        if (isStructuredNotFound(err)) throw safe('OBJECT_NOT_FOUND');
        throw classifyProvider(err);
      }
      if (callerAborted) throw safe('ABORTED');
      const extracted = extractResponseFields(response);
      if (!extracted.ok) {
        const guarded = guardObjectReadBody(extracted.body);
        if (guarded) guarded.destroy();
        throw safe('RESPONSE_INVALID');
      }
      const assembled = assembleSafeObjectReadResult({
        body: extracted.fields.Body,
        byteCount: extracted.fields.ContentLength,
        mimeType: extracted.fields.ContentType,
        etag: extracted.fields.ETag,
        versionId: extracted.fields.VersionId,
        abortSignal: input.abortSignal,
      });
      if (!assembled.ok) throw safe(assembled.reason);
      return assembled.value;
    } finally {
      signal.removeAbortListener(onCallerAbort);
    }
  }
}
