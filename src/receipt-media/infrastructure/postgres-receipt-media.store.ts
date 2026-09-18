import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { asCanonicalVersion } from '../application/capability.service';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';
import {
  isReceiptAmountPointer,
  type ReceiptAmountPointer,
} from '../../conversation/domain/conversation-store';
import type {
  AmountBootstrapInput,
  AmountBootstrapOutcome,
  AmountProposalInput,
  AmountProposalOutcome,
  AmountRejectionInput,
  AmountRejectionOutcome,
  AttachCommitSuccessInput,
  AttachCommitSuccessOutcome,
  AttachCommitUnknownOutcomeInput,
  AttachCommitUnknownOutcomeOutcome,
  AttachDefiniteFailureInput,
  AttachDefiniteFailureOutcome,
  AttachRequestStartInput,
  AttachRequestStartOutcome,
  AttachStartInput,
  AttachStartOutcome,
  AttemptStartResult,
  CapabilityAccessRow,
  CleanupDispositionInput,
  CleanupDispositionOutcome,
  DownloadCommitInput,
  DownloadCommitOutcome,
  DedupeOutcome,
  LeaseFenceInput,
  MetaFailureDispositionInput,
  MetaFailureDispositionOutcome,
  MetaTerminalFailureStage,
  OutboxIntentInput,
  ReceiptMediaStorePort,
  ReceiptCancellationInput,
  ReceiptCancellationOutcome,
  ReservationOutcome,
  ReserveInput,
  StatusCasInput,
  StorageFailureDispositionInput,
  StorageFailureDispositionOutcome,
} from '../domain/receipt-media-store.port';
import {
  RECEIPT_MAX_BYTES,
  RECEIPT_SHA256_BYTES,
} from '../domain/receipt-media.types';

type Row = Record<string, unknown>;
type Media = ReceiptMediaRow;

const RENEW_SQL = `UPDATE receipt_media SET lease_expires_at = now() + interval '60 seconds',
     updated_at = now()
   WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
     AND lease_expires_at > now()`;

const RELEASE_SQL = `UPDATE receipt_media SET lease_owner = NULL, lease_expires_at = NULL,
     updated_at = now()
   WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
     AND lease_expires_at > now()`;

const CAS_SQL = `UPDATE receipt_media SET status = $5, version = version + 1,
     updated_at = now() WHERE id = $1 AND lease_owner = $2 AND status = $3
     AND version = $4::bigint AND lease_expires_at > now()`;

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
     updated_at = now() WHERE id = $1 AND lease_owner = $2
     AND version = $3::bigint AND lease_expires_at > now()
     AND status = 'DOWNLOADED' AND storage_attempts < 3
     RETURNING storage_attempts AS attempt, version`;

/** WU6B access projection (RMA2, RMA3): exactly the four access columns —
 * no sender, sale, provider, or raw-token data. Parameter-bound equality
 * rides the partial unique capability lookup index. */
const CAPABILITY_LOOKUP_SQL = `SELECT id, object_key, capability_token_hash,
         capability_revoked_at
       FROM receipt_media WHERE capability_token_hash = $1`;

/** WU6C revocation: atomically stamp both timestamps only when the
 * internal id matches, capability evidence exists, and the capability is
 * not already revoked; the predicate re-check under row locking makes a
 * concurrent loser see zero rows (first timestamp preserved). */
const REVOKE_CAPABILITY_SQL = `UPDATE receipt_media
       SET capability_revoked_at = now(), updated_at = now()
       WHERE id = $1 AND capability_token_hash IS NOT NULL
         AND capability_revoked_at IS NULL`;

const ATTACH_REQUEST_START_SQL = `UPDATE receipt_media
           SET attach_request_started_at = now(),
             attach_attempt_id = $4, attach_attempts = attach_attempts + 1,
             version = version + 1, updated_at = now()
           WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
             AND lease_expires_at > now() AND status = 'ATTACHING'
             AND attach_attempts = 0 AND attach_request_started_at IS NULL
             AND attach_attempt_id IS NULL RETURNING *`;

const ATTACH_REQUEST_LOOK_SQL = `SELECT * FROM receipt_media
           WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
             AND lease_expires_at > now() AND status = 'ATTACHING'
             AND attach_attempt_id IS NOT NULL
             AND attach_request_started_at IS NOT NULL`;

const ATTACH_COMMIT_SUCCESS_SQL = `UPDATE receipt_media
           SET status = 'ATTACHED', backend_receipt_id = $5,
             backend_receipt_status = 'PENDING', attached_at = now(),
             version = version + 1, updated_at = now()
           WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
             AND lease_expires_at > clock_timestamp() AND status = 'ATTACHING'
             AND attach_attempts = 1 AND attach_attempt_id = $4
             AND attach_request_started_at IS NOT NULL
             AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
             AND attached_at IS NULL RETURNING *`;

/** WU11A3A: one atomic, parameter-bound fenced UPDATE to FAILED /
 * ATTACH_DEFINITE with the allowlisted HTTP status and terminal_at;
 * observed-at stays null per the schema convention, lease fields are
 * retained per the terminal-transition convention, and no body, auth,
 * URL, capability, or diagnostic PII is ever persisted. ODD-2B2 fences the
 * fresh transition with `clock_timestamp()` so a row-lock wait that
 * outlives the lease cannot commit. */
const ATTACH_DEFINITE_FAILURE_SQL = `UPDATE receipt_media
               SET status = 'FAILED', failure_stage = 'ATTACH_DEFINITE',
                 attach_http_status = $5, terminal_at = now(),
                 version = version + 1, updated_at = now()
               WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
                 AND lease_expires_at > clock_timestamp() AND status = 'ATTACHING'
                 AND attach_attempts = 1 AND attach_attempt_id = $4
                 AND attach_request_started_at IS NOT NULL
                 AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
                 AND attached_at IS NULL AND attach_http_status IS NULL
                 AND attach_transport_code IS NULL
                   AND attach_outcome_observed_at IS NULL RETURNING *`;

/** WU11A3B: one atomic, parameter-bound fenced UPDATE to the terminal
 * ATTACH_OUTCOME_UNKNOWN status with exactly one validated evidence
 * channel; no body, auth, URL, capability, or PII is ever persisted. */
const ATTACH_UNKNOWN_OUTCOME_SQL = `UPDATE receipt_media
      SET status = 'ATTACH_OUTCOME_UNKNOWN', attach_http_status = $5,
        attach_transport_code = $6, attach_outcome_observed_at = now(),
        terminal_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp() AND status = 'ATTACHING'
        AND attach_attempts = 1 AND attach_attempt_id = $4
        AND attach_request_started_at IS NOT NULL
        AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
        AND attached_at IS NULL AND attach_http_status IS NULL
        AND attach_transport_code IS NULL AND attach_outcome_observed_at IS NULL
      RETURNING *`;

/** WU11A3B replay/repair fence: the exact owned, live-leased terminal row
 * read under `clock_timestamp()` and a row lock, so a lease that expires
 * or is released while this transaction waits on a concurrent writer can
 * never authorize a replay or a legacy missing-intent repair. */
const ATTACH_UNKNOWN_REPLAY_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;

/** ODD-2B1 success replay/repair fence: the exact owned, live-leased
 * terminal successor read under `clock_timestamp()` and a row lock, so a
 * lease that expires or is released while this transaction waits on a
 * concurrent writer can never authorize a replay or a legacy
 * missing-intent repair. */
const ATTACH_SUCCESS_REPLAY_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;

/** ODD-2B2 definite-failure replay/repair fence: the exact owned,
 * live-leased terminal successor read under `clock_timestamp()` and a row
 * lock, so a lease that expires or is released while this transaction
 * waits on a concurrent writer can never authorize a replay or a legacy
 * missing-intent repair. */
const ATTACH_DEFINITE_REPLAY_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;

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
        byte_count = NULL, content_sha256 = NULL, stored_at = NULL,
        object_etag = NULL, object_version_id = NULL, capability_token_hash = NULL,
        capability_key_version = NULL, capability_key_version_text = NULL,
        capability_issued_at = NULL, capability_revoked_at = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status IN ('RESERVED', 'DOWNLOADED') AND meta_attempts = $4::int
        AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
        AND attach_http_status IS NULL AND attach_transport_code IS NULL
        AND attach_outcome_observed_at IS NULL RETURNING *`;

/** ODD-2D1 fresh storage disposition lock: the exact owned, live-leased
 * DOWNLOADED row at the caller's expected version read under
 * `clock_timestamp()` and a row lock, so every routing, state, attempt,
 * status, deadline, cleanup-flag, and intent value comes from the durable
 * row and a lease that expires while this transaction waits can never
 * authorize a mutation. */
const STORAGE_FAILURE_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status = 'DOWNLOADED' FOR UPDATE`;

/** ODD-2D1 storage terminal replay/repair fence: the exact owned,
 * live-leased terminal successor read under `clock_timestamp()` and a row
 * lock, so a lease that expires or is released while this transaction waits
 * on a concurrent writer can never authorize a replay or a legacy
 * missing-intent repair. */
const STORAGE_FAILURE_REPLAY_LOOK_SQL = `SELECT * FROM receipt_media
      WHERE id = $1 AND lease_owner = $2
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;

/** ODD-2D1 transient retry schedule: retain the DOWNLOADED status and every
 * required download column, persist only the safe category/code, set the
 * deadline from DB clock time, clear both lease fields, and bump the
 * version; no intent is created. */
const STORAGE_RETRY_SQL = `UPDATE receipt_media
      SET last_error_category = $5, last_error_code = $6,
        next_attempt_at = clock_timestamp() + ($7::int * interval '1 millisecond'),
        lease_owner = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status = 'DOWNLOADED' AND storage_attempts = $4::int
      RETURNING *`;

/** ODD-2D1 permanent/exhausted terminal transition: one atomic, parameter-
 * bound fenced UPDATE to FAILED with the derived failure stage, safe error
 * evidence, the derived cleanup backlog flag, terminal_at, and every
 * accepted-object/capability column cleared. Every required download column
 * is retained — `STORAGE_EXHAUSTED_PRE_ACCEPTANCE` still owns its download
 * evidence. ODD-2D1 fences with `clock_timestamp()` so a row-lock wait that
 * outlives the lease cannot commit. */
const STORAGE_TERMINAL_SQL = `UPDATE receipt_media
      SET status = 'FAILED', failure_stage = $5, last_error_category = $6,
        last_error_code = $7, cleanup_pending = $8::boolean,
        terminal_at = clock_timestamp(), stored_at = NULL,
        object_etag = NULL, object_version_id = NULL,
        capability_token_hash = NULL, capability_key_version = NULL,
        capability_key_version_text = NULL, capability_issued_at = NULL,
        capability_revoked_at = NULL,
        version = version + 1, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
        AND lease_expires_at > clock_timestamp()
        AND status = 'DOWNLOADED' AND storage_attempts = $4::int
        AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
        AND attach_http_status IS NULL AND attach_transport_code IS NULL
        AND attach_outcome_observed_at IS NULL RETURNING *`;

