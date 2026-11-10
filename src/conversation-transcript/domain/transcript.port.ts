import type { PoolClient } from 'pg';

/** DI token for the durable conversation transcript (S1). */
export const CONVERSATION_TRANSCRIPT = Symbol('CONVERSATION_TRANSCRIPT');

export type TranscriptDirection = 'IN' | 'OUT';
/** STAFF is reserved for the live human conversation (not written yet). */
export type TranscriptAuthor = 'CUSTOMER' | 'BOT' | 'STAFF';

/** Provider media reference; the bytes are never stored here. */
export interface TranscriptMedia {
  providerMediaId?: string;
  mimeType?: string;
  filename?: string;
  /** Outbound images are sent by public link, not by media id. */
  link?: string;
}

/** One customer or bot message as the caller hands it to `append`. */
export interface TranscriptMessageInput {
  /** Raw WhatsApp wa_id, same value as `conversation_state.sender_id`. */
  senderId: string;
  /** Inbound wamid or the outbound id Meta returned. */
  waMessageId: string;
  direction: TranscriptDirection;
  author: TranscriptAuthor;
  /** Lowercase provider type: text, interactive, button, image, document, template... */
  type: string;
  text?: string | null;
  media?: TranscriptMedia | null;
  /** Provider details that are not text or media (template name, controls, reply id). */
  details?: Record<string, unknown> | null;
  /** Meta timestamp (inbound only), ISO-8601. */
  providerTimestamp?: string | null;
  observedAt: Date;
}

/** A stored message. Times are ISO-8601 UTC with ms and Z. */
export interface TranscriptMessage {
  senderId: string;
  waMessageId: string;
  direction: TranscriptDirection;
  author: TranscriptAuthor;
  type: string;
  text: string | null;
  media: TranscriptMedia | null;
  details: Record<string, unknown> | null;
  providerTimestamp: string | null;
  observedAt: string;
  purgeAfter: string;
}

/**
 * Runs only when `append` actually inserted the row, inside the same
 * transaction: the Postgres adapter passes its open client, and a throw
 * rolls the row back (the in-memory adapter removes it) before `append`
 * rethrows. Used to enqueue the backend mirror atomically (S1→S2).
 */
export type TranscriptInsertHook = (
  row: TranscriptMessage,
  client?: PoolClient,
) => Promise<void>;

export interface ConversationTranscriptStore {
  /** Idempotent on `waMessageId`: true only when a new row was written. */
  append(
    message: TranscriptMessageInput,
    onInserted?: TranscriptInsertHook,
  ): Promise<boolean>;
  /** The newest `limit` messages of one sender, oldest first. */
  listRecent(senderId: string, limit: number): Promise<TranscriptMessage[]>;
  /** Deletes at most `batchSize` rows whose purge time is due; returns the count. */
  purgeExpired(now: Date, batchSize: number): Promise<number>;
}

export const TRANSCRIPT_RETENTION_MONTHS = 12;
export const TRANSCRIPT_LIST_MAX = 500;
export const TRANSCRIPT_TEXT_MAX = 16_384;
export const TRANSCRIPT_JSON_MAX_BYTES = 8_192;
const SENDER_PATTERN = /^[0-9]{6,20}$/;
const TYPE_PATTERN = /^[a-z_]{1,32}$/;
const DIRECTIONS: ReadonlySet<string> = new Set(['IN', 'OUT']);
const AUTHORS: ReadonlySet<string> = new Set(['CUSTOMER', 'BOT', 'STAFF']);

export class InvalidTranscriptMessageError extends Error {
  constructor(public readonly field: string) {
    super(`Invalid transcript message: ${field}`);
    this.name = 'InvalidTranscriptMessageError';
  }
}

/**
 * `observedAt` plus 12 calendar months in UTC, clamped to the last day of
 * the target month (Feb 29 → Feb 28), like PostgreSQL interval arithmetic.
 * Computed once here so every adapter stores the same value.
 */
export function transcriptPurgeAfter(observedAt: Date): Date {
  const year = observedAt.getUTCFullYear();
  const month = observedAt.getUTCMonth() + TRANSCRIPT_RETENTION_MONTHS;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(observedAt.getUTCDate(), lastDay),
      observedAt.getUTCHours(),
      observedAt.getUTCMinutes(),
      observedAt.getUTCSeconds(),
      observedAt.getUTCMilliseconds(),
    ),
  );
}

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const jsonFits = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), 'utf8') <= TRANSCRIPT_JSON_MAX_BYTES;

/** Canonical ISO string for a provider timestamp, or null when unusable. */
function normalizeProviderTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeMedia(media: TranscriptMedia | null | undefined) {
  if (media === undefined || media === null) return null;
  const entries = Object.entries(media).filter(
    ([, value]) => typeof value === 'string' && value !== '',
  );
  return entries.length === 0
    ? null
    : (Object.fromEntries(entries) as TranscriptMedia);
}

/**
 * Validates and canonicalizes one message for storage. Throws
 * `InvalidTranscriptMessageError`; callers that must never fail catch it.
 */
export function normalizeTranscriptMessage(
  input: TranscriptMessageInput,
): TranscriptMessage {
  if (
    typeof input.senderId !== 'string' ||
    !SENDER_PATTERN.test(input.senderId)
  )
    throw new InvalidTranscriptMessageError('senderId');
  if (
    typeof input.waMessageId !== 'string' ||
    input.waMessageId.length < 1 ||
    input.waMessageId.length > 256
  )
    throw new InvalidTranscriptMessageError('waMessageId');
  if (!DIRECTIONS.has(input.direction))
    throw new InvalidTranscriptMessageError('direction');
  if (!AUTHORS.has(input.author))
    throw new InvalidTranscriptMessageError('author');
  if (typeof input.type !== 'string' || !TYPE_PATTERN.test(input.type))
    throw new InvalidTranscriptMessageError('type');
  if (!isValidDate(input.observedAt))
    throw new InvalidTranscriptMessageError('observedAt');
  const text =
    typeof input.text === 'string' && input.text !== '' ? input.text : null;
  if (text !== null && text.length > TRANSCRIPT_TEXT_MAX)
    throw new InvalidTranscriptMessageError('text');
  const media = normalizeMedia(input.media);
  if (media !== null && !jsonFits(media))
    throw new InvalidTranscriptMessageError('media');
  const details =
    input.details !== undefined &&
    input.details !== null &&
    typeof input.details === 'object' &&
    !Array.isArray(input.details)
      ? input.details
      : null;
  if (details !== null && !jsonFits(details))
    throw new InvalidTranscriptMessageError('details');
  return {
    senderId: input.senderId,
    waMessageId: input.waMessageId,
    direction: input.direction,
    author: input.author,
    type: input.type,
    text,
    media,
    details,
    providerTimestamp: normalizeProviderTimestamp(input.providerTimestamp),
    observedAt: input.observedAt.toISOString(),
    purgeAfter: transcriptPurgeAfter(input.observedAt).toISOString(),
  };
}

export const isValidTranscriptSenderId = (senderId: string): boolean =>
  typeof senderId === 'string' && SENDER_PATTERN.test(senderId);

/** Clamps a requested list size to 1..TRANSCRIPT_LIST_MAX. */
export const boundedListLimit = (limit: number): number =>
  Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), TRANSCRIPT_LIST_MAX)
    : 1;

/** Clamps a purge batch to 1..10000. */
export const boundedPurgeBatch = (batchSize: number): number =>
  Number.isInteger(batchSize) ? Math.min(Math.max(batchSize, 1), 10_000) : 1;
