import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Conversation mirror and media (backend unit 9, houndfe-backend
 * `docs/chatbot-handoff/chatbot-requests-bot-contract.md` §"Conversation
 * mirror and media", commit ed6fcd99): `messages:batch`, `statuses:batch`
 * and `POST /chatbot-api/media`.
 *
 * Error style: every documented answer is a typed result discriminated by
 * `kind` (the outbox decides per kind, S4). Nothing here echoes the
 * `conversationRef` or a phone (S6): failure payloads carry only fixed texts,
 * indexes, status codes and backend error codes. Parsing is fail-closed and
 * never throws; unknown extra response keys are dropped.
 */

// ---------------------------------------------------------------- limits

export const MIRROR_MAX_MESSAGES = 50;
export const MIRROR_MAX_STATUSES = 100;
export const MIRROR_TEXT_MAX_CHARS = 4096;
export const MIRROR_ERROR_CODE_MAX_CHARS = 64;
export const MIRROR_CONVERSATION_REF_MAX_CHARS = 200;
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** Contract bound: ISO timestamps are not before 2020 … */
const MIRROR_MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
/** … and at most 5 minutes in the future. */
const MIRROR_MAX_FUTURE_MS = 5 * 60 * 1000;

const CONVERSATION_REF = /^[A-Za-z0-9:_.@+-]{1,200}$/;
const WA_MESSAGE_ID = /^[A-Za-z0-9._=+/:-]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// ------------------------------------------------------- shared failures

/** Failures common to the three routes. */
export type ConversationMirrorCommonFailure =
  /** 400 (or a local contract violation, `local: true`, nothing was sent).
   *  Never retried in a loop: park and alert. */
  | { kind: 'VALIDATION_ERROR'; message: string | null; local: boolean }
  /** 401: stop and alert; do not kill rows. */
  | { kind: 'UNAUTHORIZED' }
  /** 403 `INSUFFICIENT_SCOPE` / `FORBIDDEN` (or `X-Branch-Id`): stop and alert. */
  | { kind: 'FORBIDDEN'; code: string | null }
  /** 429: wait `Retry-After` (seconds; null when absent/unparseable). */
  | { kind: 'RATE_LIMITED'; retryAfterSeconds: number | null }
  /** 5xx, timeout or network: retry the same request with backoff. */
  | {
      kind: 'RETRYABLE';
      cause: 'timeout' | 'network' | 'http_5xx';
      status: number | null;
      retryAfterSeconds: number | null;
    }
  /** 413 `BODY_TOO_LARGE` (over the 3 MiB body bound): park and alert. */
  | { kind: 'BODY_TOO_LARGE' }
  /** Any undocumented status/code or a 2xx body that breaks the contract. */
  | { kind: 'UNEXPECTED'; status: number; code: string | null };

/** 413 `BATCH_TOO_LARGE`: split by count and resend (`local` = never sent). */
export interface BatchTooLargeFailure {
  kind: 'BATCH_TOO_LARGE';
  limit: number;
  local: boolean;
}

// -------------------------------------------------------- messages:batch

export type MirrorDirection = 'IN' | 'OUT';
export type MirrorMessageType =
  | 'TEXT'
  | 'IMAGE'
  | 'STICKER'
  | 'DOCUMENT'
  | 'AUDIO'
  | 'TEMPLATE'
  | 'UNSUPPORTED';
export type MirrorUnsupportedKind = 'VIDEO' | 'LOCATION' | 'OTHER';

export interface MirrorMessageInput {
  waMessageId: string;
  direction: MirrorDirection;
  /** Optional; `IN` → `CUSTOMER`, `OUT` → `BOT` (STAFF/SYSTEM are refused). */
  author?: 'CUSTOMER' | 'BOT';
  type: MirrorMessageType;
  /** ≤ 4096 characters; required for TEXT, forbidden for UNSUPPORTED. */
  text?: string;
  /** Upload uuid; required for IMAGE/STICKER/DOCUMENT/AUDIO, else forbidden. */
  mediaId?: string;
  /** UNSUPPORTED only. */
  kind?: MirrorUnsupportedKind;
  providerTimestamp: string;
  observedAt: string;
}

export interface MirrorAcceptedMessage {
  waMessageId: string;
  messageId: string;
  seq: number;
}

export interface MirrorBatchAck {
  accepted: MirrorAcceptedMessage[];
  duplicates: string[];
}

export type MirrorMessagesResult =
  /** Both `accepted` and `duplicates` mean "the row is done": ACK. */
  | ({ kind: 'ok' } & MirrorBatchAck)
  | ConversationMirrorCommonFailure
  | BatchTooLargeFailure
  /** 409: a wamid is stored in another chat (a bug). Park and alert. */
  | { kind: 'MESSAGE_ID_CONFLICT' }
  /** 422: a `mediaId` is gone/unknown/purged. The backend does not name the
   *  item: re-upload every media of the batch and resend the same batch. */
  | { kind: 'MEDIA_NOT_FOUND' }
  /** 422: file kind does not match the message type. Park and alert. */
  | { kind: 'MEDIA_TYPE_MISMATCH' };

export function isValidConversationRef(ref: unknown): ref is string {
  return typeof ref === 'string' && CONVERSATION_REF.test(ref);
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // A high surrogate followed by a low one is one character (an emoji).
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `null` when the timestamp meets the contract bounds, else a fixed reason. */
function timestampProblem(value: unknown, nowMs: number): string | null {
  if (typeof value !== 'string' || !ISO_8601.test(value))
    return 'must be an ISO-8601 timestamp with Z or an offset';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'must be a valid timestamp';
  if (parsed < MIRROR_MIN_TIMESTAMP_MS) return 'must not be before 2020';
  if (parsed > nowMs + MIRROR_MAX_FUTURE_MS)
    return 'must be at most 5 minutes in the future';
  return null;
}

const MESSAGE_TYPES: readonly string[] = [
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

/** A fixed, input-free reason for the first contract violation, or null. */
export function mirrorMessageProblem(
  message: unknown,
  nowMs: number,
): string | null {
  if (!isPlainObject(message)) return 'must be an object';
  // Extra keys are dropped on the wire, never forwarded (tenant, seq, … are
  // not ours to set), so they are not a violation here.
  const { waMessageId, direction, author, type, text, mediaId, kind } = message;
  if (typeof waMessageId !== 'string' || !WA_MESSAGE_ID.test(waMessageId))
    return 'waMessageId is out of contract';
  if (direction !== 'IN' && direction !== 'OUT')
    return 'direction must be IN or OUT';
  if (author !== undefined) {
    const expected = direction === 'IN' ? 'CUSTOMER' : 'BOT';
    if (author !== expected)
      return `author must be ${expected} for direction ${direction}`;
  }
  if (typeof type !== 'string' || !MESSAGE_TYPES.includes(type))
    return 'type is out of contract';
  if (type === 'TEMPLATE' && direction !== 'OUT')
    return 'TEMPLATE is only valid for direction OUT';
  if (text !== undefined) {
    if (typeof text !== 'string') return 'text must be a string';
    if (codePointLength(text) > MIRROR_TEXT_MAX_CHARS)
      return `text exceeds ${MIRROR_TEXT_MAX_CHARS} characters`;
  }
  if (type === 'TEXT' && (typeof text !== 'string' || text.trim() === ''))
    return 'TEXT needs a non-blank text';
  if (type === 'UNSUPPORTED' && text !== undefined)
    return 'UNSUPPORTED must not carry text';
  if (MEDIA_TYPES.includes(type)) {
    if (typeof mediaId !== 'string' || !UUID.test(mediaId))
      return `${type} needs a uuid mediaId`;
  } else if (mediaId !== undefined) {
    return `${type} must not carry a mediaId`;
  }
  if (type === 'UNSUPPORTED') {
    if (kind !== undefined && !UNSUPPORTED_KINDS.includes(kind as string))
      return 'kind must be VIDEO, LOCATION or OTHER';
  } else if (kind !== undefined) {
    return 'kind is only valid for UNSUPPORTED';
  }
  const providerProblem = timestampProblem(message.providerTimestamp, nowMs);
  if (providerProblem !== null) return `providerTimestamp ${providerProblem}`;
  const observedProblem = timestampProblem(message.observedAt, nowMs);
  if (observedProblem !== null) return `observedAt ${observedProblem}`;
  return null;
}

/**
 * Local check of a whole `messages:batch` body. `null` when valid; a
 * `BATCH_TOO_LARGE` for more than 50 (split by count, never by size) or a
 * `VALIDATION_ERROR` naming the offending index (never its content).
 */
export function validateMirrorMessages(
  messages: unknown,
  nowMs: number,
):
  | null
  | BatchTooLargeFailure
  | Extract<ConversationMirrorCommonFailure, { kind: 'VALIDATION_ERROR' }> {
  if (!Array.isArray(messages) || messages.length === 0)
    return localValidation('messages must hold 1 to 50 items');
  if (messages.length > MIRROR_MAX_MESSAGES)
    return { kind: 'BATCH_TOO_LARGE', limit: MIRROR_MAX_MESSAGES, local: true };
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const problem = mirrorMessageProblem(messages[index], nowMs);
    if (problem !== null)
      return localValidation(`messages[${index}] ${problem}`);
    const id = (messages[index] as MirrorMessageInput).waMessageId;
    if (seen.has(id))
      return localValidation(`messages[${index}] repeats a waMessageId`);
    seen.add(id);
  }
  return null;
}

export function localValidation(
  message: string,
): Extract<ConversationMirrorCommonFailure, { kind: 'VALIDATION_ERROR' }> {
  return { kind: 'VALIDATION_ERROR', message, local: true };
}

/** Only contract keys go on the wire, in a fixed order. */
export function toMirrorMessagesBody(messages: readonly MirrorMessageInput[]): {
  messages: Record<string, unknown>[];
} {
  return {
    messages: messages.map((m) => {
      const wire: Record<string, unknown> = {
        waMessageId: m.waMessageId,
        direction: m.direction,
      };
      if (m.author !== undefined) wire.author = m.author;
      wire.type = m.type;
      if (m.text !== undefined) wire.text = m.text;
      if (m.mediaId !== undefined) wire.mediaId = m.mediaId;
      if (m.kind !== undefined) wire.kind = m.kind;
      wire.providerTimestamp = m.providerTimestamp;
      wire.observedAt = m.observedAt;
      return wire;
    }),
  };
}

export function parseMirrorBatchAck(body: unknown): MirrorBatchAck | null {
  if (!isPlainObject(body)) return null;
  const { accepted, duplicates } = body;
  if (!Array.isArray(accepted) || !Array.isArray(duplicates)) return null;
  if (!duplicates.every((id) => typeof id === 'string' && id.length > 0))
    return null;
  const parsed: MirrorAcceptedMessage[] = [];
  for (const item of accepted) {
    if (!isPlainObject(item)) return null;
    const { waMessageId, messageId, seq } = item;
    if (
      typeof waMessageId !== 'string' ||
      waMessageId.length === 0 ||
      typeof messageId !== 'string' ||
      messageId.length === 0 ||
      !Number.isSafeInteger(seq)
    )
      return null;
    parsed.push({ waMessageId, messageId, seq: seq as number });
  }
  return { accepted: parsed, duplicates: duplicates as string[] };
}

// ------------------------------------------------------- statuses:batch

export type MirrorDeliveryStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface MirrorStatusInput {
  /** The `waMessageId` that was mirrored. */
  providerMessageId: string;
  status: MirrorDeliveryStatus;
  occurredAt: string;
  /** ≤ 64 characters; accepted by the backend and not stored. */
  errorCode?: string;
}

export interface MirrorStatusAck {
  applied: number;
  ignored: number;
  /** Ids matching no mirrored message yet: retry after the mirror ACK, give
   *  up after 24 h. */
  unknown: string[];
}

export type MirrorStatusesResult =
  | ({ kind: 'ok' } & MirrorStatusAck)
  | ConversationMirrorCommonFailure
  | BatchTooLargeFailure;

const DELIVERY_STATUSES: readonly string[] = [
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
];

export function mirrorStatusProblem(
  status: unknown,
  nowMs: number,
): string | null {
  if (!isPlainObject(status)) return 'must be an object';
  const { providerMessageId, status: value, occurredAt, errorCode } = status;
  if (
    typeof providerMessageId !== 'string' ||
    !WA_MESSAGE_ID.test(providerMessageId)
  )
    return 'providerMessageId is out of contract';
  if (typeof value !== 'string' || !DELIVERY_STATUSES.includes(value))
    return 'status must be SENT, DELIVERED, READ or FAILED';
  const problem = timestampProblem(occurredAt, nowMs);
  if (problem !== null) return `occurredAt ${problem}`;
  if (errorCode !== undefined) {
    if (typeof errorCode !== 'string') return 'errorCode must be a string';
    if (codePointLength(errorCode) > MIRROR_ERROR_CODE_MAX_CHARS)
      return `errorCode exceeds ${MIRROR_ERROR_CODE_MAX_CHARS} characters`;
  }
  return null;
}

export function validateMirrorStatuses(
  statuses: unknown,
  nowMs: number,
):
  | null
  | BatchTooLargeFailure
  | Extract<ConversationMirrorCommonFailure, { kind: 'VALIDATION_ERROR' }> {
  if (!Array.isArray(statuses) || statuses.length === 0)
    return localValidation('statuses must hold 1 to 100 items');
  if (statuses.length > MIRROR_MAX_STATUSES)
    return { kind: 'BATCH_TOO_LARGE', limit: MIRROR_MAX_STATUSES, local: true };
  for (let index = 0; index < statuses.length; index += 1) {
    const problem = mirrorStatusProblem(statuses[index], nowMs);
    if (problem !== null)
      return localValidation(`statuses[${index}] ${problem}`);
  }
  return null;
}

export function toMirrorStatusesBody(statuses: readonly MirrorStatusInput[]): {
  statuses: Record<string, unknown>[];
} {
  return {
    statuses: statuses.map((s) => {
      const wire: Record<string, unknown> = {
        providerMessageId: s.providerMessageId,
        status: s.status,
        occurredAt: s.occurredAt,
      };
      if (s.errorCode !== undefined) wire.errorCode = s.errorCode;
      return wire;
    }),
  };
}

export function parseMirrorStatusAck(body: unknown): MirrorStatusAck | null {
  if (!isPlainObject(body)) return null;
  const { applied, ignored, unknown } = body;
  if (
    !Number.isSafeInteger(applied) ||
    !Number.isSafeInteger(ignored) ||
    !Array.isArray(unknown) ||
    !unknown.every((id) => typeof id === 'string')
  )
    return null;
  return {
    applied: applied as number,
    ignored: ignored as number,
    unknown: unknown,
  };
}

// ----------------------------------------------------------- POST /media

export interface UploadMediaInput {
  /** A file on disk, streamed (never buffered whole). Exactly one of
   *  `filePath` / `stream`. */
  filePath?: string;
  /** A readable byte stream; pass `sizeBytes` when known so the request
   *  carries a `Content-Length` (otherwise it is sent chunked). */
  stream?: Readable;
  sizeBytes?: number;
  /** Cosmetic; the backend decides the type from the bytes. */
  filename?: string;
  /** Optional lowercase hex SHA-256 of the bytes. */
  sha256?: string;
  /** Required lowercase UUID, derive it with `mediaIdempotencyKey`. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface UploadedMedia {
  /** `true` for 201 (stored), `false` for 200 (replay of the same bytes). */
  created: boolean;
  mediaId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export type UploadMediaResult =
  | ({ kind: 'ok' } & UploadedMedia)
  /** 400: also covers a `sha256` mismatch (`shaSent` tells the caller one was
   *  sent: the bytes changed, re-download). Otherwise a bug: park and alert. */
  | {
      kind: 'VALIDATION_ERROR';
      message: string | null;
      local: boolean;
      shaSent: boolean;
    }
  /** 409: the key was used with other bytes; new key only if bytes differ. */
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  /** 413 (or the local 10 MiB cap): do not retry; mirror UNSUPPORTED. */
  | { kind: 'MEDIA_TOO_LARGE'; local: boolean }
  /** 415: do not retry; mirror UNSUPPORTED. */
  | { kind: 'MEDIA_TYPE_NOT_ALLOWED' }
  /** 503: storage was down, nothing recorded; retry with the same key. */
  | { kind: 'MEDIA_STORAGE_FAILED'; retryAfterSeconds: number | null }
  /** Local, deterministic failure of the caller's source (the stream's length
   *  differs from the declared size, or the source errored). Nothing the
   *  backend did: never a network retry on the shared write budget. */
  | { kind: 'LOCAL_SOURCE_ERROR' }
  /** The caller's `signal` aborted the upload. */
  | { kind: 'ABORTED' }
  | Exclude<ConversationMirrorCommonFailure, { kind: 'VALIDATION_ERROR' }>;

export function isLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_UUID.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function parseUploadedMedia(
  body: unknown,
  created: boolean,
): UploadedMedia | null {
  if (!isPlainObject(body)) return null;
  const { mediaId, mimeType, sizeBytes, sha256 } = body;
  if (
    typeof mediaId !== 'string' ||
    mediaId.length === 0 ||
    typeof mimeType !== 'string' ||
    mimeType.length === 0 ||
    !Number.isSafeInteger(sizeBytes) ||
    (sizeBytes as number) < 0 ||
    typeof sha256 !== 'string' ||
    sha256.length === 0
  )
    return null;
  return { created, mediaId, mimeType, sizeBytes: sizeBytes as number, sha256 };
}

/** Cosmetic filename safe inside a quoted Content-Disposition value. */
export function safeMediaFilename(filename: string | undefined): string {
  const cleaned = (filename ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .slice(0, 100)
    .trim();
  return cleaned === '' ? 'media' : cleaned;
}

/**
 * A multipart/form-data body streamed lazily: an optional `sha256` field
 * (before the file) and exactly one `file` part. Memory stays bounded to one
 * chunk of the source; `onCapExceeded` fires and the body errors the moment
 * the file passes `MEDIA_MAX_BYTES` (or does not match the declared size).
 */
export function createMediaMultipart(options: {
  source: Readable;
  filename: string;
  sha256?: string;
  /** Known source size → exact `contentLength`; unknown → chunked. */
  sizeBytes?: number;
  onCapExceeded: () => void;
  /** The source ended with a length different from `sizeBytes`. */
  onSizeMismatch?: () => void;
  /** The source stream itself errored (not a consumer cancel). */
  onSourceError?: () => void;
}): { body: Readable; contentType: string; contentLength: number | null } {
  const boundary = `houndfe-${randomBytes(16).toString('hex')}`;
  const head = Buffer.from(
    (options.sha256 === undefined
      ? ''
      : `--${boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n${options.sha256}\r\n`) +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const { source, sizeBytes, onCapExceeded } = options;

  /** Reports a failure of the source itself, apart from the consumer closing
   *  the generator (which ends the loop without throwing). */
  async function* guarded(stream: Readable): AsyncGenerator<unknown> {
    try {
      yield* stream;
    } catch (error) {
      options.onSourceError?.();
      throw error;
    }
  }

  async function* generate(): AsyncGenerator<Buffer> {
    yield head;
    let total = 0;
    try {
      for await (const chunk of guarded(source)) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array | string);
        total += buffer.length;
        if (total > MEDIA_MAX_BYTES) {
          onCapExceeded();
          throw new Error('Media stream exceeds the 10 MiB cap');
        }
        yield buffer;
      }
    } finally {
      source.destroy();
    }
    if (sizeBytes !== undefined && total !== sizeBytes) {
      options.onSizeMismatch?.();
      throw new Error('Media stream length differs from the declared size');
    }
    yield tail;
  }

  return {
    body: Readable.from(generate(), { objectMode: false }),
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength:
      sizeBytes === undefined ? null : head.length + sizeBytes + tail.length,
  };
}
