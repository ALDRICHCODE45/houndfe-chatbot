import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';
import type {
  ActiveReceiptStatus,
  ActiveSenderIdentity,
  AttemptStartResult,
  DownloadCommitInput,
  DownloadCommitOutcome,
  LeaseFenceInput,
  MetaFailureDispositionInput,
  MetaFailureDispositionOutcome,
  MetaTerminalFailureStage,
  ReceiptMediaStorePort,
  ReservationOutcome,
  ReserveInput,
  RejectedMediaInput,
  StorageAttemptInput,
  UploadCommitOutcome,
  UploadDefiniteFailureInput,
  UploadSuccessInput,
  UploadTemplateArgs,
  UploadUnknownInput,
} from '../domain/receipt-media-store.port';
import { MAX_UPLOAD_ATTEMPTS } from '../domain/receipt-media-store.port';
import type {
  ReceiptOutcomeCandidate,
  ReceiptOutcomeCommitInput,
  ReceiptOutcomeCommitResult,
  ReceiptOutcomePollPolicy,
  ReceiptOutcomeStore,
} from '../domain/receipt-outcome';
import { RECEIPT_SHA256_BYTES } from '../domain/receipt-media.types';

type Row = Record<string, unknown>;
type Media = ReceiptMediaRow;

const RENEW_SQL = `UPDATE receipt_media SET lease_expires_at = now() + interval '60 seconds',
     updated_at = now()
   WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
     AND lease_expires_at > now()`;

const DOWNLOAD_COMMIT_SQL = `UPDATE receipt_media
  SET status = 'DOWNLOADED', downloaded_at = now(), response_mime_type = $4,
      detected_mime_type = $5, byte_count = $6, content_sha256 = $7,
      version = version + 1, updated_at = now()
  WHERE id = $1 AND lease_owner = $2 AND status = 'RESERVED'
    AND version = $3::bigint AND lease_expires_at > now() RETURNING *`;

const META_ATTEMPT_SQL = `UPDATE receipt_media
   SET meta_attempts = meta_attempts + 1, version = version + 1, updated_at = now()
   WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
     AND lease_expires_at > now() AND status IN ('RESERVED', 'DOWNLOADED')
     AND meta_attempts < 3 RETURNING meta_attempts AS attempt, version`;

const STORAGE_ATTEMPT_SQL = `UPDATE receipt_media
   SET storage_attempts = storage_attempts + 1, version = version + 1,
     upload_fields = COALESCE(upload_fields, $4::jsonb),
     updated_at = now() WHERE id = $1 AND lease_owner = $2
     AND version = $3::bigint AND lease_expires_at > now()
     AND status = 'DOWNLOADED' AND storage_attempts < ${MAX_UPLOAD_ATTEMPTS}
     RETURNING storage_attempts AS attempt, version`;

/** ODD-2C fresh Meta disposition lock: the exact owned, live-leased
 * RESERVED/DOWNLOADED row at the caller's expected version read under
 * `clock_timestamp()` and a row lock, so every routing, state, attempt,
 * status, and deadline value comes from the durable row and a lease that
 * expires while this transaction waits can never authorize a mutation. */
