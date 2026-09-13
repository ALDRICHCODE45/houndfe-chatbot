/** WU2B2A store port (RM1, RM3): reservation, outbox, claim/lease, CAS,
 * and bounded attempt primitives. Conflicts/lost fences return as values
 * (false/null), never thrown. WU6B adds the hash-indexed capability access
 * lookup (RMA2, RMA3). */
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

/** One immutable cancellation command for an active receipt amount flow. */
export interface ReceiptCancellationInput {
  sourceWebhookMessageId: string;
  senderId: string;
  receiptMediaId: string;
  capturedSaleId: string;
  expectedReceiptStatus: 'AWAITING_AMOUNT' | 'AWAITING_CONFIRMATION';
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
  /** Short SKIP LOCKED claim transaction: bounded batch, deterministic
   * next_attempt_at/created_at order, 60-second lease, version increment. */
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
