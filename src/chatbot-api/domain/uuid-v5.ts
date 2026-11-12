import { createHash } from 'node:crypto';

/** RFC 4122 predefined namespaces. */
export const UUID_NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
export const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const NAMESPACE_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 UUIDv5 (SHA-1, name-based), lowercase. No dependency needed. */
export function uuidV5(name: string, namespace: string): string {
  if (!NAMESPACE_FORMAT.test(namespace))
    throw new TypeError('UUID namespace is not a valid UUID');
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Stable app namespace for media upload idempotency keys (never change it:
 *  a changed namespace re-uploads every file under a new key). */
export const MEDIA_IDEMPOTENCY_NAMESPACE = uuidV5(
  'houndfe-chatbot:media-idempotency',
  UUID_NAMESPACE_URL,
);

/**
 * `X-Idempotency-Key` for `POST /chatbot-api/media`: lowercase UUIDv5 of the
 * stable source (a Meta media id, or a product photo URL) plus an optional
 * version/etag, so a retry after a crash reuses the key and a photo that
 * changed under the same URL gets a new one.
 */
export function mediaIdempotencyKey(source: string, version?: string): string {
  if (source === '') throw new TypeError('Media source must not be empty');
  return uuidV5(
    version === undefined || version === ''
      ? source
      : `${source}\u0000${version}`,
    MEDIA_IDEMPOTENCY_NAMESPACE,
  );
}
