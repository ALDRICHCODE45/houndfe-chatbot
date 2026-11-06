/** WU2B2A store port (RM1, RM3): reservation, claim/lease and bounded
 * attempt primitives; R2 adds the backend upload commits. Conflicts/lost
 * fences return as values (false/null), never thrown. */
import type { ReceiptUploadFields } from '../../chatbot-api/domain/dtos/receipt-upload.dto';
import type {
  MetaMediaErrorCategory,
  MetaMediaErrorCode,
} from './meta-media.port';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
  ReceiptMediaStatus,
  ReceiptMimeType,
  ReceiptTemplateKey,
} from './receipt-media.types';

export type ReservationOutcome =
  | { kind: 'created'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-replayed'; receipt: ReceiptMediaRow }
  | { kind: 'provider-media-reused'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-media-conflict' }
  | { kind: 'sender-active'; status: ActiveReceiptStatus };

/** The two `receipt_media_active_sender_idx` statuses; a lookup returns one or null. */
export type ActiveReceiptStatus = Extract<
  ReceiptMediaStatus,
  'RESERVED' | 'DOWNLOADED'
>;

/** Overlapping an active row's webhook or provider identity defers to `admit`. */
export interface ActiveSenderIdentity {
  senderId: string;
  webhookMessageId: string;
  providerMediaId: string;
}

export interface ReserveInput {
  id: string;
  webhookMessageId: string;
  providerMediaId: string;
  senderId: string;
  capturedSaleId: string;
  declaredMimeType?: string;
  /** ODD-4A: the bounded, caption-derived declared amount in integer cents
   * (positive, persistable range) or `null`. Raw caption text never crosses
   * this port. */
  declaredAmountCents?: number | null;
}

/** Fixed internal exhaustion code for a reclaimed row already at
 * `meta_attempts = 3`: it terminalizes without a fourth Meta call. */
export const META_EXHAUSTED_CODE = 'META_EXHAUSTED';
export type MetaDispositionCode =
  | MetaMediaErrorCode
  | typeof META_EXHAUSTED_CODE;

/** One immutable pre-storage Meta failure disposition command: the existing
 * lease/version fence plus the fixed safe Meta category/code only. Every
 * routing, state, attempt, status, deadline, and intent value is derived
 * from the locked durable row — never from the caller. */
export interface MetaFailureDispositionInput extends LeaseFenceInput {
  category: MetaMediaErrorCategory;
  code: MetaDispositionCode;
}

/** The two terminal pre-storage failure stages a Meta failure can reach. */
export type MetaTerminalFailureStage =
  | 'MEDIA_VALIDATION_PRE_STORAGE'
  | 'META_EXHAUSTED_PRE_STORAGE';

/** Transient attempts 1/2 schedule a durable retry with no intent;
 * permanent and exhausted outcomes terminalize and own exactly one
 * row-derived deterministic intent; every other caller is fenced. */
export type MetaFailureDispositionOutcome =
  | {
      kind: 'retry-scheduled';
      attempt: number;
      version: string;
      receipt: ReceiptMediaRow;
    }
  | {
      kind: 'terminal' | 'replayed';
      failureStage: MetaTerminalFailureStage;
      version: string;
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** Fence for lease mutations: receipt id, matching lease owner, expected
 * version, and a live lease are all required; a loser never mutates. */
export interface LeaseFenceInput {
  id: string;
  owner: string;
  expectedVersion: string;
}

/** Fenced, evidence-complete RESERVED → DOWNLOADED commit. */
export interface DownloadCommitInput extends LeaseFenceInput {
  responseMimeType: ReceiptMimeType;
  detectedMimeType: ReceiptMimeType;
  byteCount: number;
  contentSha256: Buffer;
}

/** A replay proves the exact durable successor; every other loser is fenced. */
export type DownloadCommitOutcome = {
  kind: 'committed' | 'replayed' | 'fenced';
};

/** Pre-call attempt start: the 1-based attempt and resulting version. */
export interface AttemptStartResult {
  attempt: number;
  version: string;
}

/** Upload attempt start; the first attempt persists the exact upload fields
 * (kept as-is by later starts) so a retry never re-extracts (no drift under
 * one idempotency key). */
export interface StorageAttemptInput extends LeaseFenceInput {
  uploadFields?: ReceiptUploadFields;
}

/** R2 backend upload attempts per receipt (`storage_attempts`), all under
 * the same `X-Idempotency-Key` (the WhatsApp media id). */
export const MAX_UPLOAD_ATTEMPTS = 6;

/** Bounded customer-message arguments for the upload outcome intents. */
export interface UploadTemplateArgs {
  folio?: string;
  /** Present with `totalCents` only when the extracted amount differs. */
  extractedAmountCents?: number;
  totalCents?: number;
}

/** The customer messages a definite (4xx) upload failure can produce. */
export type UploadDefiniteTemplateKey = Extract<
  ReceiptTemplateKey,
  | 'RECEIPT_SALE_ALREADY_PAID'
  | 'RECEIPT_SALE_NOT_PAYABLE'
  | 'RECEIPT_UNSUPPORTED_FORMAT'
  | 'RECEIPT_ATTACH_DEFINITE_FAILURE'
>;

/** DOWNLOADED → ATTACHED with the received/in-review intent (S9). */
export interface UploadSuccessInput extends LeaseFenceInput {
  backendReceiptId: string;
  templateArgs: UploadTemplateArgs;
}

/** DOWNLOADED → FAILED/ATTACH_DEFINITE: the backend refused (4xx). */
export interface UploadDefiniteFailureInput extends LeaseFenceInput {
  httpStatus: number;
  /** Backend `body.error`, persisted as safe evidence; null when absent. */
  errorCode: string | null;
  templateKey: UploadDefiniteTemplateKey;
  templateArgs: UploadTemplateArgs;
}

/** Unknown outcome (timeout, network, 5xx, invalid 201): the store retries
 * below `MAX_UPLOAD_ATTEMPTS` and terminalizes ATTACH_OUTCOME_UNKNOWN at it.
 * The first unknown outcome owns the single "registering" intent. Exactly
 * one evidence channel: a non-2xx HTTP status or a transport code. */
export interface UploadUnknownInput extends LeaseFenceInput {
  httpStatus: number | null;
  transportCode: string | null;
}

/** DOWNLOADED → FAILED without any upload (S8/S9). */
export interface RejectedMediaInput extends LeaseFenceInput {
  reason: 'NOT_A_RECEIPT' | 'PDF_ENCRYPTED';
}

/** `intent` is the customer intent this commit created, or null when the
 * once-only intent already existed (or none applies). */
export type UploadCommitOutcome =
  | {
      kind: 'committed' | 'retry-scheduled';
      attempt: number;
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow | null;
    }
  | { kind: 'fenced' };

export interface ReceiptMediaStorePort {
  /** Atomically commits a receipt reservation and its inbound webhook marker. */
  admit(input: ReserveInput): Promise<ReservationOutcome>;
  /** UNRELATED active receipt status for the sender, or null; overlaps excluded. */
  findActiveBySender(
    input: ActiveSenderIdentity,
  ): Promise<ActiveReceiptStatus | null>;
  /** ODD-2C durable Meta failure disposition (pre-storage): under the
   * caller's exact lease/version fence and a live `clock_timestamp()` lease,
   * the locked RESERVED/DOWNLOADED row with a started Meta attempt decides
   * its own outcome from its stored `meta_attempts`. Transient retryable
   * attempts 1/2 retain the processing status, persist only the safe
   * category/code, set `next_attempt_at` from a documented 1s/4s base with
   * bounded positive jitter, clear both lease fields, bump the version, and
   * return a retry with no intent. Permanent validation/HTTP failures and
   * attempt-3 (or internal `META_EXHAUSTED`) exhaustion atomically set FAILED
   * with `MEDIA_VALIDATION_PRE_STORAGE` / `META_EXHAUSTED_PRE_STORAGE`, clear
   * every superseded download and accepted-object column, and own exactly one
   * row-derived deterministic `RECEIPT_UNAVAILABLE_LATER` intent keyed
   * `receipt-unavailable-later:<receiptId>:<successorVersion>:
   * <storedWebhookMessageId>` with row-derived routing and exactly `{}` args
   * in the same transaction. Only the exact terminal successor replaying the
   * exact persisted intent replays — an otherwise exact legacy successor
   * missing only that intent is repaired under the same live lease — and a
   * mismatched/foreign intent, rival terminal evidence, or lost/expired lease
   * fences without replacement. */
  commitMetaFailureDisposition(
    input: MetaFailureDispositionInput,
  ): Promise<MetaFailureDispositionOutcome>;
  /** Short SKIP LOCKED claim transaction: bounded batch, deterministic
   * next_attempt_at/created_at order, 60-second lease, version increment;
   * ATTACHING rows (post-crash included) are reclaimable for fix-forward. */
  claimBatch(limit: number, owner: string): Promise<ReceiptMediaRow[]>;
  /** Extends a live owned lease (no version change). */
  renewLease(input: LeaseFenceInput): Promise<boolean>;
  /** Atomically persist download evidence while advancing the RESERVED successor. */
  commitDownload(input: DownloadCommitInput): Promise<DownloadCommitOutcome>;
  /** Atomic pre-call Meta attempt start (max 3); loser null. */
  startMetaAttempt(input: LeaseFenceInput): Promise<AttemptStartResult | null>;
  /** R2: commit a successful backend upload. */
  commitUploadSuccess(input: UploadSuccessInput): Promise<UploadCommitOutcome>;
  /** R2: commit a definite (4xx) backend refusal. */
  commitUploadDefiniteFailure(
    input: UploadDefiniteFailureInput,
  ): Promise<UploadCommitOutcome>;
  /** R2: schedule a same-key retry, or terminalize the unknown outcome. */
  commitUploadUnknown(input: UploadUnknownInput): Promise<UploadCommitOutcome>;
  /** R2: refuse a downloaded file that must not be uploaded. */
  commitRejectedMedia(input: RejectedMediaInput): Promise<UploadCommitOutcome>;
  /** Atomic pre-call backend upload attempt start (max
   * `MAX_UPLOAD_ATTEMPTS`); loser null. */
  startStorageAttempt(
    input: StorageAttemptInput,
  ): Promise<AttemptStartResult | null>;
}