const META_FAILURE_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status IN ('RESERVED', 'DOWNLOADED') FOR UPDATE`;

/** ODD-2C terminal replay/repair fence: the exact owned, live-leased
 * terminal successor read under `clock_timestamp()` and a row lock, so a
 * lease that expires or is released while this transaction waits on a
 * concurrent writer can never authorize a replay or a legacy
 * missing-intent repair. */
const META_FAILURE_REPLAY_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;

/** ODD-2C transient retry schedule: retain the processing status, persist
 * only the safe category/code, set the deadline from DB clock time, clear
 * both lease fields, and bump the version; no intent is created. */
const META_RETRY_SQL = `UPDATE receipt_media
      SET last_error_category = $5, last_error_code = $6,
        next_attempt_at = clock_timestamp() + ($7::int * interval '1 millisecond'),
        lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status IN ('RESERVED', 'DOWNLOADED') AND meta_attempts = $4::int
      RETURNING *`;

/** ODD-2C permanent/exhausted terminal transition: one atomic, parameter-
 * bound fenced UPDATE to FAILED with the derived failure stage, safe error
 * evidence, terminal_at, and every superseded download and accepted-object
 * column cleared; the terminal lease is retained per the established
 * replay convention. ODD-2C fences with `clock_timestamp()` so a row-lock
 * wait that outlives the lease cannot commit. */
const META_TERMINAL_SQL = `UPDATE receipt_media
      SET status = 'FAILED', failure_stage = $5, last_error_category = $6,
        last_error_code = $7, terminal_at = clock_timestamp(),
        downloaded_at = NULL, response_mime_type = NULL, detected_mime_type = NULL,
        byte_count = NULL, content_sha256 = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status IN ('RESERVED', 'DOWNLOADED') AND meta_attempts = $4::int
        AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
        AND attach_http_status IS NULL AND attach_transport_code IS NULL
        AND attach_outcome_observed_at IS NULL RETURNING *`;

const MAX_INT32 = 2_147_483_647;
/** ODD-2C fixed Meta disposition taxonomy. MEDIA_VALIDATION codes are
 * always permanent pre-storage validation failures; HTTP_PERMANENT is a
 * permanent transport failure classified at the same pre-storage stage;
 * the retryable transport codes schedule attempts 1/2 and terminalize
 * attempt 3 as META_EXHAUSTED_PRE_STORAGE; META_EXHAUSTED is the fixed
 * internal code for a reclaimed row already at meta_attempts = 3. */
const META_VALIDATION_CODES = new Set<string>([
  'UNSUPPORTED_MIME',
  'INVALID_MEDIA_SIZE',
  'MIME_MISMATCH',
  'PNG_STRUCTURE_INVALID',
  'JPEG_STRUCTURE_INVALID',
  'PDF_STRUCTURE_INVALID',
]);
const META_RETRYABLE_CODES = new Set<string>([
  'FILE_IO_FAILURE',
  'NETWORK_FAILURE',
  'HTTP_RETRYABLE',
  'TIMEOUT',
  'ABORTED',
]);
const META_EXHAUSTED = 'META_EXHAUSTED';

/** Documented bounded positive retry jitter for pre-storage Meta and
 * storage failures: attempt 1 waits 1s plus 0..250ms, attempt 2 waits 4s
 * plus 0..1000ms (25% of the base), so a retry deadline is never earlier
 * than its base. */
const RETRY_BASE_MS = [1000, 4000];
const RETRY_JITTER_RATIO = 0.25;
const retryDelayMs = (attempt: number): number => {
  const base = RETRY_BASE_MS[attempt - 1];
  return base + Math.floor(Math.random() * (base * RETRY_JITTER_RATIO + 1));
};

/** The fixed safe command taxonomy; unknown category/code pairs never reach
 * the database. */
const isMetaFailureCommand = (category: unknown, code: unknown): boolean =>
  category === 'MEDIA_VALIDATION'
    ? typeof code === 'string' && META_VALIDATION_CODES.has(code)
    : category === 'META_TRANSPORT'
      ? typeof code === 'string' &&
        (META_RETRYABLE_CODES.has(code) ||
          code === 'HTTP_PERMANENT' ||
          code === META_EXHAUSTED)
      : false;

/** Terminal stage for the locked row's fixed disposition, or `retry` for a
 * retryable transport code below the attempt limit; null fences. */
const metaFailureDecision = (
  category: string,
  code: string,
  attempts: number,
): MetaTerminalFailureStage | 'retry' | null => {
  if (attempts < 1 || attempts > 3) return null;
  if (category === 'MEDIA_VALIDATION')
    return META_VALIDATION_CODES.has(code)
      ? 'MEDIA_VALIDATION_PRE_STORAGE'
      : null;
  if (code === META_EXHAUSTED)
    return attempts === 3 ? 'META_EXHAUSTED_PRE_STORAGE' : null;
  if (code === 'HTTP_PERMANENT') return 'MEDIA_VALIDATION_PRE_STORAGE';
  return META_RETRYABLE_CODES.has(code)
    ? attempts < 3
      ? 'retry'
      : 'META_EXHAUSTED_PRE_STORAGE'
    : null;
};
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
class ProposalFencedError extends Error {}
const FENCED = new ProposalFencedError();

const RECEIPT_MIME_TYPES: ReadonlySet<unknown> = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);
const isReceiptMime = (value: unknown): boolean =>
  RECEIPT_MIME_TYPES.has(value);

const successorVersion = (value: string): string | null => {
  if (!/^[1-9]\d*(?![\s\S])/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < MAX_BIGINT ? String(parsed + 1n) : null;
};

const isDownloadInput = (
  input: DownloadCommitInput,
  successor: string | null,
): successor is string => {
  try {
    return (
      successor !== null &&
      typeof input.id === 'string' &&
      input.id.length > 0 &&
      typeof input.owner === 'string' &&
      input.owner.length > 0 &&
      isReceiptMime(input.responseMimeType) &&
      isReceiptMime(input.detectedMimeType) &&
      Number.isInteger(input.byteCount) &&
      input.byteCount > 0 &&
      input.byteCount <= MAX_INT32 &&
      ArrayBuffer.isView(input.contentSha256) &&
      Buffer.isBuffer(input.contentSha256) &&
      input.contentSha256.length === RECEIPT_SHA256_BYTES
    );
  } catch {
    return false;
  }
};

const sameDownloadEvidence = (row: Row, input: DownloadCommitInput) =>
  row.response_mime_type === input.responseMimeType &&
  row.detected_mime_type === input.detectedMimeType &&
  row.byte_count === input.byteCount &&
  Buffer.isBuffer(row.content_sha256) &&
  Buffer.compare(row.content_sha256, input.contentSha256) === 0;

/** Row-derived identity of the single unavailable-later intent shared by
 * every pre-acceptance terminal failure: receipt id, FAILED successor
 * version, and stored webhook message only — never a caller value, object
 * key, URL, capability, or free text. */
const unavailableLaterIntentKey = (
  receiptId: string,
  successor: string,
  webhookMessageId: string,
): string =>
  `receipt-unavailable-later:${receiptId}:${successor}:${webhookMessageId}`;

/** Exact structural ownership proof for the `RECEIPT_UNAVAILABLE_LATER`
 * intent: the deterministic key plus every row-derived column, with the
 * single bounded empty-args shape. */
const unavailableLaterIntentMatches = (
  row: Row | undefined,
  receiptId: string,
  successor: string,
  webhookMessageId: string,
  senderId: string,
  dedupeKey: string,
): row is Row =>
  !!row &&
  row.dedupe_key === dedupeKey &&
  row.receipt_media_id === receiptId &&
  row.receipt_state_version === successor &&
  row.source_webhook_message_id === webhookMessageId &&
  row.recipient_id === senderId &&
  row.template_key === 'RECEIPT_UNAVAILABLE_LATER' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 0;

const camelize = <T extends object>(row: Row): T =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  ) as T;

const loadHit = async (
  c: PoolClient,
  input: ReserveInput,
): Promise<Row | undefined> => {
  const one = async (col: string, value: string): Promise<Row | undefined> =>
    (
      await c.query<Row>(`SELECT * FROM receipt_media WHERE ${col} = $1`, [
        value,
      ])
    ).rows[0];
  return (
    (await one('webhook_message_id', input.webhookMessageId)) ??
    (await one('provider_media_id', input.providerMediaId))
  );
};

/** A webhook hit compares media; a provider-media hit is always a reuse. */
const classify = (hit: Row, input: ReserveInput): ReservationOutcome =>
  hit.webhook_message_id === input.webhookMessageId
    ? hit.provider_media_id === input.providerMediaId
      ? { kind: 'webhook-replayed', receipt: camelize<Media>(hit) }
      : { kind: 'webhook-media-conflict' }
    : { kind: 'provider-media-reused', receipt: camelize<Media>(hit) };

/** UNRELATED active row for the sender; identity overlaps belong to `admit`. */
const UNRELATED_ACTIVE_SENDER_SQL = `SELECT status FROM receipt_media
   WHERE sender_id = $1 AND status IN ('RESERVED', 'DOWNLOADED')
     AND webhook_message_id <> $2 AND provider_media_id <> $3`;

/** Admission conflict reload: committed active winner, no identity exclusions. */
const ACTIVE_SENDER_WINNER_SQL = `SELECT status FROM receipt_media
   WHERE sender_id = $1 AND status IN ('RESERVED', 'DOWNLOADED')`;

const lookupActiveStatus = async (
  run: (sql: string, params: unknown[]) => Promise<Array<{ status: string }>>,
  sql: string,
  params: unknown[],
): Promise<ActiveReceiptStatus | null> => {
  const rows = await run(sql, params);
  const status = rows[0]?.status;
  return status === undefined ? null : (status as ActiveReceiptStatus);
};

/** WU2B2A PostgreSQL primitives (RM1, RM3) over the WU2A1/WU2A2A/WU2A2B
 * schema. Every external value is parameter-bound; no caption, URL, token,
 * response body, raw error, or diagnostic PII is persisted. */

/** R2 backend upload commits: every one locks the exact owned, live-leased
 * DOWNLOADED row at the caller's version (`clock_timestamp()` fence). */
const UPLOAD_LOCK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp() AND status = 'DOWNLOADED'
      FOR UPDATE`;

