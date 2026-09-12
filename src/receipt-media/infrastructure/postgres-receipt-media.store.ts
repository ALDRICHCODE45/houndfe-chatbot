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
  AmountProposalInput,
  AmountProposalOutcome,
  AmountRejectionInput,
  AmountRejectionOutcome,
  AttemptStartResult,
  CapabilityAccessRow,
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
import { RECEIPT_SHA256_BYTES } from '../domain/receipt-media.types';

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
  (input.expectedReceiptStatus === 'AWAITING_AMOUNT' ||
    input.expectedReceiptStatus === 'AWAITING_CONFIRMATION') &&
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

  /** One receipt-first transaction atomically cancels an active amount flow,
   * removes its exact pointer, records the committed intent, and preserves the
   * command needed for conservative replay validation. */
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
        const commandMatches =
          !!command &&
          command.receipt_media_id === input.receiptMediaId &&
          command.source_webhook_message_id === input.sourceWebhookMessageId &&
          command.sender_id === input.senderId &&
          command.captured_sale_id === input.capturedSaleId &&
          command.expected_receipt_status === input.expectedReceiptStatus &&
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
            !amountStateMatches(receipt, input.expectedReceiptStatus) ||
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
          receipt.status !== input.expectedReceiptStatus ||
          receipt.version !== input.expectedReceiptVersion ||
          !amountStateMatches(receipt, input.expectedReceiptStatus) ||
          !samePointer(
            conversation.data.receiptAmountPointer,
            input.expectedPointer,
          )
        )
          throw FENCED;
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
            input.expectedReceiptStatus,
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
            input.expectedReceiptStatus,
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

  /** WU2B2A leased claims (RM1, RM3): short CTE transaction with FOR UPDATE
   * SKIP LOCKED, bounded batch, deterministic next_attempt_at/created_at
   * ordering, 60-second lease, and version increment. Eligibility exactly:
   * RESERVED with meta<3; DOWNLOADED with storage<3 and meta<3; plain STORED
   * regardless of counters; pre-request ATTACHING. */
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
               OR (status = 'ATTACHING' AND attach_attempts = 0
                 AND attach_request_started_at IS NULL))
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
