/** WU2B2A store port (RM1, RM3): reservation, outbox, claim/lease, CAS,
 * and bounded attempt primitives. Conflicts/lost fences return as values
 * (false/null), never thrown. WU6B adds the hash-indexed capability access
 * lookup (RMA2, RMA3); WU10C3A adds the fenced attachment start. */
import type { ReceiptAmountPointer } from '../../conversation/domain/conversation-store';
import type {
  MetaMediaErrorCategory,
  MetaMediaErrorCode,
} from './meta-media.port';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
  ReceiptMediaStatus,
  ReceiptTemplateKey,
} from './receipt-media.types';

export type ReservationOutcome =
  | { kind: 'created'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-replayed'; receipt: ReceiptMediaRow }
  | { kind: 'provider-media-reused'; receipt: ReceiptMediaRow }
  | { kind: 'webhook-media-conflict' }
  | { kind: 'sender-active' };

export interface ReserveInput {
  id: string;
  webhookMessageId: string;
  providerMediaId: string;
  senderId: string;
  capturedSaleId: string;
  objectKey: string;
  declaredMimeType?: string;
}

export interface OutboxIntentInput {
  dedupeKey: string;
  receiptMediaId?: string | null;
  receiptStateVersion?: string | null;
  sourceWebhookMessageId: string;
  recipientId: string;
  templateKey: ReceiptTemplateKey;
  templateArgs?: Record<string, number | 'PENDING'>;
}

export type DedupeOutcome = { created: boolean; intent: ReceiptMediaOutboxRow };

/** One immutable inbound amount command. The stored receipt remains the source
 * of truth for sender, sale, status, and prior version. */
export interface AmountProposalInput {
  sourceWebhookMessageId: string;
  senderId: string;
  receiptMediaId: string;
  capturedSaleId: string;
  expectedReceiptStatus: 'AWAITING_AMOUNT';
  expectedReceiptVersion: string;
  expectedPointer: ReceiptAmountPointer;
  cents: number;
}

export type AmountProposalOutcome =
  | {
      kind: 'proposed' | 'replayed';
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** One immutable amount-rejection command for the currently proposed amount. */
export interface AmountRejectionInput {
  sourceWebhookMessageId: string;
  senderId: string;
  receiptMediaId: string;
  capturedSaleId: string;
  expectedReceiptStatus: 'AWAITING_CONFIRMATION';
  expectedReceiptVersion: string;
  expectedPointer: ReceiptAmountPointer;
}

export type AmountRejectionOutcome =
  | {
      kind: 'rejected' | 'replayed';
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** One immutable cancellation command for an active receipt amount flow.
 * The caller never selects the phase: the store derives and validates the
 * active amount state (AWAITING_AMOUNT or AWAITING_CONFIRMATION) inside
 * its locked transaction; every other state is fenced. */
export interface ReceiptCancellationInput {
  sourceWebhookMessageId: string;
  senderId: string;
  receiptMediaId: string;
  capturedSaleId: string;
  expectedReceiptVersion: string;
  expectedPointer: ReceiptAmountPointer;
}

export type ReceiptCancellationOutcome =
  | {
      kind: 'cancelled' | 'replayed';
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** One immutable attachment-start command for a confirmed amount. */
export interface AttachStartInput {
  sourceWebhookMessageId: string;
  senderId: string;
  receiptMediaId: string;
  capturedSaleId: string;
  expectedReceiptStatus: 'AWAITING_CONFIRMATION';
  expectedReceiptVersion: string;
  expectedPointer: ReceiptAmountPointer;
}

export type AttachStartOutcome =
  | {
      kind: 'started' | 'replayed';
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** One immutable pre-request evidence command for the exact active
 * ATTACHING receipt. The caller supplies only the fresh request UUID;
 * every fence comes from the durable row. */
export interface AttachRequestStartInput extends LeaseFenceInput {
  attachAttemptId: string;
}

/** One winner; everyone else — including a lease-fence holder over
 * already-persisted request evidence — is non-POST (never re-POSTs). */
export type AttachRequestStartOutcome =
  | { kind: 'started'; version: string; receipt: ReceiptMediaRow }
  | {
      kind: 'crashed-before-post';
      attachAttemptId: string;
      version: string;
      receipt: ReceiptMediaRow;
    }
  | { kind: 'fenced' };

/** One immutable successful-attachment terminal command for the exact active
 * ATTACHING receipt that already carries request-start evidence. The caller
 * supplies only the durable attach-attempt identity it started and the safe
 * backend receipt id; the backend status is fixed to PENDING and the store
 * stamps attached_at itself. */
export interface AttachCommitSuccessInput extends LeaseFenceInput {
  attachAttemptId: string;
  backendReceiptId: string;
}

/** One immutable definite-attachment-failure terminal command for the exact
 * active ATTACHING receipt with request-start evidence: the durable
 * attach-attempt identity plus a proven allowlisted backend HTTP status
 * (400/401/403/404/409/422/429). */
export interface AttachDefiniteFailureInput extends LeaseFenceInput {
  attachAttemptId: string;
  httpStatus: number;
}

/** A replay proves the exact durable successor and its exact row-derived
 * `RECEIPT_ATTACH_DEFINITE_FAILURE` intent; every other loser is fenced.
 * Every non-fenced outcome carries the one persisted intent. */
export type AttachDefiniteFailureOutcome =
  | {
      kind: 'failed' | 'replayed';
      version: string;
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** One immutable unknown-outcome attachment terminal command: the durable
 * attach-attempt identity plus exactly one safe evidence channel — an
 * integer HTTP status 100..599 outside 2xx and the definite allowlist, or
 * the single generic transport code 'TRANSPORT_FAILURE'. */
export interface AttachCommitUnknownOutcomeInput extends LeaseFenceInput {
  attachAttemptId: string;
  httpStatus?: number | null;
  transportCode?: string | null;
}

/** A replay proves the exact durable successor and its exact row-derived
 * `RECEIPT_ATTACH_UNKNOWN` intent — safely repairing a legacy successor
 * that is missing only that deterministic intent under the same
 * live-lease fence; every other loser is fenced. Every non-fenced outcome
 * carries the one persisted intent. */
export type AttachCommitUnknownOutcomeOutcome =
  | {
      kind: 'unknown' | 'replayed';
      version: string;
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** A replay proves the exact durable successor and its exact row-derived
 * `RECEIPT_ATTACHED_PENDING` intent; every other loser is fenced. Every
 * non-fenced outcome carries the one persisted intent. */
export type AttachCommitSuccessOutcome =
  | {
      kind: 'committed' | 'replayed';
      version: string;
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

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

/** CAS fence: id + matching owner + expected status/version + live lease. */
export interface StatusCasInput {
  id: string;
  owner: string;
  expectedStatus: ReceiptMediaStatus;
  expectedVersion: string;
  nextStatus: ReceiptMediaStatus;
}

/** Fenced, evidence-complete RESERVED → DOWNLOADED commit. */
export interface DownloadCommitInput extends LeaseFenceInput {
  responseMimeType: 'image/jpeg' | 'image/png';
  detectedMimeType: 'image/jpeg' | 'image/png';
  byteCount: number;
  contentSha256: Buffer;
}

/** A replay proves the exact durable successor; every other loser is fenced. */
export type DownloadCommitOutcome = {
  kind: 'committed' | 'replayed' | 'fenced';
};

/** Fenced DOWNLOADED → AWAITING_AMOUNT bootstrap input. Capability evidence is
 * hash-only; receipt-owned sender, sale, webhook, and pointer are derived. */
export interface AmountBootstrapInput extends LeaseFenceInput {
  objectEtag: string;
  objectVersionId: string | null;
  capabilityTokenHash: Buffer;
  /** Canonical positive decimal string (`^[1-9][0-9]*$`), arbitrary
   *  magnitude (WU14B); never numeric or bigint. */
  capabilityKeyVersion: string;
}

export type AmountBootstrapOutcome =
  | {
      kind: 'bootstrapped' | 'replayed';
      receipt: ReceiptMediaRow;
      intent: ReceiptMediaOutboxRow;
    }
  | { kind: 'fenced' };

/** Pre-call attempt start: the 1-based attempt and resulting version. */
export interface AttemptStartResult {
  attempt: number;
  version: string;
}

/** WU6B minimal access projection for the capability lookup path: exactly
 * the receipt id, opaque object key, stored capability token hash, and
 * revocation timestamp. No sender, sale, provider, or raw-token data
 * crosses the port; a later authorization step consumes the stored hash
 * and revocation timestamp. */
export interface CapabilityAccessRow {
  id: string;
  objectKey: string;
  capabilityTokenHash: Buffer;
  capabilityRevokedAt: Date | null;
}

export interface ReceiptMediaStorePort {
  /** Atomically commits a receipt reservation and its inbound webhook marker. */
  admit(input: ReserveInput): Promise<ReservationOutcome>;
  insertOutboxIntent(input: OutboxIntentInput): Promise<DedupeOutcome>;
  /** Atomically persist one amount proposal, successor pointer, and intent. */
  proposeAmount(input: AmountProposalInput): Promise<AmountProposalOutcome>;
  /** Atomically clear a proposed amount, advance the pointer, and insert a reask intent. */
  rejectProposedAmount(
    input: AmountRejectionInput,
  ): Promise<AmountRejectionOutcome>;
  /** Atomically cancel an active amount flow and persist command provenance. */
  cancelReceipt(
    input: ReceiptCancellationInput,
  ): Promise<ReceiptCancellationOutcome>;
  /** Atomically start the attachment (AWAITING_CONFIRMATION → ATTACHING),
   * clear the exact pointer, and insert the in-progress intent. */
  startAttachment(input: AttachStartInput): Promise<AttachStartOutcome>;
  /** WU11A1 pre-request evidence: atomically stamp
   * attach_request_started_at, persist the request UUID, and increment
   * attach_attempts exactly once. Losers return fenced and never
   * authorize another POST; a live-lease holder over persisted request
   * evidence (crash before POST) gets the non-POST recovery outcome
   * carrying the durable attempt identity. */
  startAttachRequest(
    input: AttachRequestStartInput,
  ): Promise<AttachRequestStartOutcome>;
  /** WU11A2 successful attachment terminal commit (ODD-2B1: intent
   * ownership): atomically transition the exact active ATTACHING row with
   * prior request evidence and the matching durable attach-attempt
   * identity to ATTACHED under the caller's live lease, persisting only
   * backend_receipt_id, the fixed PENDING backend status, and attached_at
   * together with exactly one row-derived deterministic
   * `RECEIPT_ATTACHED_PENDING` intent in the same transaction. The intent
   * identity is `receipt-attached-pending:<receiptId>:<successorVersion>:
   * <storedWebhookMessageId>` with row-derived receipt/sender and exactly
   * `{ backendStatus: 'PENDING' }` args — never a caller value. Only the
   * exact durable successor replaying the exact persisted intent is
   * replayed — an otherwise exact legacy successor missing only that
   * intent is repaired under the same live-lease fence — and a
   * mismatched/foreign intent or rival terminal evidence fences without
   * replacement, rolling back any terminal write. */
  commitAttachSuccess(
    input: AttachCommitSuccessInput,
  ): Promise<AttachCommitSuccessOutcome>;
  /** WU11A3A definite attachment failure terminal commit (ODD-2B2: intent
   * ownership): atomically transition the exact active ATTACHING row with
   * request-start evidence and the matching attempt identity to FAILED under
   * the caller's live lease fenced with `clock_timestamp()`, persisting only
   * failure_stage = ATTACH_DEFINITE, the safe allowlisted HTTP status, and
   * terminal_at together with exactly one row-derived deterministic
   * `RECEIPT_ATTACH_DEFINITE_FAILURE` intent in the same transaction. The
   * intent identity is `receipt-attach-definite-failure:<receiptId>:
   * <successorVersion>:<storedWebhookMessageId>` with row-derived
   * receipt/sender and exactly `{}` args — never a caller value. Only the
   * exact durable successor replaying the exact persisted intent is
   * replayed — an otherwise exact legacy successor missing only that intent
   * is repaired under the exact original command, owner, and a live lease
   * proven with `clock_timestamp()` plus `FOR UPDATE` — and a
   * mismatched/foreign intent or rival terminal evidence fences without
   * replacement, rolling back any terminal write. */
  commitAttachDefiniteFailure(
    input: AttachDefiniteFailureInput,
  ): Promise<AttachDefiniteFailureOutcome>;
  /** WU11A3B unknown-outcome terminal commit: atomically transition the
   * exact active ATTACHING row with request-start evidence and the matching
   * attempt identity to ATTACH_OUTCOME_UNKNOWN under the caller's live
   * lease, persisting exactly one safe evidence channel plus
   * attach_outcome_observed_at and terminal_at together with exactly one
   * row-derived deterministic `RECEIPT_ATTACH_UNKNOWN` intent in the same
   * transaction; only the exact durable successor replaying the exact
   * persisted intent is replayed — an otherwise exact legacy successor
   * missing only that intent is repaired under the same live-lease fence —
   * and mismatched/foreign intent or rival evidence fences without
   * replacement. */
  commitAttachUnknownOutcome(
    input: AttachCommitUnknownOutcomeInput,
  ): Promise<AttachCommitUnknownOutcomeOutcome>;
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
  /** Clears a live owned lease (no version change). */
  releaseLease(input: LeaseFenceInput): Promise<boolean>;
  /** Fenced status CAS: sets next status, bumps version; loser false. */
  transitionStatus(input: StatusCasInput): Promise<boolean>;
  /** Atomically persist download evidence while advancing the RESERVED successor. */
  commitDownload(input: DownloadCommitInput): Promise<DownloadCommitOutcome>;
  /** Atomically store accepted object/capability evidence, create the initial
   * pointer and deterministic empty amount prompt from the locked receipt. */
  bootstrapAmount(input: AmountBootstrapInput): Promise<AmountBootstrapOutcome>;
  /** Atomic pre-call Meta attempt start (max 3); loser null. */
  startMetaAttempt(input: LeaseFenceInput): Promise<AttemptStartResult | null>;
  /** Atomic pre-call storage attempt start (max 3); loser null. */
  startStorageAttempt(
    input: LeaseFenceInput,
  ): Promise<AttemptStartResult | null>;

  /** WU6B capability access lookup (RMA2, RMA3): parameter-bound equality
   * over the partial unique capability index. Null for unknown or altered
   * hashes; revoked rows are returned with their timestamp so later
   * authorization denies them. */
  lookupByCapabilityHash(hash: Buffer): Promise<CapabilityAccessRow | null>;

  /** WU6C capability revocation (store-only mutation): one atomic,
   * parameter-bound UPDATE stamping capability_revoked_at (and
   * updated_at) for the row with this internal id — only when capability
   * evidence exists and the capability is not already revoked. True for
   * the single winning mutation; false for unknown ids, capability-less
   * rows, and already-revoked rows. Concurrent calls yield exactly one
   * true, preserving the first revocation timestamp. Lifecycle version,
   * status, object key, hash, and accepted-object evidence are never
   * written; database errors propagate. */
  revokeCapability(receiptMediaId: string): Promise<boolean>;
}