/** ODD-2D2a narrow cleanup claim/start: only `FAILED`
 * `STORAGE_EXHAUSTED_PRE_ACCEPTANCE` rows with `cleanup_pending = true`, a
 * due deadline, no live lease, a backlog/retryable delete error code, and
 * either a remaining logical attempt or an expired reclaimable lease. The
 * logical attempt is row-derived: an initial backlog or lease-cleared row
 * starts the next attempt; an expired non-null lease (attempts 1..3)
 * reclaims the same ambiguous attempt without increment. The exact
 * `OBJECT_STORAGE` category is required together with the allowlisted
 * backlog/retryable delete error code, so a safe-looking code under another
 * category is never claimed. Deterministic `next_attempt_at`/`created_at`
 * order, `FOR UPDATE SKIP LOCKED`, bounded batch, 60-second lease, and a
 * version bump. */
const CLEANUP_CLAIM_SQL = `WITH candidate AS (
     SELECT id FROM receipt_media
     WHERE status = 'FAILED'
       AND failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
       AND cleanup_pending = true
       AND next_attempt_at <= now()
       AND (lease_expires_at IS NULL OR lease_expires_at < now())
       AND last_error_category = 'OBJECT_STORAGE'
       AND last_error_code IN ('CLEANUP_PENDING', 'STORAGE_EXHAUSTED',
         'ABORTED', 'HTTP_RETRYABLE', 'NETWORK_FAILURE')
       AND (cleanup_attempts < 3
         OR (cleanup_attempts = 3 AND lease_expires_at IS NOT NULL))
     ORDER BY next_attempt_at, created_at
     FOR UPDATE SKIP LOCKED LIMIT $1
   )
   UPDATE receipt_media r
   SET cleanup_attempts = CASE
         WHEN r.cleanup_attempts = 0 THEN 1
         WHEN r.lease_expires_at IS NOT NULL THEN r.cleanup_attempts
         ELSE r.cleanup_attempts + 1
       END,
     lease_owner = $2,
     lease_expires_at = now() + interval '60 seconds',
     version = version + 1, updated_at = now()
   FROM candidate c WHERE r.id = c.id
   RETURNING r.*`;

/** ODD-2D2a fresh cleanup disposition lock: the exact owned, live-leased
 * claimed cleanup row at the caller's expected version read under
 * `clock_timestamp()` and a row lock, so the logical attempt and every
 * derived value come from the durable row and a lease that expires while
 * this transaction waits can never authorize a mutation. */
const CLEANUP_DISPOSITION_LOOK_SQL = `SELECT * FROM receipt_media
     WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
       AND lease_expires_at > clock_timestamp() AND status = 'FAILED'
       AND failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
       AND cleanup_pending = true
       AND cleanup_attempts BETWEEN 1 AND 3 FOR UPDATE`;

/** ODD-2D2a idempotent cleanup success: clear the backlog flag and the
 * lease and bump the version while retaining the terminal
 * `FAILED/STORAGE_EXHAUSTED_PRE_ACCEPTANCE` state, download evidence,
 * object key, failure stage, safe error evidence, and the null
 * accepted-object/capability boundary; no intent is created. */
const CLEANUP_SUCCESS_SQL = `UPDATE receipt_media
     SET cleanup_pending = false, lease_owner = NULL, lease_expires_at = NULL,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
       AND lease_expires_at > clock_timestamp() AND status = 'FAILED'
       AND failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
       AND cleanup_pending = true AND cleanup_attempts = $4::int RETURNING *`;

/** ODD-2D2a retryable cleanup failure at attempts 1/2: retain the backlog
 * and every evidence column, persist only the safe category/code, set the
 * deadline from a 1s/4s base with bounded positive jitter, clear both
 * lease fields, and bump the version; no intent is created. */
const CLEANUP_RETRY_SQL = `UPDATE receipt_media
     SET last_error_category = $5, last_error_code = $6,
       next_attempt_at = clock_timestamp() + ($7::int * interval '1 millisecond'),
       lease_owner = NULL, lease_expires_at = NULL,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
       AND lease_expires_at > clock_timestamp() AND status = 'FAILED'
       AND failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
       AND cleanup_pending = true AND cleanup_attempts = $4::int
       AND cleanup_attempts < 3 RETURNING *`;

/** ODD-2D2a manual hold: a permanent delete failure at any attempt or a
 * retryable failure at attempt 3 retains the backlog flag, persists only
 * the safe category/code, clears the lease, and bumps the version without
 * scheduling any automatic eligibility. */
const CLEANUP_HOLD_SQL = `UPDATE receipt_media
     SET last_error_category = $5, last_error_code = $6,
       lease_owner = NULL, lease_expires_at = NULL,
       version = version + 1, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND version = $3::bigint
       AND lease_expires_at > clock_timestamp() AND status = 'FAILED'
       AND failure_stage = 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
       AND cleanup_pending = true AND cleanup_attempts = $4::int RETURNING *`;

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

/** ODD-2D1 fixed storage disposition taxonomy. The retryable transport
 * codes (`ABORTED`, `HTTP_RETRYABLE`, `NETWORK_FAILURE`) schedule attempts
 * 1/2 and terminalize attempt 3; `CLEANUP_PENDING` is the safe cleanup
 * backlog and terminalizes at any attempt with `cleanup_pending = true`;
 * every other allowlisted code is a permanent pre-acceptance failure;
 * `STORAGE_EXHAUSTED` is the fixed internal code for a reclaimed row
 * already at `storage_attempts >= 3` and persists the same conservative
 * `cleanup_pending = true` backlog. */
const STORAGE_RETRYABLE_CODES = new Set<string>([
  'ABORTED',
  'HTTP_RETRYABLE',
  'NETWORK_FAILURE',
]);
const STORAGE_PERMANENT_CODES = new Set<string>([
  'OBJECT_KEY_INVALID',
  'REQUEST_INVALID',
  'RESPONSE_INVALID',
  'HTTP_PERMANENT',
  'PERMANENT_FAILURE',
  'OBJECT_NOT_FOUND',
]);
const STORAGE_CLEANUP_PENDING = 'CLEANUP_PENDING';
const STORAGE_EXHAUSTED = 'STORAGE_EXHAUSTED';

/** The conservative terminal cleanup backlog flag: `CLEANUP_PENDING` is the
 * observed backlog, and the fixed internal exhaustion code is treated the
 * same because a reclaimed attempt-3 row may have uploaded before crashing.
 * Every other terminal code persists no backlog. */
const storageCleanupPending = (code: string): boolean =>
  code === STORAGE_CLEANUP_PENDING || code === STORAGE_EXHAUSTED;

/** The fixed safe storage command taxonomy; unknown category/code pairs
 * never reach the database. */
const isStorageFailureCommand = (category: unknown, code: unknown): boolean =>
  category === 'OBJECT_STORAGE' &&
  typeof code === 'string' &&
  (STORAGE_RETRYABLE_CODES.has(code) ||
    STORAGE_PERMANENT_CODES.has(code) ||
    code === STORAGE_CLEANUP_PENDING ||
    code === STORAGE_EXHAUSTED);

/** Terminal stage for the locked row's fixed disposition, or `retry` for a
 * retryable storage code below the attempt limit; null fences. The internal
 * exhaustion code only terminalizes a genuinely exhausted row. */
const storageFailureDecision = (
  category: string,
  code: string,
  attempts: number,
): 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE' | 'retry' | null => {
  if (category !== 'OBJECT_STORAGE') return null;
  if (code === STORAGE_EXHAUSTED)
    return Number.isInteger(attempts) && attempts >= 3
      ? 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
      : null;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) return null;
  if (code === STORAGE_CLEANUP_PENDING)
    return 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE';
  if (STORAGE_RETRYABLE_CODES.has(code))
    return attempts < 3 ? 'retry' : 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE';
  return STORAGE_PERMANENT_CODES.has(code)
    ? 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE'
    : null;
};

/** ODD-2D2a fixed cleanup technical-delete disposition taxonomy. The three
 * retryable delete codes schedule attempts 1/2 and become a manual hold at
 * attempt 3; the four permanent delete codes are an immediate manual hold
 * at any attempt; every other category/code pair is malformed and never
 * reaches the database. */
const CLEANUP_RETRYABLE_CODES = new Set<string>([
  'ABORTED',
  'HTTP_RETRYABLE',
  'NETWORK_FAILURE',
]);
const CLEANUP_PERMANENT_CODES = new Set<string>([
  'OBJECT_KEY_INVALID',
  'REQUEST_INVALID',
  'HTTP_PERMANENT',
  'PERMANENT_FAILURE',
]);

/** The fixed safe cleanup failure taxonomy; unknown category/code pairs
 * fence without mutation. */
const cleanupFailureCode = (category: unknown, code: unknown): string | null =>
  category === 'OBJECT_STORAGE' &&
  typeof code === 'string' &&
  (CLEANUP_RETRYABLE_CODES.has(code) || CLEANUP_PERMANENT_CODES.has(code))
    ? code
    : null;

/** One validated cleanup command, or null for a malformed caller. The
 * logical attempt, state, and schedule are never caller values. */
type CleanupCommand =
  | { outcome: 'deleted' }
  | { outcome: 'failed'; category: 'OBJECT_STORAGE'; code: string };

const cleanupCommand = (
  input: CleanupDispositionInput,
  successor: string | null,
): CleanupCommand | null => {
  try {
    if (
      successor === null ||
      typeof input !== 'object' ||
      input === null ||
      typeof input.id !== 'string' ||
      !UUID.test(input.id) ||
      typeof input.owner !== 'string' ||
      input.owner.length === 0
    )
      return null;
    const raw = input as {
      outcome?: unknown;
      category?: unknown;
      code?: unknown;
    };
    if (raw.outcome === 'deleted') return { outcome: 'deleted' };
    if (raw.outcome !== 'failed') return null;
    const code = cleanupFailureCode(raw.category, raw.code);
    return code === null
      ? null
      : { outcome: 'failed', category: 'OBJECT_STORAGE', code };
  } catch {
    return null;
  }
};

/** ODD-2D2a fail-closed claim boundary, mirroring the established outbox
 * boundary but robust to forged runtime types: a malformed `limit`/`owner`
 * returns no rows before any SQL. `limit` must be a positive safe integer so
 * `LIMIT NULL` can never widen the batch to every due row, and `owner` must
 * be a bounded 1..100-character string so an empty or non-string owner can
 * never create a lease that `commitCleanupDisposition` refuses. */
const cleanupClaimInputOk = (limit: unknown, owner: unknown): boolean =>
  typeof limit === 'number' &&
  Number.isSafeInteger(limit) &&
  limit > 0 &&
  typeof owner === 'string' &&
  owner.length >= 1 &&
  owner.length <= 100;

/** WU11A3A proven non-committing outcomes: the safe allowlisted statuses. */
const ATTACH_DEFINITE_HTTP_STATUSES = [400, 401, 403, 404, 409, 422, 429];

/** WU11A3B evidence XOR: exactly one safe channel — an integer HTTP status
 * 100..599 outside 2xx and the definite allowlist, or the single generic
 * TRANSPORT_FAILURE code — else null (both/neither/invalid channels). */