/** Request evidence stamped at the terminal commit (the schema requires it
 * for every attach-terminal row). */
const UPLOAD_ATTACH_EVIDENCE = `attach_started_at = now(),
        terminal_at = now(), version = version + 1, updated_at = now()`;

const UPLOAD_SUCCESS_SQL = `UPDATE receipt_media
      SET status = 'ATTACHED', backend_receipt_id = $4,
        backend_receipt_status = 'PENDING', attached_at = now(),
        sale_folio = $5,
        last_error_category = NULL, last_error_code = NULL,
        ${UPLOAD_ATTACH_EVIDENCE}
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
      RETURNING *`;

const UPLOAD_DEFINITE_SQL = `UPDATE receipt_media
      SET status = 'FAILED', failure_stage = 'ATTACH_DEFINITE',
        attach_http_status = $4, last_error_category = 'BACKEND_UPLOAD',
        last_error_code = $5, ${UPLOAD_ATTACH_EVIDENCE}
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
      RETURNING *`;

const UPLOAD_UNKNOWN_TERMINAL_SQL = `UPDATE receipt_media
      SET status = 'ATTACH_OUTCOME_UNKNOWN', attach_http_status = $4,
        attach_transport_code = $5, attach_outcome_observed_at = now(),
        last_error_category = 'BACKEND_UPLOAD', last_error_code = $6,
        ${UPLOAD_ATTACH_EVIDENCE}
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
      RETURNING *`;

/** Same-key retry: keep DOWNLOADED, persist the safe code, schedule, and
 * release the lease so any worker reclaims it when due. */
const UPLOAD_RETRY_SQL = `UPDATE receipt_media
      SET last_error_category = 'BACKEND_UPLOAD', last_error_code = $4,
        next_attempt_at = clock_timestamp() + ($5::int * interval '1 millisecond'),
        lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
      RETURNING *`;

/** Refused media: FAILED with the reason stage; the download evidence is
 * cleared as the schema requires for a never-uploaded file. */
const UPLOAD_REJECTED_SQL = `UPDATE receipt_media
      SET status = 'FAILED', failure_stage = $4, terminal_at = now(),
        downloaded_at = NULL, response_mime_type = NULL,
        detected_mime_type = NULL, byte_count = NULL, content_sha256 = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
      RETURNING *`;

/** Backoff after unknown attempt n (1..5): 30 s, 2, 5, 10, 15 min (~32 min
 * before the sixth and last attempt), plus up to 10% positive jitter. */
const UPLOAD_RETRY_BASE_MS = [30_000, 120_000, 300_000, 600_000, 900_000];
const uploadRetryDelayMs = (attempt: number): number => {
  const base =
    UPLOAD_RETRY_BASE_MS[Math.min(attempt, UPLOAD_RETRY_BASE_MS.length) - 1];
  return base + Math.floor(Math.random() * (base * 0.1 + 1));
};

/** 401/403/429 are retryable unknown outcomes (migration 3600). */
const UPLOAD_DEFINITE_STATUSES = new Set([400, 404, 409, 413, 415, 422]);
const UPLOAD_DEFINITE_TEMPLATES = new Set<string>([
  'RECEIPT_SALE_ALREADY_PAID',
  'RECEIPT_SALE_NOT_PAYABLE',
  'RECEIPT_UNSUPPORTED_FORMAT',
  'RECEIPT_ATTACH_DEFINITE_FAILURE',
]);
const REJECTED_MEDIA_TEMPLATES = {
  NOT_A_RECEIPT: 'RECEIPT_NOT_A_RECEIPT',
  PDF_ENCRYPTED: 'RECEIPT_PDF_ENCRYPTED',
} as const;
/** Safe, bounded evidence code: an allowlisted shape, never a body. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_FOLIO_LENGTH = 40;
/** Transport code of an accepted upload whose receipt id fails validation. */
const RECEIPT_ID_INVALID = 'RECEIPT_ID_INVALID';

