import type { BackendOutboxEntry } from '../../backend-outbox/domain/backend-outbox';
import type {
  MirrorMessageInput,
  MirrorMessageType,
  MirrorUnsupportedKind,
} from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import {
  mirrorContractType,
  mirrorUnsupportedKind,
} from '../../conversation-transcript/application/transcript-recorder';
import type { MirrorMediaContractType } from '../domain/mirror-media';

/**
 * MESSAGE_MIRROR payload → contract `messages:batch` item (backend unit 9,
 * spec S3/S5). Pure: no I/O, no logging. A row that cannot be mapped is
 * reported with a fixed, input-free reason (S6) so the adapter can DEAD that
 * row alone and still deliver its neighbours (L7).
 */

export const MIRROR_TEXT_LIMIT = 4096;
const OPTIONS_PREFIX = '\n\nOpciones: ';
const OPTIONS_LABEL = 'Opciones: ';
const OPTIONS_SEPARATOR = ' · ';
const ELLIPSIS = '…';
/** Slack before a timestamp counts as "in the future" (contract: 5 min). */
const FUTURE_SLACK_MS = 4 * 60_000;
const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const REPLY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WA_MESSAGE_ID = /^[A-Za-z0-9._=+/:-]{1,255}$/;

const CONTRACT_TYPES: readonly string[] = [
  'TEXT',
  'IMAGE',
  'STICKER',
  'DOCUMENT',
  'AUDIO',
  'TEMPLATE',
  'UNSUPPORTED',
];
const MEDIA_TYPES: readonly string[] = [
  'IMAGE',
  'STICKER',
  'DOCUMENT',
  'AUDIO',
];
const UNSUPPORTED_KINDS: readonly string[] = ['VIDEO', 'LOCATION', 'OTHER'];

export type MappedMirrorEntry =
  | {
      ok: true;
      message: MirrorMessageInput;
      /** Present for IMAGE/STICKER/DOCUMENT/AUDIO: resolve it to a `mediaId`. */
      media?: { payload: unknown; type: MirrorMediaContractType };
    }
  | { ok: false; reason: string };

/** Length in characters (code points), the unit the contract counts. */
export function characterCount(text: string): number {
  let count = 0;
  for (const _ of text) {
    void _;
    count += 1;
  }
  return count;
}

/** The first `max` characters (code points) of `text`. */
function takeCharacters(text: string, max: number): string {
  if (max <= 0) return '';
  let out = '';
  let count = 0;
  for (const char of text) {
    if (count >= max) break;
    out += char;
    count += 1;
  }
  return out;
}

/** `text` cut to the limit, ending with an ellipsis when it was cut. */
function clip(text: string): string {
  if (characterCount(text) <= MIRROR_TEXT_LIMIT) return text;
  return takeCharacters(text, MIRROR_TEXT_LIMIT - 1) + ELLIPSIS;
}

/**
 * The text of a TEXT message. With `options` (an interactive OUT) they are
 * appended as "\n\nOpciones: A · B · C" (S5 #2: titles only). Past 4096
 * characters the options are truncated first (ending with "…", or dropped
 * when there is no room), then the body.
 */
export function renderMirrorText(
  body: string,
  options: readonly string[] | null,
): string {
  if (options === null || options.length === 0) return clip(body);
  const joined = options.join(OPTIONS_SEPARATOR);
  if (body.trim() === '') return clip(`${OPTIONS_LABEL}${joined}`);
  const full = `${body}${OPTIONS_PREFIX}${joined}`;
  if (characterCount(full) <= MIRROR_TEXT_LIMIT) return full;
  const room =
    MIRROR_TEXT_LIMIT - characterCount(body) - characterCount(OPTIONS_PREFIX);
  if (room >= 2)
    return `${body}${OPTIONS_PREFIX}${takeCharacters(joined, room - 1)}${ELLIPSIS}`;
  return clip(body);
}

const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** The ISO timestamp when well formed and within the contract floor. */
export function validIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_8601.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed < MIN_TIMESTAMP_MS) return undefined;
  return value;
}

/** Display-only clocks: a timestamp ahead of `now` is clamped, never refused. */
export function clampFuture(iso: string, nowMs: number): string {
  return Date.parse(iso) > nowMs + FUTURE_SLACK_MS
    ? new Date(nowMs).toISOString()
    : iso;
}

function offeredOptions(payload: Record<string, unknown>): string[] | null {
  const options = payload.options;
  if (!Array.isArray(options)) return null;
  const titles = (options as unknown[]).filter(isNonBlankString);
  return titles.length === 0 ? null : titles;
}

export function mapMirrorEntry(
  entry: BackendOutboxEntry,
  now: Date,
): MappedMirrorEntry {
  const payload = entry.payload;
  const nowMs = now.getTime();
  const { waMessageId, direction } = payload;
  if (typeof waMessageId !== 'string' || !WA_MESSAGE_ID.test(waMessageId))
    return { ok: false, reason: 'payload has no valid waMessageId' };
  if (direction !== 'IN' && direction !== 'OUT')
    return { ok: false, reason: 'payload direction is not IN or OUT' };

  let type: MirrorMessageType;
  if (
    typeof payload.contractType === 'string' &&
    CONTRACT_TYPES.includes(payload.contractType)
  )
    type = payload.contractType as MirrorMessageType;
  else if (typeof payload.type === 'string' && payload.type !== '')
    type = mirrorContractType(payload.type);
  else return { ok: false, reason: 'payload has no message type' };

  const observedAt = clampFuture(
    validIsoTimestamp(payload.observedAt) ?? entry.createdAt.toISOString(),
    nowMs,
  );
  // L7: rows enqueued before T2 have no OUT providerTimestamp.
  const providerTimestamp = clampFuture(
    validIsoTimestamp(payload.providerTimestamp) ?? observedAt,
    nowMs,
  );

  const message: MirrorMessageInput = {
    waMessageId,
    direction,
    author: direction === 'IN' ? 'CUSTOMER' : 'BOT',
    type,
    providerTimestamp,
    observedAt,
  };

  if (type === 'TEXT') {
    if (payload.text !== undefined && typeof payload.text !== 'string')
      return { ok: false, reason: 'payload text is not a string' };
    const body = typeof payload.text === 'string' ? payload.text : '';
    const text = renderMirrorText(
      body,
      direction === 'OUT' ? offeredOptions(payload) : null,
    );
    if (text.trim() === '')
      return { ok: false, reason: 'TEXT message has no text' };
    message.text = text;
    // Unit 10: only the OUT TEXT that delivered a staff reply; anything
    // malformed just loses the attribution (still mirrored, as BOT).
    if (
      direction === 'OUT' &&
      typeof payload.staffReplyId === 'string' &&
      REPLY_ID.test(payload.staffReplyId)
    )
      message.staffReplyId = payload.staffReplyId;
    return { ok: true, message };
  }

  if (type === 'UNSUPPORTED') {
    message.kind = UNSUPPORTED_KINDS.includes(payload.unsupportedKind as string)
      ? (payload.unsupportedKind as MirrorUnsupportedKind)
      : mirrorUnsupportedKind(
          typeof payload.type === 'string' ? payload.type : '',
        );
    return { ok: true, message };
  }

  // IMAGE / STICKER / DOCUMENT / AUDIO carry an optional caption; TEMPLATE
  // an optional text.
  if (isNonBlankString(payload.text)) message.text = clip(payload.text);
  if (MEDIA_TYPES.includes(type))
    return {
      ok: true,
      message,
      media: { payload: payload.media, type: type as MirrorMediaContractType },
    };
  return { ok: true, message };
}