const attachUnknownEvidence = (
  httpStatus: number | null | undefined,
  transportCode: string | null | undefined,
): [number | null, string | null] | null => {
  const hasHttp = httpStatus !== undefined && httpStatus !== null;
  const hasTransport = transportCode !== undefined && transportCode !== null;
  if (hasHttp === hasTransport) return null;
  if (hasHttp)
    return typeof httpStatus === 'number' &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599 &&
      !(httpStatus >= 200 && httpStatus <= 299) &&
      !ATTACH_DEFINITE_HTTP_STATUSES.includes(httpStatus)
      ? [httpStatus, null]
      : null;
  return transportCode === 'TRANSPORT_FAILURE' ? [null, transportCode] : null;
};
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
class ProposalFencedError extends Error {}
const FENCED = new ProposalFencedError();

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
      (input.responseMimeType === 'image/jpeg' ||
        input.responseMimeType === 'image/png') &&
      (input.detectedMimeType === 'image/jpeg' ||
        input.detectedMimeType === 'image/png') &&
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

const isBootstrapInput = (
  input: AmountBootstrapInput,
  successor: string | null,
): successor is string => {
  try {
    return (
      successor !== null &&
      typeof input.id === 'string' &&
      UUID.test(input.id) &&
      typeof input.owner === 'string' &&
      input.owner.length > 0 &&
      typeof input.objectEtag === 'string' &&
      input.objectEtag.length > 0 &&
      (input.objectVersionId === null ||
        (typeof input.objectVersionId === 'string' &&
          input.objectVersionId.length > 0)) &&
      ArrayBuffer.isView(input.capabilityTokenHash) &&
      Buffer.isBuffer(input.capabilityTokenHash) &&
      input.capabilityTokenHash.length === RECEIPT_SHA256_BYTES &&
      asCanonicalVersion(input.capabilityKeyVersion) !== null
    );
  } catch {
    return false;
  }
};

const hasDownloadEvidence = (row: Row) =>
  row.downloaded_at instanceof Date &&
  (row.response_mime_type === 'image/jpeg' ||
    row.response_mime_type === 'image/png') &&
  (row.detected_mime_type === 'image/jpeg' ||
    row.detected_mime_type === 'image/png') &&
  Number.isInteger(row.byte_count) &&
  typeof row.byte_count === 'number' &&
  row.byte_count > 0 &&
  row.byte_count <= RECEIPT_MAX_BYTES &&
  Buffer.isBuffer(row.content_sha256) &&
  row.content_sha256.length === RECEIPT_SHA256_BYTES;

/** WU14B-R expand-phase read: canonical text evidence wins; legacy integer
 *  evidence normalizes to its exact int32 canonical string (String() of an
 *  int32-range JS number is lossless — no numeric parsing), so rows written
 *  by old binaries stay replayable. */
const capabilityVersionOf = (row: Row): string | null =>
  typeof row.capability_key_version_text === 'string'
    ? row.capability_key_version_text
    : typeof row.capability_key_version === 'number'
      ? String(row.capability_key_version)
      : null;

/** Lexical int32 compatibility for the legacy channel (WU14B-R): a canonical
 *  decimal string fits the legacy signed int32 column iff it has fewer than
 *  10 digits or, at exactly 10 digits, is lexically ≤ '2147483647'. Pure
 *  string comparison — never numeric parsing. */
const int32CompatibleVersion = (version: string): string | null =>
  version.length < 10 || (version.length === 10 && version <= '2147483647')
    ? version
    : null;

const sameBootstrapEvidence = (row: Row, input: AmountBootstrapInput) =>
  row.stored_at instanceof Date &&
  row.object_etag === input.objectEtag &&
  row.object_version_id === input.objectVersionId &&
  Buffer.isBuffer(row.capability_token_hash) &&
  Buffer.compare(row.capability_token_hash, input.capabilityTokenHash) === 0 &&
  capabilityVersionOf(row) === input.capabilityKeyVersion &&
  row.capability_issued_at instanceof Date &&
  row.capability_revoked_at === null;

const samePointer = (value: unknown, expected: ReceiptAmountPointer) =>
  isReceiptAmountPointer(value) &&
  value.receiptMediaId === expected.receiptMediaId &&
  value.saleId === expected.saleId &&
  value.receiptVersion === expected.receiptVersion;

const isProposalInput = (
  input: AmountProposalInput,
  successor: string | null,
): successor is string =>
  successor !== null &&
  input.expectedReceiptStatus === 'AWAITING_AMOUNT' &&
  typeof input.sourceWebhookMessageId === 'string' &&
  input.sourceWebhookMessageId.length > 0 &&
  typeof input.senderId === 'string' &&
  input.senderId.length > 0 &&
  typeof input.receiptMediaId === 'string' &&
  UUID.test(input.receiptMediaId) &&
  typeof input.capturedSaleId === 'string' &&
  UUID.test(input.capturedSaleId) &&
  isReceiptAmountPointer(input.expectedPointer) &&
  input.expectedPointer.receiptMediaId === input.receiptMediaId &&
  input.expectedPointer.saleId === input.capturedSaleId &&
  input.expectedPointer.receiptVersion === input.expectedReceiptVersion &&
  Number.isInteger(input.cents) &&
  input.cents > 0 &&
  input.cents <= MAX_INT32;

const intentMatches = (
  row: Row | undefined,
  input: AmountProposalInput,
  successor: string,
  dedupeKey: string,
): row is Row =>
  !!row &&
  row.dedupe_key === dedupeKey &&
  row.receipt_media_id === input.receiptMediaId &&
  row.receipt_state_version === successor &&
  row.source_webhook_message_id === input.sourceWebhookMessageId &&
  row.recipient_id === input.senderId &&
  row.template_key === 'RECEIPT_AMOUNT_CONFIRM' &&
  typeof row.template_args === 'object' &&
  row.template_args !== null &&
  Object.keys(row.template_args).length === 1 &&
  (row.template_args as Row).cents === input.cents;

const isRejectionInput = (
  input: AmountRejectionInput,
  successor: string | null,
): successor is string =>
  successor !== null &&
  input.expectedReceiptStatus === 'AWAITING_CONFIRMATION' &&
  typeof input.sourceWebhookMessageId === 'string' &&
  input.sourceWebhookMessageId.length > 0 &&
  typeof input.senderId === 'string' &&
  input.senderId.length > 0 &&
  typeof input.receiptMediaId === 'string' &&
  UUID.test(input.receiptMediaId) &&
  typeof input.capturedSaleId === 'string' &&
  UUID.test(input.capturedSaleId) &&
  isReceiptAmountPointer(input.expectedPointer) &&
  input.expectedPointer.receiptMediaId === input.receiptMediaId &&
  input.expectedPointer.saleId === input.capturedSaleId &&
  input.expectedPointer.receiptVersion === input.expectedReceiptVersion;

const rejectionIntentMatches = (
  row: Row | undefined,
  input: AmountRejectionInput,
  successor: string,
  dedupeKey: string,
): row is Row =>
  !!row &&
  row.dedupe_key === dedupeKey &&
  row.receipt_media_id === input.receiptMediaId &&
  row.receipt_state_version === successor &&
  row.source_webhook_message_id === input.sourceWebhookMessageId &&
  row.recipient_id === input.senderId &&
  row.template_key === 'RECEIPT_AMOUNT_REASK' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 0;

const isCancellationInput = (
  input: ReceiptCancellationInput,
  successor: string | null,
): successor is string =>
  successor !== null &&
  typeof input.sourceWebhookMessageId === 'string' &&
  input.sourceWebhookMessageId.length > 0 &&
  typeof input.senderId === 'string' &&
  input.senderId.length > 0 &&
  typeof input.receiptMediaId === 'string' &&
  UUID.test(input.receiptMediaId) &&
  typeof input.capturedSaleId === 'string' &&
  UUID.test(input.capturedSaleId) &&
  isReceiptAmountPointer(input.expectedPointer) &&
  input.expectedPointer.receiptMediaId === input.receiptMediaId &&
  input.expectedPointer.saleId === input.capturedSaleId &&
  input.expectedPointer.receiptVersion === input.expectedReceiptVersion;

const isAttachStartInput = (
  input: AttachStartInput,
  successor: string | null,
): successor is string =>
  successor !== null &&
  input.expectedReceiptStatus === 'AWAITING_CONFIRMATION' &&
  typeof input.sourceWebhookMessageId === 'string' &&
  input.sourceWebhookMessageId.length > 0 &&
  typeof input.senderId === 'string' &&
  input.senderId.length > 0 &&
  typeof input.receiptMediaId === 'string' &&
  UUID.test(input.receiptMediaId) &&
  typeof input.capturedSaleId === 'string' &&
  UUID.test(input.capturedSaleId) &&
  isReceiptAmountPointer(input.expectedPointer) &&
  input.expectedPointer.receiptMediaId === input.receiptMediaId &&
  input.expectedPointer.saleId === input.capturedSaleId &&
  input.expectedPointer.receiptVersion === input.expectedReceiptVersion;

const amountStateMatches = (row: Row, status: string): boolean =>
  status === 'AWAITING_AMOUNT'
    ? row.declared_amount_cents === null && row.amount_proposed_at === null
    : typeof row.declared_amount_cents === 'number' &&
      Number.isInteger(row.declared_amount_cents) &&
      row.declared_amount_cents > 0 &&
      row.declared_amount_cents <= MAX_INT32 &&
      row.amount_proposed_at instanceof Date;

/** Derives the one active amount phase a row's evidence belongs to; null
 * means the evidence matches neither active state and must fence. */
const activeAmountStatus = (
  row: Row,
): 'AWAITING_AMOUNT' | 'AWAITING_CONFIRMATION' | null =>
  amountStateMatches(row, 'AWAITING_AMOUNT')
    ? 'AWAITING_AMOUNT'
    : amountStateMatches(row, 'AWAITING_CONFIRMATION')
      ? 'AWAITING_CONFIRMATION'
      : null;

const cancellationIntentMatches = (
  row: Row | undefined,
  input: ReceiptCancellationInput,
  successor: string,
  dedupeKey: string,
): row is Row =>
  !!row &&
  row.dedupe_key === dedupeKey &&
  row.receipt_media_id === input.receiptMediaId &&
  row.receipt_state_version === successor &&
  row.source_webhook_message_id === input.sourceWebhookMessageId &&
  row.recipient_id === input.senderId &&
  row.template_key === 'RECEIPT_CANCELLED' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 0;

const attachStartIntentMatches = (
  row: Row | undefined,
  input: AttachStartInput,
  successor: string,
  dedupeKey: string,
): row is Row =>
  !!row &&
  row.dedupe_key === dedupeKey &&
  row.receipt_media_id === input.receiptMediaId &&
  row.receipt_state_version === successor &&
  row.source_webhook_message_id === input.sourceWebhookMessageId &&
  row.recipient_id === input.senderId &&
  row.template_key === 'RECEIPT_IN_PROGRESS' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 0;

/** Row-derived identity of the single unknown-outcome intent: receipt id,
 * terminal successor version, and stored webhook message only — never a
 * caller value, object key, URL, capability, or free text. */
const attachUnknownIntentKey = (
  receiptId: string,
  successor: string,
  webhookMessageId: string,
): string =>
  `receipt-attach-unknown:${receiptId}:${successor}:${webhookMessageId}`;

/** Exact structural ownership proof for the `RECEIPT_ATTACH_UNKNOWN`
 * intent: the deterministic key plus every row-derived column, with the
 * single bounded empty-args shape. */
