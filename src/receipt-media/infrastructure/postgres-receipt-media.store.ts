import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';
import type {
  DedupeOutcome,
  OutboxIntentInput,
  ReceiptMediaStorePort,
  ReservationOutcome,
  ReserveInput,
} from '../domain/receipt-media-store.port';

type Row = Record<string, unknown>;
type Media = ReceiptMediaRow;

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

/** WU2B1 PostgreSQL primitives (RM1, RM3) over the WU2A1/WU2A2A/WU2A2B
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
}
