import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
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
  AttachRequestStartInput,
  AttachRequestStartOutcome,
  AttachStartInput,
  AttachStartOutcome,
  AttemptStartResult,
  CapabilityAccessRow,
  DownloadCommitInput,
  DownloadCommitOutcome,
  DedupeOutcome,
  LeaseFenceInput,
  OutboxIntentInput,
  ReceiptMediaStorePort,
  ReceiptCancellationInput,
  ReceiptCancellationOutcome,
  ReservationOutcome,
  ReserveInput,
  StatusCasInput,
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
             AND lease_expires_at > now() AND status = 'ATTACHING'
             AND attach_attempts = 1 AND attach_attempt_id = $4
             AND attach_request_started_at IS NOT NULL
             AND backend_receipt_id IS NULL AND backend_receipt_status IS NULL
             AND attached_at IS NULL RETURNING *`;

const ATTACH_SUCCESS_LOOK_SQL = `SELECT * FROM receipt_media
           WHERE id = $1 AND lease_owner = $2
             AND lease_expires_at > now()`;

const MAX_INT32 = 2_147_483_647;
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
      Number.isSafeInteger(input.capabilityKeyVersion) &&
      input.capabilityKeyVersion > 0 &&
      input.capabilityKeyVersion <= MAX_INT32
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

const sameBootstrapEvidence = (row: Row, input: AmountBootstrapInput) =>
  row.stored_at instanceof Date &&
  row.object_etag === input.objectEtag &&
  row.object_version_id === input.objectVersionId &&
  Buffer.isBuffer(row.capability_token_hash) &&
  Buffer.compare(row.capability_token_hash, input.capabilityTokenHash) === 0 &&
  row.capability_key_version === input.capabilityKeyVersion &&
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

  /** Reservation arbitration: pre-check committed state, insert under a
   * savepoint; on a lost race, roll back only the insert and classify
   * deterministically from reloaded committed state — never committing an
   * aborted transaction. Unrelated constraints still throw. */
  async reserve(input: ReserveInput): Promise<ReservationOutcome> {
    return this.withTx(async (c) => {
      const hit = await loadHit(c, input);
      if (hit) return classify(hit, input);
      await c.query('SAVEPOINT reserve_insert');
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
        return { kind: 'created', receipt: camelize<Media>(inserted.rows[0]) };
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT reserve_insert');
        const winner = await loadHit(c, input);
        if (winner) return classify(winner, input);
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
   * status, and attached_at. Only the exact durable successor with the
   * same attempt identity, backend evidence, and successor version replays
   * (the original stale fence replays too: the same command retried after
   * a crash-after-commit resolves against the same successor); every other
   * caller is fenced without mutation. Lease fields are retained per the
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
          return {
            kind: 'committed',
            version: String(receipt.version),
            receipt: camelize<Media>(receipt),
          };
        }
        const current = (
          await c.query<Row>(ATTACH_SUCCESS_LOOK_SQL, [input.id, input.owner])
        ).rows[0];
        return current?.status === 'ATTACHED' &&
          String(current.version) === successor &&
          current.attach_attempt_id === input.attachAttemptId &&
          current.backend_receipt_id === input.backendReceiptId &&
          current.backend_receipt_status === 'PENDING' &&
          current.attached_at instanceof Date
          ? {
              kind: 'replayed',
              version: successor,
              receipt: camelize<Media>(current),
            }
          : { kind: 'fenced' };
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

  /** WU2B2A leased claims (RM1, RM3): short CTE transaction with FOR UPDATE
   * SKIP LOCKED, bounded batch, deterministic next_attempt_at/created_at
   * ordering, 60-second lease, and version increment. Eligibility exactly:
   * RESERVED with meta<3; DOWNLOADED with storage<3 and meta<3; plain STORED
   * regardless of counters; ATTACHING (post-crash included) for fix-forward. */
  async claimBatch(limit: number, owner: string): Promise<Media[]> {
    return this.withTx(async (c) => {
      const { rows } = await c.query<Row>(
        `WITH candidate AS (
           SELECT id FROM receipt_media
           WHERE next_attempt_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
             AND ((status = 'RESERVED' AND meta_attempts < 3)
               OR (status = 'DOWNLOADED'
                 AND storage_attempts < 3 AND meta_attempts < 3)
               OR status = 'STORED'
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
            'capability_issued_at',
            'capability_revoked_at',
          ].some((key) => receipt[key] !== null)
        )
          throw FENCED;
        const updated = await c.query<Row>(
          `UPDATE receipt_media SET status = 'AWAITING_AMOUNT', stored_at = now(),
             object_etag = $4, object_version_id = $5, capability_token_hash = $6,
             capability_key_version = $7, capability_issued_at = now(),
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
