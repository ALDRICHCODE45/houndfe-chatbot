/** WU2B2A store port (RM1, RM3): reservation, outbox, claim/lease, CAS,
 * and bounded attempt primitives. Conflicts/lost fences return as values
 * (false/null), never thrown. WU6B adds the hash-indexed capability access
 * lookup (RMA2, RMA3); WU10C3A adds the fenced attachment start. */
import type { ReceiptAmountPointer } from '../../conversation/domain/conversation-store';
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

/** A replay proves the exact durable successor; every other loser is fenced. */
export type AttachDefiniteFailureOutcome =
  | {
      kind: 'failed' | 'replayed';
      version: string;
      receipt: ReceiptMediaRow;
    }
  | { kind: 'fenced' };

/** A replay proves the exact durable successor; every other loser is fenced. */
export type AttachCommitSuccessOutcome =
  | {
      kind: 'committed' | 'replayed';
      version: string;
      receipt: ReceiptMediaRow;
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
  capabilityKeyVersion: number;
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
  reserve(input: ReserveInput): Promise<ReservationOutcome>;
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
  /** WU11A2 successful attachment terminal commit: atomically transition
   * the exact active ATTACHING row with prior request evidence and the
   * matching durable attach-attempt identity to ATTACHED under the
   * caller's live lease, persisting only backend_receipt_id, the fixed
   * PENDING backend status, and attached_at. Only the exact durable
   * successor with the same attempt identity, backend evidence, and
   * successor version replays; every other caller is fenced without
   * mutation. */
  commitAttachSuccess(
    input: AttachCommitSuccessInput,
  ): Promise<AttachCommitSuccessOutcome>;
  /** WU11A3A definite attachment failure terminal commit: atomically
   * transition the exact active ATTACHING row with request-start evidence
   * and the matching attempt identity to FAILED under the caller's live
   * lease, persisting only failure_stage = ATTACH_DEFINITE, the safe
   * allowlisted HTTP status, and terminal_at; only the exact durable
   * successor replays; everything else is fenced without mutation. */
  commitAttachDefiniteFailure(
    input: AttachDefiniteFailureInput,
  ): Promise<AttachDefiniteFailureOutcome>;
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
