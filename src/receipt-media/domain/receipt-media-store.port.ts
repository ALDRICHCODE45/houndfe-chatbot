/** WU2B2A store port (RM1, RM3): reservation, outbox, claim/lease, CAS,
 * and bounded attempt primitives. Conflicts/lost fences return as values
 * (false/null), never thrown. WU6B adds the hash-indexed capability access
 * lookup (RMA2, RMA3). */
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
  /** Short SKIP LOCKED claim transaction: bounded batch, deterministic
   * next_attempt_at/created_at order, 60-second lease, version increment. */
  claimBatch(limit: number, owner: string): Promise<ReceiptMediaRow[]>;
  /** Extends a live owned lease (no version change). */
  renewLease(input: LeaseFenceInput): Promise<boolean>;
  /** Clears a live owned lease (no version change). */
  releaseLease(input: LeaseFenceInput): Promise<boolean>;
  /** Fenced status CAS: sets next status, bumps version; loser false. */
  transitionStatus(input: StatusCasInput): Promise<boolean>;
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
}
