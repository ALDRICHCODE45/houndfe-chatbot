/** WU5B1a1: provider-neutral normalized-field assembler for safe private
 *  object reads (GetObject response foundation; adapter integration, 404
 *  mapping, HeadObject and delete are later WU5B work). INTERNAL TRUSTED
 *  BOUNDARY: `SafeObjectReadFields` must carry raw provider response fields
 *  already extracted fail-closed by the calling provider adapter; only `body`
 *  and `abortSignal` are re-guarded here through the verified genuine-signal /
 *  genuine-Readable guards (fail-closed, zero attacker property access on
 *  rejection). Metadata fields are exact validated primitives: integer
 *  byteCount 1..RECEIPT_MAX_BYTES, exact `image/jpeg|image/png`, nonempty etag
 *  string, nullish-or-nonempty versionId — no coercion, no trim-based
 *  acceptance, no raw retention, no public URL. An invalid body/signal or any
 *  invalid metadata destroys the guarded body without an error and collapses
 *  to RESPONSE_INVALID; a pre-aborted signal collapses to ABORTED. Stream
 *  setup is delegated to the verified lifecycle
 *  (`createSafeObjectReadStream`), which owns registration cleanup, async
 *  fixed errors, and backpressure; a setup ABORTED maps to ABORTED and every
 *  other setup failure to RESPONSE_INVALID. Success returns only the internal
 *  stream plus safe primitives — never the original body or any provider
 *  object. No object-storage SDK imports or names. */
import {
  guardObjectReadBody,
  guardObjectReadSignal,
} from './safe-object-read-guards';
import { createSafeObjectReadStream } from './safe-object-read-stream';
import {
  RECEIPT_MAX_BYTES,
  type ReceiptMimeType,
} from '../domain/receipt-media.types';
import type { GetObjectResult } from '../domain/object-storage.port';

export type SafeObjectReadFailureReason = 'ABORTED' | 'RESPONSE_INVALID';

export interface SafeObjectReadFields {
  /** Raw provider response body; guarded here, never returned. */
  readonly body: unknown;
  readonly byteCount: unknown;
  readonly mimeType: unknown;
  readonly etag: unknown;
  readonly versionId: unknown;
  readonly abortSignal: unknown;
}

export type SafeObjectReadResult =
  | { readonly ok: true; readonly value: GetObjectResult }
  | { readonly ok: false; readonly reason: SafeObjectReadFailureReason };

const RECEIPT_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

const validByteCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= RECEIPT_MAX_BYTES;
const validMimeType = (value: unknown): value is ReceiptMimeType =>
  typeof value === 'string' && RECEIPT_MIME_TYPES.includes(value);
const validEtag = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const validVersionId = (value: unknown): value is string | null =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.length > 0);

export function assembleSafeObjectReadResult(
  fields: SafeObjectReadFields,
): SafeObjectReadResult {
  const guardedBody = guardObjectReadBody(fields.body);
  if (guardedBody === null) return { ok: false, reason: 'RESPONSE_INVALID' };
  const destroy = () => {
    guardedBody.destroy();
  };
  const guardedSignal = guardObjectReadSignal(fields.abortSignal);
  if (guardedSignal === null) {
    destroy();
    return { ok: false, reason: 'RESPONSE_INVALID' };
  }
  if (guardedSignal.aborted) {
    destroy();
    return { ok: false, reason: 'ABORTED' };
  }
  if (
    !validByteCount(fields.byteCount) ||
    !validMimeType(fields.mimeType) ||
    !validEtag(fields.etag) ||
    !validVersionId(fields.versionId)
  ) {
    destroy();
    return { ok: false, reason: 'RESPONSE_INVALID' };
  }
  const stream = createSafeObjectReadStream(guardedBody, guardedSignal);
  if (!stream.ok)
    return {
      ok: false,
      reason: stream.reason === 'ABORTED' ? 'ABORTED' : 'RESPONSE_INVALID',
    };
  return {
    ok: true,
    value: {
      stream: stream.stream,
      byteCount: fields.byteCount,
      mimeType: fields.mimeType,
      etag: fields.etag,
      versionId: fields.versionId === undefined ? null : fields.versionId,
    },
  };
}