const isUploadFence = (input: LeaseFenceInput): boolean =>
  typeof input?.id === 'string' &&
  UUID.test(input.id) &&
  typeof input?.owner === 'string' &&
  input.owner.length > 0 &&
  typeof input?.expectedVersion === 'string' &&
  successorVersion(input.expectedVersion) !== null;

const isCents = (value: unknown): boolean =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Exactly the three optional keys, each bounded. */
const isUploadTemplateArgs = (args: UploadTemplateArgs): boolean =>
  isRecord(args) &&
  Object.keys(args).every((k) =>
    ['folio', 'extractedAmountCents', 'totalCents'].includes(k),
  ) &&
  (args.folio === undefined ||
    (typeof args.folio === 'string' &&
      args.folio.length > 0 &&
      args.folio.length <= MAX_FOLIO_LENGTH)) &&
  (args.extractedAmountCents === undefined ||
    isCents(args.extractedAmountCents)) &&
  (args.totalCents === undefined || isCents(args.totalCents));

/** R5 due outcome reads (mirrors the DELIVERY_ZONE backoff): an ATTACHED
 * receipt without a recorded outcome is due when never polled, or when its
 * last read is older than the gap (slow gap once long-pending). */
const OUTCOME_DUE_SQL = `SELECT id, sender_id, backend_receipt_id, sale_folio,
    attached_at, outcome_polled_at FROM receipt_media
  WHERE status = 'ATTACHED' AND outcome_notified_at IS NULL
    AND backend_receipt_id IS NOT NULL
    AND (outcome_polled_at IS NULL OR outcome_polled_at <= now() -
      (CASE WHEN attached_at <= now() - ($2::int * interval '1 millisecond')
        THEN $3::int ELSE $4::int END) * interval '1 millisecond')
  ORDER BY outcome_polled_at NULLS FIRST, attached_at, id
  LIMIT $1`;

const OUTCOME_POLLED_SQL = `UPDATE receipt_media SET outcome_polled_at = now(),
    updated_at = now()
  WHERE id = $1 AND status = 'ATTACHED' AND outcome_notified_at IS NULL`;

/** Records the outcome and its notification together, exactly once. */
const OUTCOME_COMMIT_SQL = `UPDATE receipt_media
  SET outcome_status = $2, outcome_reason = $3, outcome_debt_cents = $4,
    outcome_delivery = $5, outcome_observed_at = now(),
    outcome_notified_at = now(), outcome_polled_at = now(),
    version = version + 1, updated_at = now()
  WHERE id = $1 AND status = 'ATTACHED' AND outcome_notified_at IS NULL
  RETURNING *`;

const OUTCOME_TEMPLATES: Record<string, ReadonlySet<string>> = {
  CONFIRMED: new Set(['RECEIPT_PAYMENT_CONFIRMED', 'RECEIPT_PAYMENT_PARTIAL']),
  REJECTED: new Set(['RECEIPT_PAYMENT_REJECTED']),
};
const MAX_OUTCOME_REASON_LENGTH = 500;

const isOutcomeCommit = (input: ReceiptOutcomeCommitInput): boolean => {
  const args = input.templateArgs;
  return (
    typeof input.id === 'string' &&
    UUID.test(input.id) &&
    OUTCOME_TEMPLATES[input.status]?.has(input.templateKey) === true &&
    (input.delivery === 'QUEUED' || input.delivery === 'OUTSIDE_WINDOW') &&
    isCents(input.debtCents) &&
    (input.customerReason === null ||
      (input.status === 'REJECTED' &&
        typeof input.customerReason === 'string' &&
        input.customerReason.length > 0 &&
        input.customerReason.length <= MAX_OUTCOME_REASON_LENGTH)) &&
    isRecord(args) &&
    Object.keys(args).every((k) =>
      ['folio', 'debtCents', 'reason'].includes(k),
    ) &&
    (args.folio === undefined ||
      (typeof args.folio === 'string' &&
        args.folio.length > 0 &&
        args.folio.length <= MAX_FOLIO_LENGTH)) &&
    (args.debtCents === undefined || isCents(args.debtCents)) &&
    (args.reason === undefined ||
      (typeof args.reason === 'string' &&
        args.reason.length > 0 &&
        args.reason.length <= MAX_OUTCOME_REASON_LENGTH))
  );
};