const attachUnknownIntentMatches = (
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
  row.template_key === 'RECEIPT_ATTACH_UNKNOWN' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 0;

/** Row-derived identity of the single attached-pending intent: receipt id,
 * ATTACHED successor version, and stored webhook message only — never a
 * caller value, object key, URL, capability, or free text. */
const attachSuccessIntentKey = (
  receiptId: string,
  successor: string,
  webhookMessageId: string,
): string =>
  `receipt-attached-pending:${receiptId}:${successor}:${webhookMessageId}`;

/** Exact structural ownership proof for the `RECEIPT_ATTACHED_PENDING`
 * intent: the deterministic key plus every row-derived column, with the
 * single bounded `{ backendStatus: 'PENDING' }` args shape. */
const attachSuccessIntentMatches = (
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
  row.template_key === 'RECEIPT_ATTACHED_PENDING' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 1 &&
  row.template_args.backendStatus === 'PENDING';

/** Row-derived identity of the single definite-failure intent: receipt id,
 * FAILED successor version, and stored webhook message only — never a
 * caller value, object key, URL, capability, or free text. */
const attachDefiniteFailureIntentKey = (
  receiptId: string,
  successor: string,
  webhookMessageId: string,
): string =>
  `receipt-attach-definite-failure:${receiptId}:${successor}:${webhookMessageId}`;

/** Exact structural ownership proof for the
 * `RECEIPT_ATTACH_DEFINITE_FAILURE` intent: the deterministic key plus
 * every row-derived column, with the single bounded empty-args shape. */
const attachDefiniteFailureIntentMatches = (
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
  row.template_key === 'RECEIPT_ATTACH_DEFINITE_FAILURE' &&
  isRecord(row.template_args) &&
  Object.keys(row.template_args).length === 0;

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
    Object.entries(row)
      .filter(([k]) => k !== 'capability_key_version_text')
      .map(([k, v]) => [
        k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        k === 'capability_key_version' ? capabilityVersionOf(row) : v,
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

/** WU2B2A PostgreSQL primitives (RM1, RM3) over the WU2A1/WU2A2A/WU2A2B
 * schema. Every external value is parameter-bound; no caption, URL, token,
 * response body, raw error, or diagnostic PII is persisted. */
export class PostgresReceiptMediaStore implements ReceiptMediaStorePort {
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
             sender_id, captured_sale_id, object_key, declared_mime_type, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED') RETURNING *`,
          [
            input.id,
            input.webhookMessageId,
            input.providerMediaId,
            input.senderId,
            input.capturedSaleId,
            input.objectKey,
            input.declaredMimeType ?? null,
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
        if (constraint === 'receipt_media_active_sender_idx')
          return { kind: 'sender-active' };
        throw err;
      }
    });
  }

  async insertOutboxIntent(input: OutboxIntentInput): Promise<DedupeOutcome> {
    return this.withTx(async (c) => {
      const inserted = await c.query<Row>(
        `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
           receipt_state_version, source_webhook_message_id, recipient_id,
           template_key, template_args)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          input.dedupeKey,
          input.receiptMediaId ?? null,
          input.receiptStateVersion ?? null,
          input.sourceWebhookMessageId,
          input.recipientId,
          input.templateKey,
          JSON.stringify(input.templateArgs ?? {}),
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await c.query<Row>(
            'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1',
            [input.dedupeKey],
          )
        ).rows[0];
      return {
        created: !!inserted.rows[0],
        intent: camelize<ReceiptMediaOutboxRow>(row),
      };
    });
  }

  /** C1: one transaction owns the receipt CAS, structurally exact JSONB
   * pointer successor, and confirmation intent. A replay is conservative: it
   * is returned only while the durable successor pointer remains current. */
  async proposeAmount(
    input: AmountProposalInput,
  ): Promise<AmountProposalOutcome> {
    const successor = successorVersion(input.expectedReceiptVersion);
    if (!isProposalInput(input, successor)) return { kind: 'fenced' };
    const nextPointer = { ...input.expectedPointer, receiptVersion: successor };
    const dedupeKey = `receipt-amount-confirm:${input.receiptMediaId}:${input.expectedReceiptVersion}:${input.sourceWebhookMessageId}`;
    try {
      return await this.withTx(async (c) => {
        const receipt = (
          await c.query<Row>(
            'SELECT * FROM receipt_media WHERE id = $1 FOR UPDATE',
            [input.receiptMediaId],
          )
        ).rows[0];
        const conversation = (
          await c.query<Row>(
            'SELECT data FROM conversation_state WHERE sender_id = $1 FOR UPDATE',
            [input.senderId],
          )
        ).rows[0];
        if (!receipt || !conversation || !isRecord(conversation.data))
          throw FENCED;
        const data = conversation.data;
        const receiptMatches =
          receipt.sender_id === input.senderId &&
          receipt.captured_sale_id === input.capturedSaleId;
        const currentPointer = data.receiptAmountPointer;
        if (
          receiptMatches &&
          receipt.status === 'AWAITING_CONFIRMATION' &&
          receipt.version === successor &&
          receipt.declared_amount_cents === input.cents &&
          receipt.amount_proposed_at !== null &&
          samePointer(currentPointer, nextPointer)
        ) {
          const intent = (
            await c.query<Row>(
              'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1 FOR UPDATE',
              [dedupeKey],
            )
          ).rows[0];
          if (!intentMatches(intent, input, successor, dedupeKey)) throw FENCED;
          return {
            kind: 'replayed',
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        if (
          !receiptMatches ||
          receipt.status !== input.expectedReceiptStatus ||
          receipt.version !== input.expectedReceiptVersion ||
          receipt.declared_amount_cents !== null ||
          !samePointer(currentPointer, input.expectedPointer)
        )
          throw FENCED;
        const updated = await c.query<Row>(
          `UPDATE receipt_media SET status = 'AWAITING_CONFIRMATION',
             declared_amount_cents = $2, amount_proposed_at = now(),
             version = version + 1, updated_at = now()
           WHERE id = $1 AND sender_id = $3 AND captured_sale_id = $4
             AND status = 'AWAITING_AMOUNT' AND version = $5::bigint
             AND declared_amount_cents IS NULL RETURNING *`,
          [
            input.receiptMediaId,
            input.cents,
            input.senderId,
            input.capturedSaleId,
            input.expectedReceiptVersion,
          ],
        );
        if (updated.rowCount !== 1) throw FENCED;
        const pointer = await c.query(
          `UPDATE conversation_state SET data = jsonb_set(data,
             '{receiptAmountPointer}', jsonb_build_object('receiptMediaId', $2::text,
             'saleId', $3::text, 'receiptVersion', $4::text), true)
           WHERE sender_id = $1
             AND jsonb_typeof(data->'receiptAmountPointer') = 'object'
             AND data->'receiptAmountPointer' = jsonb_build_object(
               'receiptMediaId', data->'receiptAmountPointer'->'receiptMediaId',
               'saleId', data->'receiptAmountPointer'->'saleId',
               'receiptVersion', data->'receiptAmountPointer'->'receiptVersion')
             AND jsonb_typeof(data->'receiptAmountPointer'->'receiptMediaId') = 'string'
             AND jsonb_typeof(data->'receiptAmountPointer'->'saleId') = 'string'
             AND jsonb_typeof(data->'receiptAmountPointer'->'receiptVersion') = 'string'
             AND data->'receiptAmountPointer'->>'receiptMediaId' = $2
             AND data->'receiptAmountPointer'->>'saleId' = $3
             AND data->'receiptAmountPointer'->>'receiptVersion' = $5`,
          [
            input.senderId,
            input.receiptMediaId,
            input.capturedSaleId,
            successor,
            input.expectedReceiptVersion,
          ],
        );
        if (pointer.rowCount !== 1) throw FENCED;
        const intent = await c.query<Row>(
          `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
             receipt_state_version, source_webhook_message_id, recipient_id,
             template_key, template_args)
           VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_AMOUNT_CONFIRM', $7::jsonb)
           ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            dedupeKey,
            input.receiptMediaId,
            successor,
            input.sourceWebhookMessageId,
            input.senderId,
            JSON.stringify({ cents: input.cents }),
          ],
        );
        if (intent.rowCount !== 1) throw FENCED;
        return {
          kind: 'proposed',
          receipt: camelize<Media>(updated.rows[0]),
          intent: camelize<ReceiptMediaOutboxRow>(intent.rows[0]),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      throw err;
    }
  }

  /** C2A: one transaction owns the proposed-amount rejection, successor
   * pointer, and reask intent. A replay remains valid only while all three
   * durable successors are exactly current. */
  async rejectProposedAmount(
    input: AmountRejectionInput,
  ): Promise<AmountRejectionOutcome> {
    const successor = successorVersion(input.expectedReceiptVersion);
    if (!isRejectionInput(input, successor)) return { kind: 'fenced' };
    const nextPointer = { ...input.expectedPointer, receiptVersion: successor };
    const dedupeKey = `receipt-amount-reask:${input.receiptMediaId}:${input.expectedReceiptVersion}:${input.sourceWebhookMessageId}`;
    try {
      return await this.withTx(async (c) => {
        const receipt = (
          await c.query<Row>(
            'SELECT * FROM receipt_media WHERE id = $1 FOR UPDATE',
            [input.receiptMediaId],
          )
        ).rows[0];
        const conversation = (
          await c.query<Row>(
            'SELECT data FROM conversation_state WHERE sender_id = $1 FOR UPDATE',
            [input.senderId],
          )
        ).rows[0];
        if (!receipt || !conversation || !isRecord(conversation.data))
          throw FENCED;
        const data = conversation.data;
        const receiptMatches =
          receipt.sender_id === input.senderId &&
          receipt.captured_sale_id === input.capturedSaleId;
        const currentPointer = data.receiptAmountPointer;
        const proposedCents = receipt.declared_amount_cents;
        if (
          receiptMatches &&
          receipt.status === 'AWAITING_AMOUNT' &&
          receipt.version === successor &&
          receipt.declared_amount_cents === null &&
          receipt.amount_proposed_at === null &&
          samePointer(currentPointer, nextPointer)
        ) {
          const intent = (
            await c.query<Row>(
              'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1 FOR UPDATE',
              [dedupeKey],
            )
          ).rows[0];
          if (!rejectionIntentMatches(intent, input, successor, dedupeKey))
            throw FENCED;
          return {
            kind: 'replayed',
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        if (
          !receiptMatches ||
          receipt.status !== input.expectedReceiptStatus ||
          receipt.version !== input.expectedReceiptVersion ||
          !Number.isInteger(proposedCents) ||
          typeof proposedCents !== 'number' ||
          proposedCents <= 0 ||
          proposedCents > MAX_INT32 ||
          receipt.amount_proposed_at === null ||
          !samePointer(currentPointer, input.expectedPointer)
        )
          throw FENCED;
        const updated = await c.query<Row>(
          `UPDATE receipt_media SET status = 'AWAITING_AMOUNT',
                 declared_amount_cents = NULL, amount_proposed_at = NULL,
                 version = version + 1, updated_at = now()
               WHERE id = $1 AND sender_id = $2 AND captured_sale_id = $3
                 AND status = 'AWAITING_CONFIRMATION' AND version = $4::bigint
                 AND declared_amount_cents > 0 AND amount_proposed_at IS NOT NULL
               RETURNING *`,
          [
            input.receiptMediaId,
            input.senderId,
            input.capturedSaleId,
            input.expectedReceiptVersion,
          ],
        );
        if (updated.rowCount !== 1) throw FENCED;
        const pointer = await c.query(
          `UPDATE conversation_state SET data = jsonb_set(data,
                 '{receiptAmountPointer}', jsonb_build_object('receiptMediaId', $2::text,
                 'saleId', $3::text, 'receiptVersion', $4::text), true)
               WHERE sender_id = $1
                 AND jsonb_typeof(data->'receiptAmountPointer') = 'object'
                 AND data->'receiptAmountPointer' = jsonb_build_object(
                   'receiptMediaId', data->'receiptAmountPointer'->'receiptMediaId',
                   'saleId', data->'receiptAmountPointer'->'saleId',
                   'receiptVersion', data->'receiptAmountPointer'->'receiptVersion')
                 AND jsonb_typeof(data->'receiptAmountPointer'->'receiptMediaId') = 'string'
                 AND jsonb_typeof(data->'receiptAmountPointer'->'saleId') = 'string'
                 AND jsonb_typeof(data->'receiptAmountPointer'->'receiptVersion') = 'string'
                 AND data->'receiptAmountPointer'->>'receiptMediaId' = $2
                 AND data->'receiptAmountPointer'->>'saleId' = $3
                 AND data->'receiptAmountPointer'->>'receiptVersion' = $5`,
          [
            input.senderId,
            input.receiptMediaId,
            input.capturedSaleId,
            successor,
            input.expectedReceiptVersion,
          ],
        );
        if (pointer.rowCount !== 1) throw FENCED;
        const intent = await c.query<Row>(
          `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
                 receipt_state_version, source_webhook_message_id, recipient_id,
                 template_key, template_args)
               VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_AMOUNT_REASK', $7::jsonb)
               ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            dedupeKey,
            input.receiptMediaId,
            successor,
            input.sourceWebhookMessageId,
            input.senderId,
            JSON.stringify({}),
          ],
        );
        if (intent.rowCount !== 1) throw FENCED;
        return {
          kind: 'rejected',
          receipt: camelize<Media>(updated.rows[0]),
          intent: camelize<ReceiptMediaOutboxRow>(intent.rows[0]),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      throw err;
    }
  }

  /** One receipt-first transaction atomically cancels whichever active
   * amount flow the locked receipt proves, removes its exact pointer,
   * records the committed intent, and preserves the command needed for
   * conservative replay validation. The caller supplies no phase: the
   * active state is derived inside the transaction and never retried
   * once fenced. */
  async cancelReceipt(
    input: ReceiptCancellationInput,
  ): Promise<ReceiptCancellationOutcome> {
    const successor = successorVersion(input.expectedReceiptVersion);
    if (!isCancellationInput(input, successor)) return { kind: 'fenced' };
    const dedupeKey = `receipt-cancel:${input.receiptMediaId}:${input.expectedReceiptVersion}:${input.sourceWebhookMessageId}`;
    try {
      return await this.withTx(async (c) => {
        const receipt = (
          await c.query<Row>(
            'SELECT * FROM receipt_media WHERE id = $1 FOR UPDATE',
            [input.receiptMediaId],
          )
        ).rows[0];
        const conversation = (
          await c.query<Row>(
            'SELECT data FROM conversation_state WHERE sender_id = $1 FOR UPDATE',
            [input.senderId],
          )
        ).rows[0];
        if (!receipt || !conversation || !isRecord(conversation.data))
          throw FENCED;
        const command = (
          await c.query<Row>(
            `SELECT * FROM receipt_media_cancellation_commands
             WHERE receipt_media_id = $1 FOR UPDATE`,
            [input.receiptMediaId],
          )
        ).rows[0];
        const receiptMatches =
          receipt.sender_id === input.senderId &&
          receipt.captured_sale_id === input.capturedSaleId;
        const cancelledAmountStatus =
          receipt.status === 'CANCELLED' ? activeAmountStatus(receipt) : null;
        const commandMatches =
          !!command &&
          command.receipt_media_id === input.receiptMediaId &&
          command.source_webhook_message_id === input.sourceWebhookMessageId &&
          command.sender_id === input.senderId &&
          command.captured_sale_id === input.capturedSaleId &&
          command.expected_receipt_status === cancelledAmountStatus &&
          command.expected_receipt_version === input.expectedReceiptVersion &&
          command.expected_pointer_receipt_media_id ===
            input.expectedPointer.receiptMediaId &&
          command.expected_pointer_sale_id === input.expectedPointer.saleId &&
          command.expected_pointer_receipt_version ===
            input.expectedPointer.receiptVersion &&
          command.successor_receipt_version === successor;
        if (command) {
          if (
            !commandMatches ||
            !receiptMatches ||
            receipt.status !== 'CANCELLED' ||
            receipt.version !== successor ||
            !(receipt.terminal_at instanceof Date) ||
            Object.prototype.hasOwnProperty.call(
              conversation.data,
              'receiptAmountPointer',
            )
          )
            throw FENCED;
          const intent = (
            await c.query<Row>(
              'SELECT * FROM receipt_media_outbox WHERE id = $1 FOR UPDATE',
              [command.cancellation_outbox_id],
            )
          ).rows[0];
          if (!cancellationIntentMatches(intent, input, successor, dedupeKey))
            throw FENCED;
          return {
            kind: 'replayed',
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        if (
          !receiptMatches ||
          (receipt.status !== 'AWAITING_AMOUNT' &&
            receipt.status !== 'AWAITING_CONFIRMATION') ||
          activeAmountStatus(receipt) !== receipt.status ||
          receipt.version !== input.expectedReceiptVersion ||
          !samePointer(
            conversation.data.receiptAmountPointer,
            input.expectedPointer,
          )
        )
          throw FENCED;
        const activeStatus = receipt.status;
        const updated = await c.query<Row>(
          `UPDATE receipt_media SET status = 'CANCELLED', terminal_at = now(),
             version = version + 1, updated_at = now()
           WHERE id = $1 AND sender_id = $2 AND captured_sale_id = $3
             AND status = $4 AND version = $5::bigint
             AND (($4 = 'AWAITING_AMOUNT' AND declared_amount_cents IS NULL
                   AND amount_proposed_at IS NULL)
               OR ($4 = 'AWAITING_CONFIRMATION' AND declared_amount_cents > 0
                   AND amount_proposed_at IS NOT NULL)) RETURNING *`,
          [
            input.receiptMediaId,
            input.senderId,
            input.capturedSaleId,
            activeStatus,
            input.expectedReceiptVersion,
          ],
        );
        if (updated.rowCount !== 1) throw FENCED;
        const pointer = await c.query(
          `UPDATE conversation_state SET data = data - 'receiptAmountPointer'
           WHERE sender_id = $1
             AND jsonb_typeof(data->'receiptAmountPointer') = 'object'
             AND data->'receiptAmountPointer' = jsonb_build_object(
               'receiptMediaId', data->'receiptAmountPointer'->'receiptMediaId',
               'saleId', data->'receiptAmountPointer'->'saleId',
               'receiptVersion', data->'receiptAmountPointer'->'receiptVersion')
             AND jsonb_typeof(data->'receiptAmountPointer'->'receiptMediaId') = 'string'
             AND jsonb_typeof(data->'receiptAmountPointer'->'saleId') = 'string'
             AND jsonb_typeof(data->'receiptAmountPointer'->'receiptVersion') = 'string'
             AND data->'receiptAmountPointer'->>'receiptMediaId' = $2
             AND data->'receiptAmountPointer'->>'saleId' = $3
             AND data->'receiptAmountPointer'->>'receiptVersion' = $4`,
          [
            input.senderId,
            input.receiptMediaId,
            input.capturedSaleId,
            input.expectedReceiptVersion,
          ],
        );
        if (pointer.rowCount !== 1) throw FENCED;
        const intent = await c.query<Row>(
          `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
             receipt_state_version, source_webhook_message_id, recipient_id,
             template_key, template_args)
           VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_CANCELLED', $7::jsonb)
           ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            dedupeKey,
            input.receiptMediaId,
            successor,
            input.sourceWebhookMessageId,
            input.senderId,
            JSON.stringify({}),
          ],
        );
        if (intent.rowCount !== 1) throw FENCED;
        const provenance = await c.query(
          `INSERT INTO receipt_media_cancellation_commands (
             receipt_media_id, source_webhook_message_id, sender_id,
             captured_sale_id, expected_receipt_status, expected_receipt_version,
             expected_pointer_receipt_media_id, expected_pointer_sale_id,
             expected_pointer_receipt_version, successor_receipt_version,
             cancellation_outbox_id)
           VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9::bigint,
             $10::bigint, $11)`,
          [
            input.receiptMediaId,
            input.sourceWebhookMessageId,
            input.senderId,
            input.capturedSaleId,
            activeStatus,
            input.expectedReceiptVersion,
            input.expectedPointer.receiptMediaId,
            input.expectedPointer.saleId,
            input.expectedPointer.receiptVersion,
            successor,
            intent.rows[0].id,
          ],
        );
        if (provenance.rowCount !== 1) throw FENCED;
        return {
          kind: 'cancelled',
          receipt: camelize<Media>(updated.rows[0]),
          intent: camelize<ReceiptMediaOutboxRow>(intent.rows[0]),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      if (
        (err as { constraint?: string }).constraint ===
        'receipt_media_cancellation_commands_sender_webhook_key'
      )
        return { kind: 'fenced' };
      throw err;
    }
  }

  /** WU10C3A: receipt-first atomic attach start; only the exact durable
   * successor (ATTACHING, retained amount, absent pointer, intent) replays. */
  async startAttachment(input: AttachStartInput): Promise<AttachStartOutcome> {
    const successor = successorVersion(input.expectedReceiptVersion);
    if (!isAttachStartInput(input, successor)) return { kind: 'fenced' };
    const dedupeKey = `receipt-in-progress:${input.receiptMediaId}:${input.expectedReceiptVersion}:${input.sourceWebhookMessageId}`;
    try {
      return await this.withTx(async (c) => {
        const receipt = (
          await c.query<Row>(
            'SELECT * FROM receipt_media WHERE id = $1 FOR UPDATE',
            [input.receiptMediaId],
          )
        ).rows[0];
        const conversation = (
          await c.query<Row>(
            'SELECT data FROM conversation_state WHERE sender_id = $1 FOR UPDATE',
            [input.senderId],
          )
        ).rows[0];
        if (!receipt || !conversation || !isRecord(conversation.data))
          throw FENCED;
        const data = conversation.data;
        const receiptMatches =
          receipt.sender_id === input.senderId &&
          receipt.captured_sale_id === input.capturedSaleId;
        if (
          receiptMatches &&
          receipt.status === 'ATTACHING' &&
          receipt.version === successor &&
          amountStateMatches(receipt, 'AWAITING_CONFIRMATION') &&
          receipt.attach_started_at instanceof Date &&
          receipt.attach_attempts === 0 &&
          receipt.attach_request_started_at === null &&
          receipt.attach_attempt_id === null &&
          !Object.hasOwn(data, 'receiptAmountPointer')
        ) {
          const intent = (
            await c.query<Row>(
              'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1 FOR UPDATE',
              [dedupeKey],
            )
          ).rows[0];
          if (!attachStartIntentMatches(intent, input, successor, dedupeKey))
            throw FENCED;
          return {
            kind: 'replayed',
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        if (
          !receiptMatches ||
          receipt.status !== input.expectedReceiptStatus ||
          receipt.version !== input.expectedReceiptVersion ||
          !amountStateMatches(receipt, input.expectedReceiptStatus) ||
          !samePointer(data.receiptAmountPointer, input.expectedPointer)
        )
          throw FENCED;
        const updated = await c.query<Row>(
          `UPDATE receipt_media SET status = 'ATTACHING',
                 attach_started_at = now(), version = version + 1,
                 updated_at = now()
               WHERE id = $1 AND sender_id = $2 AND captured_sale_id = $3
                 AND status = 'AWAITING_CONFIRMATION' AND version = $4::bigint
                 AND declared_amount_cents > 0 AND amount_proposed_at IS NOT NULL
                 AND attach_attempts = 0 AND attach_request_started_at IS NULL
                 AND attach_attempt_id IS NULL RETURNING *`,
          [
            input.receiptMediaId,
            input.senderId,
            input.capturedSaleId,
            input.expectedReceiptVersion,
          ],
        );
        if (updated.rowCount !== 1) throw FENCED;
        const pointer = await c.query(
          `UPDATE conversation_state SET data = data - 'receiptAmountPointer'
               WHERE sender_id = $1
                 AND jsonb_typeof(data->'receiptAmountPointer') = 'object'
                 AND data->'receiptAmountPointer' = jsonb_build_object(
                   'receiptMediaId', data->'receiptAmountPointer'->'receiptMediaId',
                   'saleId', data->'receiptAmountPointer'->'saleId',
                   'receiptVersion', data->'receiptAmountPointer'->'receiptVersion')
                 AND jsonb_typeof(data->'receiptAmountPointer'->'receiptMediaId') = 'string'
                 AND jsonb_typeof(data->'receiptAmountPointer'->'saleId') = 'string'
                 AND jsonb_typeof(data->'receiptAmountPointer'->'receiptVersion') = 'string'
                 AND data->'receiptAmountPointer'->>'receiptMediaId' = $2
                 AND data->'receiptAmountPointer'->>'saleId' = $3
                 AND data->'receiptAmountPointer'->>'receiptVersion' = $4`,
          [
            input.senderId,
            input.receiptMediaId,
            input.capturedSaleId,
            input.expectedReceiptVersion,
          ],
        );
        if (pointer.rowCount !== 1) throw FENCED;
        const intent = await c.query<Row>(
          `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
                 receipt_state_version, source_webhook_message_id, recipient_id,
                 template_key, template_args)
               VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_IN_PROGRESS', $7::jsonb)
               ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            dedupeKey,
            input.receiptMediaId,
            successor,
            input.sourceWebhookMessageId,
            input.senderId,
            JSON.stringify({}),
          ],
        );
        if (intent.rowCount !== 1) throw FENCED;
        return {
          kind: 'started',
          receipt: camelize<Media>(updated.rows[0]),
          intent: camelize<ReceiptMediaOutboxRow>(intent.rows[0]),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      throw err;
    }
  }

  /** WU11A1: one atomic, parameter-bound fenced UPDATE stamps request
   * evidence exactly when the row is the exact active ATTACHING receipt
   * under the caller's live lease with no prior request evidence; every
   * other caller — including the loser of a concurrent race or an exact
   * repeat — is fenced or surfaces the crash window (never re-POSTs).
   * Unrelated durable fields are never written; DB errors propagate. */
  async startAttachRequest(
    input: AttachRequestStartInput,
  ): Promise<AttachRequestStartOutcome> {
    const evidenceComplete =
      typeof input?.id === 'string' &&
      UUID.test(input.id) &&
      typeof input?.owner === 'string' &&
      input.owner.length > 0 &&
      typeof input?.attachAttemptId === 'string' &&
      UUID.test(input.attachAttemptId) &&
      /^[1-9]\d*(?![\s\S])/.test(String(input?.expectedVersion ?? ''));
    if (!evidenceComplete) return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const updated = await c.query<Row>(ATTACH_REQUEST_START_SQL, [
          input.id,
          input.owner,
          input.expectedVersion,
          input.attachAttemptId,
        ]);
        if (updated.rowCount !== 1) {
          const crashed = (
            await c.query<Row>(ATTACH_REQUEST_LOOK_SQL, [
              input.id,
              input.owner,
              input.expectedVersion,
            ])
          ).rows[0];
          if (crashed)
            return {
              kind: 'crashed-before-post',
              attachAttemptId: crashed.attach_attempt_id as string,
              version: String(crashed.version),
              receipt: camelize<Media>(crashed),
            };
          return { kind: 'fenced' };
        }
        const receipt = updated.rows[0];
        return {
          kind: 'started',
          version: String(receipt.version),
          receipt: camelize<Media>(receipt),
        };
      });
    } catch (err) {
      if (
        typeof (err as { code?: string }).code === 'string' &&
        (err as { code?: string }).code === '22P02'
      )
        return { kind: 'fenced' };
      throw err;
    }
  }

  /** WU11A2: one atomic, parameter-bound fenced UPDATE transitions the exact
   * active ATTACHING row with prior request evidence and the matching
   * durable attach-attempt identity to ATTACHED under the caller's live
   * lease, persisting only backend_receipt_id, the fixed PENDING backend
   * status, and attached_at together with exactly one row-derived
   * deterministic `RECEIPT_ATTACHED_PENDING` intent in the same transaction
   * (ODD-2B1). Only the exact durable successor replaying the exact
   * persisted intent replays (the original stale fence replays too: the
   * same command retried after a crash-after-commit resolves against the
   * same successor); an otherwise exact legacy successor missing only that
   * intent is repaired under the same live-lease fence. A rival terminal
   * successor or a mismatched/foreign intent fences without replacement,
   * rolling back any terminal write. Lease fields are retained per the
   * established terminal-transition convention; no response body, auth,
   * URL, capability, or diagnostic PII is ever persisted; DB errors
   * propagate. */
  async commitAttachSuccess(
    input: AttachCommitSuccessInput,
  ): Promise<AttachCommitSuccessOutcome> {
    const successor = successorVersion(input?.expectedVersion);
    if (
      successor === null ||
      typeof input?.id !== 'string' ||
      !UUID.test(input.id) ||
      typeof input?.owner !== 'string' ||
      input.owner.length === 0 ||
      typeof input?.attachAttemptId !== 'string' ||
      !UUID.test(input.attachAttemptId) ||
      typeof input?.backendReceiptId !== 'string' ||
      !UUID.test(input.backendReceiptId)
    )
      return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const updated = await c.query<Row>(ATTACH_COMMIT_SUCCESS_SQL, [
          input.id,
          input.owner,
          input.expectedVersion,
          input.attachAttemptId,
          input.backendReceiptId,
        ]);
        if (updated.rowCount === 1) {
          const receipt = updated.rows[0];
          const intent = await this.ownAttachSuccessIntent(c, receipt);
          if (!intent) throw FENCED;
          return {
            kind: 'committed',
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        const current = (
          await c.query<Row>(ATTACH_SUCCESS_REPLAY_LOOK_SQL, [
            input.id,
            input.owner,
          ])
        ).rows[0];
        if (
          !(
            current?.status === 'ATTACHED' &&
            String(current.version) === successor &&
            current.attach_attempt_id === input.attachAttemptId &&
            current.backend_receipt_id === input.backendReceiptId &&
            current.backend_receipt_status === 'PENDING' &&
            current.attached_at instanceof Date
          )
        )
          return { kind: 'fenced' };
        const intent = await this.ownAttachSuccessIntent(c, current);
        if (!intent) throw FENCED;
        return {
          kind: 'replayed',
          version: successor,
          receipt: camelize<Media>(current),
          intent: camelize<ReceiptMediaOutboxRow>(intent),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      if (
        typeof (err as { code?: string }).code === 'string' &&
        (err as { code?: string }).code === '22P02'
      )
        return { kind: 'fenced' };
      throw err;
    }
  }

  /** WU11A3A definite-failure terminal commit with ODD-2B2 intent
   * ownership; see ATTACH_DEFINITE_FAILURE_SQL. The terminal transition
   * and its single row-derived `RECEIPT_ATTACH_DEFINITE_FAILURE` intent
   * commit in one transaction; a foreign/rival intent rolls both back and
   * fences. An exact replay must prove the exact persisted intent; a
   * legacy terminal successor missing only that intent is repaired under
   * the same live-lease fence, while rival terminal evidence or a foreign
   * intent fences without replacement. */
  async commitAttachDefiniteFailure(
    input: AttachDefiniteFailureInput,
  ): Promise<AttachDefiniteFailureOutcome> {
    const successor = successorVersion(input?.expectedVersion);
    if (
      successor === null ||
      typeof input?.id !== 'string' ||
      !UUID.test(input.id) ||
      typeof input?.owner !== 'string' ||
      input.owner.length === 0 ||
      typeof input?.attachAttemptId !== 'string' ||
      !UUID.test(input.attachAttemptId) ||
      typeof input?.httpStatus !== 'number' ||
      !Number.isInteger(input.httpStatus) ||
      !ATTACH_DEFINITE_HTTP_STATUSES.includes(input.httpStatus)
    )
      return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const updated = await c.query<Row>(ATTACH_DEFINITE_FAILURE_SQL, [
          input.id,
          input.owner,
          input.expectedVersion,
          input.attachAttemptId,
          input.httpStatus,
        ]);
        if (updated.rowCount === 1) {
          const receipt = updated.rows[0];
          const intent = await this.ownAttachDefiniteFailureIntent(c, receipt);
          if (!intent) throw FENCED;
          return {
            kind: 'failed',
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        const current = (
          await c.query<Row>(ATTACH_DEFINITE_REPLAY_LOOK_SQL, [
            input.id,
            input.owner,
          ])
        ).rows[0];
        if (
          !(
            current?.status === 'FAILED' &&
            current.failure_stage === 'ATTACH_DEFINITE' &&
            String(current.version) === successor &&
            current.attach_attempt_id === input.attachAttemptId &&
            current.attach_http_status === input.httpStatus &&
            current.attach_outcome_observed_at === null &&
            current.terminal_at instanceof Date
          )
        )
          return { kind: 'fenced' };
        const intent = await this.ownAttachDefiniteFailureIntent(c, current);
        if (!intent) throw FENCED;
        return {
          kind: 'replayed',
          version: successor,
          receipt: camelize<Media>(current),
          intent: camelize<ReceiptMediaOutboxRow>(intent),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      if (
        typeof (err as { code?: string }).code === 'string' &&
        (err as { code?: string }).code === '22P02'
      )
        return { kind: 'fenced' };
      throw err;
    }
  }

  /** Owns the single deterministic, row-derived
   * `RECEIPT_ATTACH_DEFINITE_FAILURE` intent for the locked terminal
   * receipt. Its identity and every column come from the durable row —
   * receipt id, FAILED successor version, stored webhook message, and
   * stored sender — never from the caller. Returns the durable row when
   * this call persists it or when an existing row is structurally exact;
   * null when a rival/foreign intent already owns the deterministic key so
   * the caller rolls back instead of replacing evidence. */
  private async ownAttachDefiniteFailureIntent(
    c: PoolClient,
    receipt: Row,
  ): Promise<Row | null> {
    const receiptId = receipt.id as string;
    const successor = String(receipt.version);
    const webhookMessageId = receipt.webhook_message_id as string;
    const senderId = receipt.sender_id as string;
    const dedupeKey = attachDefiniteFailureIntentKey(
      receiptId,
      successor,
      webhookMessageId,
    );
    const inserted = await c.query<Row>(
      `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
         receipt_state_version, source_webhook_message_id, recipient_id,
         template_key, template_args)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_ATTACH_DEFINITE_FAILURE', $7::jsonb)
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
    return attachDefiniteFailureIntentMatches(
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

  /** Owns the single deterministic, row-derived `RECEIPT_ATTACH_UNKNOWN`
   * intent for the locked terminal receipt. Its identity and every column
   * come from the durable row — receipt id, terminal successor version,
   * stored webhook message, and sender — never from the caller. Returns
   * the durable row when this call persists it or when an existing row is
   * structurally exact; null when a rival/foreign intent already owns the
   * deterministic key so the caller rolls back instead of replacing
   * evidence. */
  private async ownAttachUnknownIntent(
    c: PoolClient,
    receipt: Row,
  ): Promise<Row | null> {
    const receiptId = receipt.id as string;
    const successor = String(receipt.version);
    const webhookMessageId = receipt.webhook_message_id as string;
    const senderId = receipt.sender_id as string;
    const dedupeKey = attachUnknownIntentKey(
      receiptId,
      successor,
      webhookMessageId,
    );
    const inserted = await c.query<Row>(
      `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
         receipt_state_version, source_webhook_message_id, recipient_id,
         template_key, template_args)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_ATTACH_UNKNOWN', $7::jsonb)
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
    return attachUnknownIntentMatches(
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

  /** Owns the single deterministic, row-derived `RECEIPT_ATTACHED_PENDING`
   * intent for the locked terminal receipt. Its identity and every column
   * come from the durable row — receipt id, ATTACHED successor version,
   * stored webhook message, stored sender, and the fixed `PENDING` backend
   * status — never from the caller. Returns the durable row when this call
   * persists it or when an existing row is structurally exact; null when a
   * rival/foreign intent already owns the deterministic key so the caller
   * rolls back instead of replacing evidence. */
  private async ownAttachSuccessIntent(
    c: PoolClient,
    receipt: Row,
  ): Promise<Row | null> {
    const receiptId = receipt.id as string;
    const successor = String(receipt.version);
    const webhookMessageId = receipt.webhook_message_id as string;
    const senderId = receipt.sender_id as string;
    const dedupeKey = attachSuccessIntentKey(
      receiptId,
      successor,
      webhookMessageId,
    );
    const inserted = await c.query<Row>(
      `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
         receipt_state_version, source_webhook_message_id, recipient_id,
         template_key, template_args)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_ATTACHED_PENDING', $7::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        dedupeKey,
        receiptId,
        successor,
        webhookMessageId,
        senderId,
        JSON.stringify({ backendStatus: 'PENDING' }),
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
    return attachSuccessIntentMatches(
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

  /** WU11A3B unknown-outcome terminal commit; see
   * ATTACH_UNKNOWN_OUTCOME_SQL and attachUnknownEvidence. The terminal
   * transition and its single row-derived `RECEIPT_ATTACH_UNKNOWN` intent
   * commit in one transaction; a foreign/rival intent rolls both back and
   * fences. An exact replay must prove the exact persisted intent; a legacy
   * terminal successor missing only that intent is repaired under the same
   * live-lease fence, while rival terminal evidence or a foreign intent
   * fences without replacement. */
  async commitAttachUnknownOutcome(
    input: AttachCommitUnknownOutcomeInput,
  ): Promise<AttachCommitUnknownOutcomeOutcome> {
    const successor = successorVersion(input?.expectedVersion);
    const evidence = attachUnknownEvidence(
      input?.httpStatus,
      input?.transportCode,
    );
    if (
      successor === null ||
      typeof input?.id !== 'string' ||
      !UUID.test(input.id) ||
      typeof input?.owner !== 'string' ||
      input.owner.length === 0 ||
      typeof input?.attachAttemptId !== 'string' ||
      !UUID.test(input.attachAttemptId) ||
      evidence === null
    )
      return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const updated = await c.query<Row>(ATTACH_UNKNOWN_OUTCOME_SQL, [
          input.id,
          input.owner,
          input.expectedVersion,
          input.attachAttemptId,
          evidence[0],
          evidence[1],
        ]);
        if (updated.rowCount === 1) {
          const receipt = updated.rows[0];
          const intent = await this.ownAttachUnknownIntent(c, receipt);
          if (!intent) throw FENCED;
          return {
            kind: 'unknown',
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        const current = (
          await c.query<Row>(ATTACH_UNKNOWN_REPLAY_LOOK_SQL, [
            input.id,
            input.owner,
          ])
        ).rows[0];
        if (
          !(
            current?.status === 'ATTACH_OUTCOME_UNKNOWN' &&
            String(current.version) === successor &&
            current.attach_attempt_id === input.attachAttemptId &&
            current.attach_http_status === evidence[0] &&
            current.attach_transport_code === evidence[1] &&
            current.attach_outcome_observed_at instanceof Date &&
            current.terminal_at instanceof Date
          )
        )
          return { kind: 'fenced' };
        const intent = await this.ownAttachUnknownIntent(c, current);
        if (!intent) throw FENCED;
        return {
          kind: 'replayed',
          version: successor,
          receipt: camelize<Media>(current),
          intent: camelize<ReceiptMediaOutboxRow>(intent),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      throw err;
    }
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
      current.content_sha256 !== null ||
      current.stored_at !== null ||
      current.object_etag !== null ||
      current.object_version_id !== null ||
      current.capability_token_hash !== null ||
      current.capability_key_version !== null ||
      current.capability_key_version_text !== null ||
      current.capability_issued_at !== null ||
      current.capability_revoked_at !== null
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

  /** ODD-2D1 storage terminal replay/legacy repair validation; see
   * STORAGE_FAILURE_REPLAY_LOOK_SQL. The exact owned, live-leased terminal
   * successor must prove every deterministic field, retained download
   * evidence (never Meta's cleared-download shape), and cleared
   * accepted-object/capability evidence; only then is the single row-derived
   * intent owned (repairing an otherwise exact legacy successor missing
   * it). */
  private async replayStorageFailure(
    c: PoolClient,
    current: Row,
    input: StorageFailureDispositionInput,
    successor: string,
  ): Promise<StorageFailureDispositionOutcome> {
    const decision = storageFailureDecision(
      input.category,
      input.code,
      current.storage_attempts as number,
    );
    if (decision === null || decision === 'retry') return { kind: 'fenced' };
    if (
      current.status !== 'FAILED' ||
      current.failure_stage !== decision ||
      String(current.version) !== successor ||
      current.last_error_category !== input.category ||
      current.last_error_code !== input.code ||
      !(current.terminal_at instanceof Date) ||
      !hasDownloadEvidence(current) ||
      current.cleanup_pending !== storageCleanupPending(input.code) ||
      current.stored_at !== null ||
      current.object_etag !== null ||
      current.object_version_id !== null ||
      current.capability_token_hash !== null ||
      current.capability_key_version !== null ||
      current.capability_key_version_text !== null ||
      current.capability_issued_at !== null ||
      current.capability_revoked_at !== null ||
      current.backend_receipt_id !== null ||
      current.backend_receipt_status !== null ||
      current.attach_http_status !== null ||
      current.attach_transport_code !== null ||
      current.attach_outcome_observed_at !== null
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

  /** ODD-2D1 durable storage failure disposition; see
   * STORAGE_FAILURE_LOOK_SQL, STORAGE_RETRY_SQL, and STORAGE_TERMINAL_SQL.
   * The caller supplies only the lease/version fence plus the fixed safe
   * category/code; the locked DOWNLOADED row owns every routing, state,
   * attempt, status, deadline, cleanup-flag, and intent value. A row already
   * at `storage_attempts >= 3` is terminalized through the fixed internal
   * exhaustion code with no fourth storage call. */
  async commitStorageFailureDisposition(
    input: StorageFailureDispositionInput,
  ): Promise<StorageFailureDispositionOutcome> {
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
      !isStorageFailureCommand(input?.category, input?.code)
    )
      return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const locked = (
          await c.query<Row>(STORAGE_FAILURE_LOOK_SQL, [
            input.id,
            input.owner,
            input.expectedVersion,
          ])
        ).rows[0];
        if (!locked) {
          const current = (
            await c.query<Row>(STORAGE_FAILURE_REPLAY_LOOK_SQL, [
              input.id,
              input.owner,
            ])
          ).rows[0];
          if (!current) return { kind: 'fenced' };
          return await this.replayStorageFailure(c, current, input, successor);
        }
        const attempts = locked.storage_attempts as number;
        const decision = storageFailureDecision(
          input.category,
          input.code,
          attempts,
        );
        if (decision === null) return { kind: 'fenced' };
        if (decision === 'retry') {
          const updated = await c.query<Row>(STORAGE_RETRY_SQL, [
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
        const updated = await c.query<Row>(STORAGE_TERMINAL_SQL, [
          input.id,
          input.owner,
          input.expectedVersion,
          attempts,
          decision,
          input.category,
          input.code,
          storageCleanupPending(input.code),
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

  /** ODD-2D2a narrow cleanup claim/start; see CLEANUP_CLAIM_SQL. Only
   * durable FAILED/STORAGE_EXHAUSTED_PRE_ACCEPTANCE backlog rows are
   * eligible; the logical attempt is derived inside the locked transaction
   * and the returned rows carry their post-claim attempt. Never claims
   * STORED, generic eligibility, or a fourth logical attempt, and never
   * performs the external delete. */
  async claimCleanupBatch(limit: number, owner: string): Promise<Media[]> {
    if (!cleanupClaimInputOk(limit, owner)) return [];
    return this.withTx(async (c) => {
      const { rows } = await c.query<Row>(CLEANUP_CLAIM_SQL, [limit, owner]);
      return rows
        .map((r) => camelize<Media>(r))
        .sort(
          (a, b) =>
            +a.nextAttemptAt - +b.nextAttemptAt || +a.createdAt - +b.createdAt,
        );
    });
  }

  /** ODD-2D2a fenced cleanup disposition; see CLEANUP_DISPOSITION_LOOK_SQL,
   * CLEANUP_SUCCESS_SQL, CLEANUP_RETRY_SQL, and CLEANUP_HOLD_SQL. The caller
   * supplies only the lease/version fence and, for a failure, the fixed safe
   * category/code; the locked row owns the logical attempt and every derived
   * routing, state, deadline, and backlog value. A permanent failure or a
   * third retryable failure becomes a manual hold with no automatic
   * eligibility, malformed/unknown commands and mismatched fences return
   * `fenced` without mutation, and no intent is ever created. */
  async commitCleanupDisposition(
    input: CleanupDispositionInput,
  ): Promise<CleanupDispositionOutcome> {
    let successor: string | null;
    try {
      successor = successorVersion(input?.expectedVersion);
    } catch {
      return { kind: 'fenced' };
    }
    const command = cleanupCommand(input, successor);
    if (command === null) return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const locked = (
          await c.query<Row>(CLEANUP_DISPOSITION_LOOK_SQL, [
            input.id,
            input.owner,
            input.expectedVersion,
          ])
        ).rows[0];
        if (!locked) return { kind: 'fenced' };
        const attempt = locked.cleanup_attempts as number;
        const params = [input.id, input.owner, input.expectedVersion, attempt];
        if (command.outcome === 'deleted') {
          const updated = await c.query<Row>(CLEANUP_SUCCESS_SQL, params);
          if (updated.rowCount !== 1) throw FENCED;
          const receipt = updated.rows[0];
          return {
            kind: 'cleaned',
            attempt,
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
          };
        }
        const retryable = CLEANUP_RETRYABLE_CODES.has(command.code);
        if (retryable && attempt < 3) {
          const updated = await c.query<Row>(CLEANUP_RETRY_SQL, [
            ...params,
            command.category,
            command.code,
            retryDelayMs(attempt),
          ]);
          if (updated.rowCount !== 1) throw FENCED;
          const receipt = updated.rows[0];
          return {
            kind: 'retry-scheduled',
            attempt,
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
          };
        }
        const updated = await c.query<Row>(CLEANUP_HOLD_SQL, [
          ...params,
          command.category,
          command.code,
        ]);
        if (updated.rowCount !== 1) throw FENCED;
        const receipt = updated.rows[0];
        return {
          kind: 'manual-hold',
          attempt,
          version: String(receipt.version),
          receipt: camelize<Media>(receipt),
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
   * RESERVED with meta<=3; DOWNLOADED with storage<3 and meta<=3; ATTACHING
   * (post-crash included) for fix-forward. ODD-2C admits exhausted
   * `meta_attempts = 3` rows only so the processor can terminalize them; a
   * fourth Meta attempt is still refused by `startMetaAttempt`. STORED rows
   * are held from automatic eligibility — they are durable and retained for
   * separately authorized reconciliation; this worker never claims them
   * automatically. (STORED hold: STORED-1.) */
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
                 AND (storage_attempts < 3 OR storage_attempts = 3)
                 AND (meta_attempts < 3 OR meta_attempts = 3))
               OR (status = 'ATTACHING'))
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

  async releaseLease(input: LeaseFenceInput): Promise<boolean> {
    return this.leaseCas(input, RELEASE_SQL);
  }

  /** WU2B2B fenced status CAS (RM1, RM3): zero-row loser returns false. */
  async transitionStatus(input: StatusCasInput): Promise<boolean> {
    return this.withTx(async (c) => {
      const { rowCount } = await c.query(CAS_SQL, [
        input.id,
        input.owner,
        input.expectedStatus,
        input.expectedVersion,
        input.nextStatus,
      ]);
      return rowCount === 1;
    });
  }

  /** WU8R2: receipt-first atomic accepted-object bootstrap. The receipt owns
   * all routing values; only S3/capability evidence enters this operation. */
  async bootstrapAmount(
    input: AmountBootstrapInput,
  ): Promise<AmountBootstrapOutcome> {
    let successor: string | null;
    try {
      successor = successorVersion(input?.expectedVersion);
    } catch {
      return { kind: 'fenced' };
    }
    if (!isBootstrapInput(input, successor)) return { kind: 'fenced' };
    try {
      return await this.withTx(async (c) => {
        const receipt = (
          await c.query<Row>(
            'SELECT * FROM receipt_media WHERE id = $1 AND lease_owner = $2 FOR UPDATE',
            [input.id, input.owner],
          )
        ).rows[0];
        if (!receipt) throw FENCED;
        const conversation = (
          await c.query<Row>(
            'SELECT data FROM conversation_state WHERE sender_id = $1 FOR UPDATE',
            [receipt.sender_id],
          )
        ).rows[0];
        if (
          !conversation ||
          !isRecord(conversation.data) ||
          !hasDownloadEvidence(receipt)
        )
          throw FENCED;
        const receiptId = receipt.id as string;
        const senderId = receipt.sender_id as string;
        const saleId = receipt.captured_sale_id as string;
        const sourceWebhookMessageId = receipt.webhook_message_id as string;
        const pointer = {
          receiptMediaId: receiptId,
          saleId,
          receiptVersion: successor,
        };
        const dedupeKey = `receipt-amount-prompt:${receiptId}:${input.expectedVersion}:${sourceWebhookMessageId}`;
        if (
          receipt.status === 'AWAITING_AMOUNT' &&
          receipt.version === successor &&
          sameBootstrapEvidence(receipt, input) &&
          samePointer(conversation.data.receiptAmountPointer, pointer)
        ) {
          const intent = (
            await c.query<Row>(
              'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1 FOR UPDATE',
              [dedupeKey],
            )
          ).rows[0];
          if (
            !intent ||
            intent.receipt_media_id !== receipt.id ||
            intent.receipt_state_version !== successor ||
            intent.source_webhook_message_id !== receipt.webhook_message_id ||
            intent.recipient_id !== receipt.sender_id ||
            intent.template_key !== 'RECEIPT_AMOUNT_PROMPT' ||
            !isRecord(intent.template_args) ||
            Object.keys(intent.template_args).length !== 0
          )
            throw FENCED;
          const liveLease = (
            await c.query<Row>(
              `SELECT lease_expires_at > clock_timestamp() AS live
                   FROM receipt_media WHERE id = $1 AND lease_owner = $2`,
              [input.id, input.owner],
            )
          ).rows[0]?.live;
          if (liveLease !== true) throw FENCED;
          return {
            kind: 'replayed',
            receipt: camelize<Media>(receipt),
            intent: camelize<ReceiptMediaOutboxRow>(intent),
          };
        }
        if (
          receipt.status !== 'DOWNLOADED' ||
          receipt.version !== input.expectedVersion ||
          Object.hasOwn(conversation.data, 'receiptAmountPointer') ||
          [
            'stored_at',
            'object_etag',
            'object_version_id',
            'capability_token_hash',
            'capability_key_version',
            'capability_key_version_text',
            'capability_issued_at',
            'capability_revoked_at',
          ].some((key) => receipt[key] !== null)
        )
          throw FENCED;
        const updated = await c.query<Row>(
          `UPDATE receipt_media SET status = 'AWAITING_AMOUNT', stored_at = now(),
             object_etag = $4, object_version_id = $5, capability_token_hash = $6,
             capability_key_version_text = $7, capability_key_version = $8,
             capability_issued_at = now(),
             version = version + 1, updated_at = now()
           WHERE id = $1 AND lease_owner = $2 AND status = 'DOWNLOADED'
             AND version = $3::bigint AND lease_expires_at > clock_timestamp()
             RETURNING *`,
          [
            input.id,
            input.owner,
            input.expectedVersion,
            input.objectEtag,
            input.objectVersionId,
            input.capabilityTokenHash,
            input.capabilityKeyVersion,
            int32CompatibleVersion(input.capabilityKeyVersion),
          ],
        );
        if (updated.rowCount !== 1) throw FENCED;
        const pointerWrite = await c.query(
          `UPDATE conversation_state SET data = jsonb_set(data,
             '{receiptAmountPointer}', jsonb_build_object('receiptMediaId', $2::text,
             'saleId', $3::text, 'receiptVersion', $4::text), true)
           WHERE sender_id = $1 AND NOT (data ? 'receiptAmountPointer')`,
          [receipt.sender_id, receipt.id, receipt.captured_sale_id, successor],
        );
        if (pointerWrite.rowCount !== 1) throw FENCED;
        const intent = await c.query<Row>(
          `INSERT INTO receipt_media_outbox (id, dedupe_key, receipt_media_id,
             receipt_state_version, source_webhook_message_id, recipient_id,
             template_key, template_args)
           VALUES ($1, $2, $3, $4::bigint, $5, $6, 'RECEIPT_AMOUNT_PROMPT', $7::jsonb)
           ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            dedupeKey,
            receiptId,
            successor,
            sourceWebhookMessageId,
            senderId,
            JSON.stringify({}),
          ],
        );
        if (intent.rowCount !== 1) throw FENCED;
        return {
          kind: 'bootstrapped',
          receipt: camelize<Media>(updated.rows[0]),
          intent: camelize<ReceiptMediaOutboxRow>(intent.rows[0]),
        };
      });
    } catch (err) {
      if (err === FENCED) return { kind: 'fenced' };
      throw err;
    }
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
  ): Promise<AttemptStartResult | null> {
    return this.withTx(async (c) => {
      const { rows, rowCount } = await c.query<Row>(sql, [
        input.id,
        input.owner,
        input.expectedVersion,
      ]);
      return rowCount === 1
        ? {
            attempt: rows[0].attempt as number,
            version: rows[0].version as string,
          }
        : null;
    });
  }

  async startMetaAttempt(
    input: LeaseFenceInput,
  ): Promise<AttemptStartResult | null> {
    return this.startAttempt(META_ATTEMPT_SQL, input);
  }

  async startStorageAttempt(
    input: LeaseFenceInput,
  ): Promise<AttemptStartResult | null> {
    return this.startAttempt(STORAGE_ATTEMPT_SQL, input);
  }

  /** WU6B capability access lookup (RMA2, RMA3): a non-32-byte input
   * fails closed to null without a query; unknown and altered hashes
   * match no row and return null. Revoked rows are returned with their
   * revocation timestamp — denial belongs to the later authorization
   * step. Any throw while recognizing the input (a Proxy can pass
   * Buffer.isBuffer while its actual view throws) also fails closed
   * before the query, and the genuine-view `ArrayBuffer.isView` brand
   * check runs FIRST (it reads no attacker property; every Proxy fails
   * it) so no Proxy — including one spoofing `length` — is ever read or
   * bound into the query; database errors still propagate. */
  async lookupByCapabilityHash(
    hash: Buffer,
  ): Promise<CapabilityAccessRow | null> {
    try {
      if (
        !ArrayBuffer.isView(hash) ||
        !Buffer.isBuffer(hash) ||
        hash.length !== RECEIPT_SHA256_BYTES
      )
        return null;
    } catch {
      return null;
    }
    const { rows } = await this.pool.query<Row>(CAPABILITY_LOOKUP_SQL, [hash]);
    const row = rows[0];
    return row
      ? {
          id: row.id as string,
          objectKey: row.object_key as string,
          capabilityTokenHash: row.capability_token_hash as Buffer,
          capabilityRevokedAt:
            (row.capability_revoked_at as Date | null) ?? null,
        }
      : null;
  }

  /** WU6C capability revocation: one static parameter-bound atomic UPDATE
   * keyed by the internal id only. Both timestamps are stamped exactly when
   * the row carries capability evidence and is not already revoked; a
   * zero-row match (unknown id, capability-less row, or an already-revoked
   * row — including the loser of a concurrent race) returns false and
   * touches nothing, preserving the first revocation timestamp. No version,
   * status, object key, hash, or accepted-object evidence column is
   * written; database errors propagate. */
  async revokeCapability(receiptMediaId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(REVOKE_CAPABILITY_SQL, [
      receiptMediaId,
    ]);
    return rowCount === 1;
  }
}
