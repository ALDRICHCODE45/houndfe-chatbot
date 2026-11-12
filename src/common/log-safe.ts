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
/** A fingerprint produced by `fingerprintMessageId`; it must survive every
 *  phone rule below even when its 8 hex chars happen to be all digits. */
const FINGERPRINT_TOKEN = /(wamid#[0-9a-f]{8})/;
const WA_REF = /wa:\S*/g;
const PLUS_PHONE = /\+\d[\d\s().-]{6,}\d/g;
const LONG_DIGITS = /\d{8,}/g;
// Digit groups (optionally parenthesised) joined by ONE space, dot or dash.
// A valid ISO date is its own alternative so it is consumed (and kept) alone
// instead of being glued to neighbouring numbers ("2026-11-12 10 items").
const ISO_DATE = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?!\\d)';
const SEPARATED_NUMBER = new RegExp(
  `${ISO_DATE}|\\(?\\d{1,8}\\)?(?:[ .-]\\(?\\d{1,8}\\)?)+`,
  'g',
);
const MIN_PHONE_DIGITS = 10;

/** 10+ digits split by single separators ("52 155 5000 1111",
 *  "(55) 5000.1111") is a phone; prices ("1,250.00"), dates and times are
 *  shorter or use other separators and stay. */
const maskSeparatedNumber = (candidate: string): string => {
  if (new RegExp(`^${ISO_DATE}$`).test(candidate)) return candidate;
  const digits = candidate.replace(/\D/g, '').length;
  return digits >= MIN_PHONE_DIGITS ? '[number]' : candidate;
};

const maskPhones = (segment: string): string =>
  segment
    .replace(WA_REF, '[ref]')
    .replace(PLUS_PHONE, '[number]')
    .replace(SEPARATED_NUMBER, maskSeparatedNumber)
    .replace(LONG_DIGITS, '[number]');

/** Strips what could carry a phone out of free error text (wamids → their
 *  fingerprint, `wa:` refs, `+` formatted numbers, numbers with separators
 *  of 10+ digits, digit runs of 8+), collapses whitespace to keep one error
 *  on one line and truncates. Fingerprints are split out first so the digit
 *  rules never rewrite them. */
export function sanitizeErrorText(text: string): string {
  const cleaned = text
    .replace(WAMID_IN_TEXT, (id) => fingerprintMessageId(id))
    .split(FINGERPRINT_TOKEN)
    // Odd indexes are the captured fingerprints: keep them verbatim.
    .map((part, index) => (index % 2 === 1 ? part : maskPhones(part)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_ERROR_TEXT
    ? `${cleaned.slice(0, MAX_ERROR_TEXT)}…`
    : cleaned;
}

/** Drop-in for `error instanceof Error ? error.message : String(error)` in a
 *  log line: `Name: sanitized message` for Errors, a sanitized string for
 *  strings, a sanitized `String(value)` for anything else (`unknown error`
 *  when stringifying throws). */
export function describeError(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${sanitizeErrorText(error.message)}`;
  if (typeof error === 'string') return sanitizeErrorText(error);
  try {
    return sanitizeErrorText(String(error));
  } catch {
    return 'unknown error';
  }
}