export class PostgresReceiptMediaStore
  implements ReceiptMediaStorePort, ReceiptOutcomeStore
{
  private readonly logger = new Logger(PostgresReceiptMediaStore.name);

  constructor(private readonly pool: Pool) {}

  private async withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Receipt admission atomically persists the reservation and its inbound
   * marker. A lost receipt-insert race rolls back only the insert, reloads the
   * winner, and converges on the existing closed outcome. Legacy receipt rows
   * remain replay candidates: their marker is backfilled by this transaction.
   * Unrelated constraints still throw. */
  async admit(input: ReserveInput): Promise<ReservationOutcome> {
    return this.withTx(async (c) => {
      const markInboundWebhook = () =>
        c.query(
          `INSERT INTO processed_webhook_messages (message_id)
           VALUES ($1)
           ON CONFLICT (message_id) DO NOTHING`,
          [input.webhookMessageId],
        );
      const hit = await loadHit(c, input);
      if (hit) {
        await markInboundWebhook();
        return classify(hit, input);
      }
      await c.query('SAVEPOINT receipt_admission_insert');
      try {
        const inserted = await c.query<Row>(
          `INSERT INTO receipt_media (id, webhook_message_id, provider_media_id,
             sender_id, captured_sale_id, declared_mime_type,
             declared_amount_cents, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED') RETURNING *`,
          [
            input.id,
            input.webhookMessageId,
            input.providerMediaId,
            input.senderId,
            input.capturedSaleId,
            input.declaredMimeType ?? null,
            input.declaredAmountCents ?? null,
          ],
        );
        await markInboundWebhook();
        return { kind: 'created', receipt: camelize<Media>(inserted.rows[0]) };
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT receipt_admission_insert');
        const winner = await loadHit(c, input);
        if (winner) {
          await markInboundWebhook();
          return classify(winner, input);
        }
        const constraint = (err as { constraint?: string }).constraint;
        if (constraint === 'receipt_media_active_sender_idx') {
          const status = await lookupActiveStatus(
            async (sql, params) =>
              (await c.query<{ status: string }>(sql, params)).rows,
            ACTIVE_SENDER_WINNER_SQL,
            [input.senderId],
          );
          // A vanished winner is never fabricated: rethrow the original
          // conflict with zero mutation.
          if (status === null) throw err;
          return { kind: 'sender-active', status };
        }
        throw err;
      }
    });
  }

  /** Plain status-only read; no lock or transaction. */
  async findActiveBySender(
    input: ActiveSenderIdentity,
  ): Promise<ActiveReceiptStatus | null> {
    return lookupActiveStatus(
      async (sql, params) =>
        (await this.pool.query<{ status: string }>(sql, params)).rows,
      UNRELATED_ACTIVE_SENDER_SQL,
      [input.senderId, input.webhookMessageId, input.providerMediaId],
    );
  }

  /** Owns the single deterministic, row-derived
   * `RECEIPT_UNAVAILABLE_LATER` intent for the locked terminal receipt. Its
   * identity and every column come from the durable row — receipt id,
   * FAILED successor version, stored webhook message, and stored sender —
   * never from the caller. Returns the durable row when this call persists
   * it or when an existing row is structurally exact; null when a
   * rival/foreign intent already owns the deterministic key so the caller
   * rolls back instead of replacing evidence. */
  private async ownUnavailableLaterIntent(
    c: PoolClient,
    receipt: Row,
  ): Promise<Row | null> {
    const receiptId = receipt.id as string;
    const successor = String(receipt.version);
    const webhookMessageId = receipt.webhook_message_id as string;
    const senderId = receipt.sender_id as string;
    const dedupeKey = unavailableLaterIntentKey(
      receiptId,
      successor,
      webhookMessageId,
    );
    const inserted = await c.query<Row>(
      `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
         receipt_state_version, source_webhook_message_id, recipient_id,
         template_key, template_args)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_UNAVAILABLE_LATER', $7::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        dedupeKey,
        receiptId,
        successor,
        webhookMessageId,
        senderId,
        JSON.stringify({}),
      ],
    );
    const owned =
      inserted.rows[0] ??
      (
        await c.query<Row>(
          'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1 FOR UPDATE',
          [dedupeKey],
        )
      ).rows[0];
    return unavailableLaterIntentMatches(
      owned,
      receiptId,
      successor,
      webhookMessageId,
      senderId,
      dedupeKey,
    )
      ? owned
      : null;
  }

  /** ODD-2C terminal replay/legacy repair validation; see
   * META_FAILURE_REPLAY_LOOK_SQL. The exact owned, live-leased terminal
   * successor must prove every deterministic field and cleared superseded
   * evidence; only then is the single row-derived intent owned (repairing
   * an otherwise exact legacy successor missing it). */
  private async replayMetaFailure(
    c: PoolClient,
    current: Row,
    input: MetaFailureDispositionInput,
    successor: string,
  ): Promise<MetaFailureDispositionOutcome> {
    const decision = metaFailureDecision(
      input.category,
      input.code,
      current.meta_attempts as number,
    );
    if (decision === null || decision === 'retry') return { kind: 'fenced' };
    if (
      current.status !== 'FAILED' ||
      current.failure_stage !== decision ||
      String(current.version) !== successor ||
      current.last_error_category !== input.category ||
      current.last_error_code !== input.code ||
      !(current.terminal_at instanceof Date) ||
      current.downloaded_at !== null ||
      current.response_mime_type !== null ||
      current.detected_mime_type !== null ||
      current.byte_count !== null ||
      current.content_sha256 !== null
    )
      return { kind: 'fenced' };
    const intent = await this.ownUnavailableLaterIntent(c, current);
    if (!intent) throw FENCED;
    return {
      kind: 'replayed',
      failureStage: decision,
      version: successor,
      receipt: camelize<Media>(current),
      intent: camelize<ReceiptMediaOutboxRow>(intent),
    };
  }

  /** ODD-2C durable Meta failure disposition; see META_FAILURE_LOOK_SQL,
   * META_RETRY_SQL, and META_TERMINAL_SQL. The caller supplies only the
   * lease/version fence plus the fixed safe category/code; the locked row
   * owns every routing, state, attempt, status, deadline, and intent value.
   * A row already at `meta_attempts = 3` is terminalized through the fixed
   * internal exhaustion code with no fourth Meta call. */
  async commitMetaFailureDisposition(
    input: MetaFailureDispositionInput,
  ): Promise<MetaFailureDispositionOutcome> {
    let successor: string | null;
    try {
      successor = successorVersion(input?.expectedVersion);
    } catch {
      return { kind: 'fenced' };
    }
    if (
      successor === null ||
      typeof input?.id !== 'string' ||
      !UUID.test(input.id) ||
      typeof input?.owner !== 'string' ||
      input.owner.length === 0 ||
      !isMetaFailureCommand(input?.category, input?.code)
    )
      return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const locked = (
          await c.query<Row>(META_FAILURE_LOOK_SQL, [
            input.id,
            input.owner,
            input.expectedVersion,
          ])
        ).rows[0];
        if (!locked) {
          const current = (
            await c.query<Row>(META_FAILURE_REPLAY_LOOK_SQL, [
              input.id,
              input.owner,
            ])
          ).rows[0];
          if (!current) return { kind: 'fenced' };
          return await this.replayMetaFailure(c, current, input, successor);
        }
        const attempts = locked.meta_attempts as number;
        const decision = metaFailureDecision(
          input.category,
          input.code,
          attempts,
        );
        if (decision === null) return { kind: 'fenced' };
        if (decision === 'retry') {
          const updated = await c.query<Row>(META_RETRY_SQL, [
            input.id,
            input.owner,
            input.expectedVersion,
            attempts,
            input.category,
            input.code,
            retryDelayMs(attempts),
          ]);
          if (updated.rowCount !== 1) throw FENCED;
          const receipt = updated.rows[0];
          return {
            kind: 'retry-scheduled',
            attempt: attempts,
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
          };
        }
        const updated = await c.query<Row>(META_TERMINAL_SQL, [
          input.id,
          input.owner,
          input.expectedVersion,
          attempts,
          decision,
          input.category,
          input.code,
        ]);
        if (updated.rowCount !== 1) throw FENCED;
        const receipt = updated.rows[0];
        const intent = await this.ownUnavailableLaterIntent(c, receipt);
        if (!intent) throw FENCED;
        return {
          kind: 'terminal',
          failureStage: decision,
          version: String(receipt.version),
          receipt: camelize<Media>(receipt),
          intent: camelize<ReceiptMediaOutboxRow>(intent),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      if ((err as { code?: string }).code === '22P02')
        return { kind: 'fenced' };
      throw err;
    }
  }

  /** WU2B2A leased claims (RM1, RM3): short CTE transaction with FOR UPDATE
   * SKIP LOCKED, bounded batch, deterministic next_attempt_at/created_at
   * ordering, 60-second lease, and version increment. Eligibility exactly:
   * RESERVED with meta<=3; DOWNLOADED with storage<=MAX_UPLOAD_ATTEMPTS and
   * meta<=3. ODD-2C admits exhausted `meta_attempts = 3` rows only so the
   * processor can terminalize them; a fourth Meta attempt is still refused
   * by `startMetaAttempt`. */
  async claimBatch(limit: number, owner: string): Promise<Media[]> {
    return this.withTx(async (c) => {
      const { rows } = await c.query<Row>(
        `WITH candidate AS (
           SELECT id FROM receipt_media
           WHERE next_attempt_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
             AND ((status = 'RESERVED'
                 AND (meta_attempts < 3 OR meta_attempts = 3))
               OR (status = 'DOWNLOADED'
                 AND storage_attempts <= ${MAX_UPLOAD_ATTEMPTS}
                 AND meta_attempts <= 3))
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE receipt_media r
         SET lease_owner = $2, lease_expires_at = now() + interval '60 seconds',
           version = version + 1, updated_at = now()
         FROM candidate c WHERE r.id = c.id
         RETURNING r.*`,
        [limit, owner],
      );
      return rows
        .map((r) => camelize<Media>(r))
        .sort(
          (a, b) =>
            +a.nextAttemptAt - +b.nextAttemptAt || +a.createdAt - +b.createdAt,
        );
    });
  }

  /** Fenced lease bookkeeping over a live lease (id + owner + expected
   * version); renewal extends, release clears; neither changes the version. */
  private async leaseCas(
    input: LeaseFenceInput,
    sql: string,
  ): Promise<boolean> {
    return this.withTx(async (c) => {
      const { rowCount } = await c.query(sql, [
        input.id,
        input.owner,
        input.expectedVersion,
      ]);
      return rowCount === 1;
    });
  }

  async renewLease(input: LeaseFenceInput): Promise<boolean> {
    return this.leaseCas(input, RENEW_SQL);
  }

  /** WU8R1: one evidence-complete fenced commit. Only a durable successor
   * with the same lease identity and byte-exact evidence is a replay. */
  async commitDownload(
    input: DownloadCommitInput,
  ): Promise<DownloadCommitOutcome> {
    const successor = successorVersion(input.expectedVersion);
    if (!isDownloadInput(input, successor)) return { kind: 'fenced' };
    return this.withTx(async (c) => {
      const params = [
        input.id,
        input.owner,
        input.expectedVersion,
        input.responseMimeType,
        input.detectedMimeType,
        input.byteCount,
        input.contentSha256,
      ];
      const updated = await c.query<Row>(DOWNLOAD_COMMIT_SQL, params);
      if (updated.rowCount === 1) return { kind: 'committed' };
      const current = (
        await c.query<Row>(
          `SELECT status, version, response_mime_type, detected_mime_type,
             byte_count, content_sha256 FROM receipt_media
           WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > now()`,
          [input.id, input.owner],
        )
      ).rows[0];
      return current?.status === 'DOWNLOADED' &&
        current.version === successor &&
        sameDownloadEvidence(current, input)
        ? { kind: 'replayed' }
        : { kind: 'fenced' };
    });
  }

  /** Atomic attempt start: one UPDATE bumps counter + version, fenced by
   * id + owner + version + live lease + allowed status + < 3. */
  private async startAttempt(
    sql: string,
    input: LeaseFenceInput,
    extra: unknown[] = [],
  ): Promise<AttemptStartResult | null> {
    return this.withTx(async (c) => {
      const { rows, rowCount } = await c.query<Row>(sql, [
        input.id,
        input.owner,
        input.expectedVersion,
        ...extra,
      ]);
      return rowCount === 1
        ? {
            attempt: rows[0].attempt as number,
            version: rows[0].version as string,
          }
        : null;
    });
  }

  /** R2: DOWNLOADED → ATTACHED plus the received/in-review intent. The
   * backend accepted the file, so a receipt id we cannot validate is never
   * fenced (the row would sit DOWNLOADED): it is recorded as a terminal
   * ATTACH_OUTCOME_UNKNOWN (`RECEIPT_ID_INVALID`) with the once-only
   * "registering" intent, for reconciliation against the backend. */
  async commitUploadSuccess(
    input: UploadSuccessInput,
  ): Promise<UploadCommitOutcome> {
    if (!isUploadFence(input) || !isUploadTemplateArgs(input.templateArgs))
      return { kind: 'fenced' };
    if (
      typeof input.backendReceiptId !== 'string' ||
      !UUID.test(input.backendReceiptId.toLowerCase())
    )
      return this.commitInvalidReceiptId(input);
    return this.uploadTx(input, async (c, locked) => {
      const receipt = await this.uploadUpdate(c, UPLOAD_SUCCESS_SQL, input, [
        input.backendReceiptId.toLowerCase(),
        input.templateArgs.folio ?? null,
      ]);
      return {
        kind: 'committed',
        attempt: locked.storage_attempts as number,
        receipt: camelize<Media>(receipt),
        intent: await this.uploadIntent(
          c,
          receipt,
          `receipt-upload-received:${input.id}`,
          'RECEIPT_ATTACHED_PENDING',
          input.templateArgs,
        ),
      };
    });
  }

  private async commitInvalidReceiptId(
    input: UploadSuccessInput,
  ): Promise<UploadCommitOutcome> {
    const id: unknown = input.backendReceiptId;
    // Only the shape: the value itself is never logged.
    this.logger.warn(
      `receipt ${input.id}: backend accepted the upload with an invalid receiptId (type=${typeof id}, length=${typeof id === 'string' ? id.length : 'n/a'}); recorded as ATTACH_OUTCOME_UNKNOWN`,
    );
    return this.uploadTx(input, async (c, locked) => {
      const receipt = await this.uploadUpdate(
        c,
        UPLOAD_UNKNOWN_TERMINAL_SQL,
        input,
        [null, RECEIPT_ID_INVALID, RECEIPT_ID_INVALID],
      );
      return {
        kind: 'committed',
        attempt: locked.storage_attempts as number,
        receipt: camelize<Media>(receipt),
        intent: await this.uploadIntent(
          c,
          receipt,
          `receipt-upload-unknown:${input.id}`,
          'RECEIPT_ATTACH_UNKNOWN',
          {},
          true,
        ),
      };
    });
  }

  /** R2: DOWNLOADED → FAILED/ATTACH_DEFINITE plus the refusal intent. */
  async commitUploadDefiniteFailure(
    input: UploadDefiniteFailureInput,
  ): Promise<UploadCommitOutcome> {
    if (
      !isUploadFence(input) ||
      !UPLOAD_DEFINITE_STATUSES.has(input.httpStatus) ||
      !(input.errorCode === null || SAFE_CODE.test(input.errorCode)) ||
      !UPLOAD_DEFINITE_TEMPLATES.has(input.templateKey) ||
      !isUploadTemplateArgs(input.templateArgs)
    )
      return { kind: 'fenced' };
    return this.uploadTx(input, async (c, locked) => {
      const receipt = await this.uploadUpdate(c, UPLOAD_DEFINITE_SQL, input, [
        input.httpStatus,
        input.errorCode,
      ]);
      return {
        kind: 'committed',
        attempt: locked.storage_attempts as number,
        receipt: camelize<Media>(receipt),
        intent: await this.uploadIntent(
          c,
          receipt,
          `receipt-upload-refused:${input.id}`,
          input.templateKey,
          input.templateArgs,
        ),
      };
    });
  }

  /** R2: an unknown outcome retries under the same key until the locked
   * row's `storage_attempts` reaches `MAX_UPLOAD_ATTEMPTS`, then becomes
   * ATTACH_OUTCOME_UNKNOWN. The "registering" intent is keyed by receipt
   * only, so the customer hears it once across every retry. */
  async commitUploadUnknown(
    input: UploadUnknownInput,
  ): Promise<UploadCommitOutcome> {
    const status = input.httpStatus;
    const statusOk =
      status === null ||
      (Number.isInteger(status) &&
        status >= 100 &&
        status <= 599 &&
        (status < 200 || status > 299) &&
        !UPLOAD_DEFINITE_STATUSES.has(status));
    const transportOk =
      input.transportCode === null || SAFE_CODE.test(input.transportCode);
    if (
      !isUploadFence(input) ||
      !statusOk ||
      !transportOk ||
      (status === null) === (input.transportCode === null)
    )
      return { kind: 'fenced' };
    const code = status === null ? input.transportCode! : `HTTP_${status}`;
    return this.uploadTx(input, async (c, locked) => {
      const attempt = locked.storage_attempts as number;
      const terminal = attempt >= MAX_UPLOAD_ATTEMPTS;
      const receipt = terminal
        ? await this.uploadUpdate(c, UPLOAD_UNKNOWN_TERMINAL_SQL, input, [
            status,
            input.transportCode,
            code,
          ])
        : await this.uploadUpdate(c, UPLOAD_RETRY_SQL, input, [
            code,
            uploadRetryDelayMs(Math.max(attempt, 1)),
          ]);
      return {
        kind: terminal ? 'committed' : 'retry-scheduled',
        attempt,
        receipt: camelize<Media>(receipt),
        intent: await this.uploadIntent(
          c,
          receipt,
          `receipt-upload-unknown:${input.id}`,
          'RECEIPT_ATTACH_UNKNOWN',
          {},
          true,
        ),
      };
    });
  }

  /** R2: DOWNLOADED → FAILED (NOT_A_RECEIPT / PDF_ENCRYPTED), no upload. */
  async commitRejectedMedia(
    input: RejectedMediaInput,
  ): Promise<UploadCommitOutcome> {
    if (
      !isUploadFence(input) ||
      !Object.hasOwn(REJECTED_MEDIA_TEMPLATES, input.reason)
    )
      return { kind: 'fenced' };
    return this.uploadTx(input, async (c, locked) => {
      const receipt = await this.uploadUpdate(c, UPLOAD_REJECTED_SQL, input, [
        input.reason,
      ]);
      return {
        kind: 'committed',
        attempt: locked.storage_attempts as number,
        receipt: camelize<Media>(receipt),
        intent: await this.uploadIntent(
          c,
          receipt,
          `receipt-media-rejected:${input.id}`,
          REJECTED_MEDIA_TEMPLATES[input.reason],
          // The not-a-receipt reply names the file kind (image vs PDF).
          input.reason === 'NOT_A_RECEIPT' &&
            locked.detected_mime_type === 'application/pdf'
            ? { mediaKind: 'pdf' }
            : {},
        ),
      };
    });
  }

  /** One transaction over the locked upload row; a missing row fences. */
  private async uploadTx(
    input: LeaseFenceInput,
    fn: (c: PoolClient, locked: Row) => Promise<UploadCommitOutcome>,
  ): Promise<UploadCommitOutcome> {
    try {
      return await this.withTx(async (c) => {
        const locked = (
          await c.query<Row>(UPLOAD_LOCK_SQL, [
            input.id,
            input.owner,
            input.expectedVersion,
          ])
        ).rows[0];
        return locked ? fn(c, locked) : { kind: 'fenced' };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      throw err;
    }
  }

  private async uploadUpdate(
    c: PoolClient,
    sql: string,
    input: LeaseFenceInput,
    params: unknown[],
  ): Promise<Row> {
    const updated = await c.query<Row>(sql, [
      input.id,
      input.owner,
      input.expectedVersion,
      ...params,
    ]);
    if (updated.rowCount !== 1) throw FENCED;
    return updated.rows[0];
  }

  /** Inserts the row-routed intent once per dedupe key. Returns the created
   * intent; an existing one is returned too unless `onceOnly`, in which
   * case a repeat yields null (the customer already heard it). */
  private async uploadIntent(
    c: PoolClient,
    receipt: Row,
    dedupeKey: string,
    templateKey: string,
    templateArgs: UploadTemplateArgs | { mediaKind: 'pdf' },
    onceOnly = false,
  ): Promise<ReceiptMediaOutboxRow | null> {
    const inserted = await c.query<Row>(
      `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
         receipt_state_version, source_webhook_message_id, recipient_id,
         template_key, template_args)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        dedupeKey,
        receipt.id,
        receipt.version,
        receipt.webhook_message_id,
        receipt.sender_id,
        templateKey,
        JSON.stringify(templateArgs),
      ],
    );
    const row = inserted.rows[0];
    if (row) return camelize<ReceiptMediaOutboxRow>(row);
    if (onceOnly) return null;
    const existing = (
      await c.query<Row>(
        'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1',
        [dedupeKey],
      )
    ).rows[0];
    return existing ? camelize<ReceiptMediaOutboxRow>(existing) : null;
  }

  async startMetaAttempt(
    input: LeaseFenceInput,
  ): Promise<AttemptStartResult | null> {
    return this.startAttempt(META_ATTEMPT_SQL, input);
  }

  /** The first attempt's upload fields win: later starts never replace
   * them. */
  async startStorageAttempt(
    input: StorageAttemptInput,
  ): Promise<AttemptStartResult | null> {
    const fields = input.uploadFields;
    if (fields !== undefined && !isRecord(fields)) return null;
    return this.startAttempt(STORAGE_ATTEMPT_SQL, input, [
      fields === undefined ? null : JSON.stringify(fields),
    ]);
  }

  /** R5: due ATTACHED receipts awaiting their human outcome. */
  async listOutcomeDue(
    limit: number,
    policy: ReceiptOutcomePollPolicy,
  ): Promise<ReceiptOutcomeCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const { rows } = await this.pool.query<Row>(OUTCOME_DUE_SQL, [
      limit,
      policy.slowAfterMs,
      policy.slowIntervalMs,
      policy.intervalMs,
    ]);
    return rows.map((r) => ({
      id: r.id as string,
      senderId: r.sender_id as string,
      backendReceiptId: r.backend_receipt_id as string,
      saleFolio: (r.sale_folio as string | null) ?? null,
      attachedAt: r.attached_at as Date,
      outcomePolledAt: (r.outcome_polled_at as Date | null) ?? null,
    }));
  }

  /** R5: stamps a PENDING (or failed) outcome read for the backoff. */
  async markOutcomePolled(id: string): Promise<void> {
    if (typeof id !== 'string' || !UUID.test(id)) return;
    await this.pool.query(OUTCOME_POLLED_SQL, [id]);
  }

  /** R5: one transaction records the outcome, marks it notified and, inside
   * the WhatsApp window, queues the customer text; a second call (race or
   * replay) finds the outcome already recorded and changes nothing. */
  async commitOutcome(
    input: ReceiptOutcomeCommitInput,
  ): Promise<ReceiptOutcomeCommitResult> {
    if (!isOutcomeCommit(input)) return { kind: 'already-notified' };
    return this.withTx(async (c) => {
      const updated = await c.query<Row>(OUTCOME_COMMIT_SQL, [
        input.id,
        input.status,
        input.customerReason,
        input.debtCents,
        input.delivery,
      ]);
      const receipt = updated.rows[0];
      if (!receipt) return { kind: 'already-notified' };
      if (input.delivery === 'OUTSIDE_WINDOW')
        return { kind: 'committed', intent: null };
      const inserted = await c.query<Row>(
        `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
           receipt_state_version, source_webhook_message_id, recipient_id,
           template_key, template_args)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          `receipt-outcome:${input.id}`,
          receipt.id,
          receipt.version,
          receipt.webhook_message_id,
          receipt.sender_id,
          input.templateKey,
          JSON.stringify(input.templateArgs),
        ],
      );
      const row = inserted.rows[0];
      return {
        kind: 'committed',
        intent: row ? camelize<ReceiptMediaOutboxRow>(row) : null,
      };
    });
  }
}
