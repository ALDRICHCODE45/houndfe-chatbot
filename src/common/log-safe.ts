import { createHash } from 'node:crypto';

/**
 * Log-safety helpers (mirror-hardening S3): the customer phone must never
 * reach a log line. Two leaks existed besides the conversation ref (which
 * `maskConversationRef` already covers):
 *
 *  - WhatsApp message ids. `wamid.<base64>` encodes a protobuf-like blob
 *    that embeds the sender's wa_id as ASCII digits (`wamid.HBgM…` decodes to
 *    0x1c 0x18 <len> + the phone), so a raw wamid in a log IS the phone.
 *  - Raw error text from Meta or the backend, which may quote the recipient.
 *
 * Both helpers only shape log TEXT; never use them on persisted values or on
 * anything sent to Meta or the backend.
 */

const MAX_ERROR_TEXT = 200;

/** `wamid.HBgM…` → `wamid#1a2b3c4d`: a stable, non-reversible correlation tag
 *  (first 8 hex of sha256) that is enough to find the same message across
 *  log lines without exposing the embedded wa_id. */
export function fingerprintMessageId(id: string | null | undefined): string {
  if (typeof id !== 'string' || id.length === 0) return 'wamid#(none)';
  return `wamid#${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

const WAMID_IN_TEXT = /wamid\.[A-Za-z0-9+/=_-]+/g;
const WA_REF = /wa:\S*/g;
const PLUS_PHONE = /\+\d[\d\s().-]{6,}\d/g;
const LONG_DIGITS = /\d{8,}/g;

/** Strips what could carry a phone out of free error text (wamids → their
 *  fingerprint, `wa:` refs, `+` formatted numbers, digit runs of 8+),
 *  collapses whitespace to keep one error on one line and truncates. */
export function sanitizeErrorText(text: string): string {
  const cleaned = text
    .replace(WAMID_IN_TEXT, (id) => fingerprintMessageId(id))
    .replace(WA_REF, '[ref]')
    .replace(PLUS_PHONE, '[number]')
    .replace(LONG_DIGITS, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_ERROR_TEXT
    ? `${cleaned.slice(0, MAX_ERROR_TEXT)}…`
    : cleaned;
}

/** Drop-in for `error instanceof Error ? error.message : String(error)` in a
 *  log line: `Name: sanitized message` for Errors, a sanitized string for
 *  strings, `unknown error` for anything else. */
export function describeError(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${sanitizeErrorText(error.message)}`;
  if (typeof error === 'string') return sanitizeErrorText(error);
  return 'unknown error';
}
