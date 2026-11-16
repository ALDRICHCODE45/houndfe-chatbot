/** Safe diagnostic side-channel for Meta media failures (S5). The reason is a
 *  fixed token (policy rejection kind or a raw errno-style code) kept OUT of
 *  the MetaMediaError itself, like the HTTP status: errors stay clean and the
 *  reason can never carry a URL, query, token or media id. */
import { MetaMediaError } from '../domain/meta-media.port';

export type MetaPolicyRejectionReason =
  | 'URL_INVALID'
  | 'SCHEME_NOT_HTTPS'
  | 'USERINFO_NOT_ALLOWED'
  | 'QUERY_NOT_ALLOWED'
  | 'FRAGMENT_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWED'
  | 'DNS_FAILED'
  | 'NON_PUBLIC_ADDRESS';

const REASON_OF = new WeakMap<MetaMediaError, string>();

/** Only a bare errno/Node-style token (ENETUNREACH, ECONNRESET,
 *  ERR_TLS_CERT_ALTNAME_INVALID, ...) is ever recorded from a raw error. */
const ERRNO_TOKEN = /^[A-Z][A-Z0-9_]{2,40}$/;

export function safeErrnoOf(error: unknown): string | undefined {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERRNO_TOKEN.test(code) ? code : undefined;
}

/** Records the safe reason on the error (first reason wins) and returns it. */
export function withMetaFailureReason(
  error: MetaMediaError,
  reason: string | undefined,
): MetaMediaError {
  if (reason !== undefined && !REASON_OF.has(error))
    REASON_OF.set(error, reason);
  return error;
}

export function metaFailureReasonOf(error: unknown): string | undefined {
  return error instanceof MetaMediaError ? REASON_OF.get(error) : undefined;
}
