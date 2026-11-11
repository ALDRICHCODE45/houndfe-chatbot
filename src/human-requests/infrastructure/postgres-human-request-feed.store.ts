import type { Pool } from 'pg';
import type {
  DeliveryOutcome,
  FeedItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import {
  FEED_CONSUMER_NAME,
  type AckCompletion,
  type AckState,
  type DeliveryDecision,
  type DeliveryExpectation,
  type DeliveryLocalState,
  type DeliveryRow,
  type DeliveryTransition,
  type HumanRequestFeedStore,
  type HumanRequestRecord,
  type HumanRequestStatus,
  type OpenHumanRequestInput,
} from '../domain/human-request-feed';

interface Row {
  delivery_id: string;
  cursor: string;
  type: string;
  request_id: string | null;
  conversation_ref: string | null;
  payload: FeedItem;
  local_state: DeliveryLocalState;
  decision: DeliveryDecision | null;
  attempt_id: string | null;
  provider_message_id: string | null;
  attempted_at: Date | null;
  ack_state: AckState | null;
  ack_outcome: DeliveryOutcome | null;
  ack_attempts: number;
  next_ack_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RegistryRow {
  request_id: string;
  conversation_ref: string;
  subtype: string;
  legacy_id: string | null;
  status: HumanRequestStatus;
  created_at: Date;
  updated_at: Date;
}

const READ_CURSOR_SQL = `SELECT cursor FROM human_request_feed_cursor WHERE consumer = $1`;
const SAVE_CURSOR_SQL = `INSERT INTO human_request_feed_cursor (consumer, cursor)
VALUES ($1, $2)
ON CONFLICT (consumer) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`;

/** The row is written before any Meta call; an existing deliveryId keeps
 *  its stored row untouched. */
const INSERT_DELIVERY_SQL = `WITH ins AS (
  INSERT INTO human_request_deliveries
    (delivery_id, cursor, type, request_id, conversation_ref, payload)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (delivery_id) DO NOTHING
  RETURNING *
)
SELECT *, true AS inserted FROM ins
UNION ALL
SELECT *, false AS inserted FROM human_request_deliveries
 WHERE delivery_id = $1 AND NOT EXISTS (SELECT 1 FROM ins)`;
const SELECT_DELIVERY_SQL = `SELECT * FROM human_request_deliveries WHERE delivery_id = $1`;

/** Compare-and-set on (local_state, attempt_id). */
const TRANSITION_SQL = `UPDATE human_request_deliveries SET
  local_state = $4,
  decision = $5,
  attempt_id = $6,
  attempted_at = $7,
  provider_message_id = $8,
  ack_state = CASE WHEN $9::text IS NULL THEN NULL ELSE 'PENDING' END,
  ack_outcome = $9::text,
  ack_attempts = 0,
  next_ack_at = CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,
  ack_error = NULL,
  updated_at = now()
WHERE delivery_id = $1 AND local_state = $2
  AND attempt_id IS NOT DISTINCT FROM $3::uuid
RETURNING *`;

const ACK_GUARD = `WHERE delivery_id = $1 AND attempt_id = $2::uuid AND ack_state = 'PENDING'`;
const ACKED_SQL = `UPDATE human_request_deliveries
  SET ack_state = 'ACKED', next_ack_at = NULL, ack_error = NULL, updated_at = now()
  ${ACK_GUARD}`;
const ACK_FAILED_SQL = `UPDATE human_request_deliveries
  SET ack_state = 'FAILED_PERMANENT', ack_attempts = ack_attempts + 1,
      next_ack_at = NULL, ack_error = left($3, 1000), updated_at = now()
  ${ACK_GUARD}`;
const ACK_RETRY_SQL = `UPDATE human_request_deliveries
  SET ack_attempts = ack_attempts + 1, next_ack_at = $3,
      ack_error = left($4, 1000), updated_at = now()
  ${ACK_GUARD}`;
const ACK_DROPPED_SQL = `UPDATE human_request_deliveries
  SET ack_state = NULL, ack_outcome = NULL, next_ack_at = NULL, updated_at = now()
  ${ACK_GUARD}`;

const DUE_ACKS_SQL = `SELECT * FROM human_request_deliveries
 WHERE ack_state = 'PENDING' AND next_ack_at <= $1
 ORDER BY next_ack_at LIMIT $2`;
const HELD_SQL = `SELECT * FROM human_request_deliveries
 WHERE local_state = 'HELD_HUMAN'
 ORDER BY updated_at LIMIT $1`;
const HELD_FOR_SQL = `SELECT * FROM human_request_deliveries
 WHERE conversation_ref = $1 AND local_state = 'HELD_HUMAN'
 ORDER BY updated_at LIMIT $2`;
const STUCK_SENDING_SQL = `SELECT * FROM human_request_deliveries
 WHERE local_state = 'SENDING' AND attempted_at < $1
 ORDER BY attempted_at LIMIT $2`;

const OPEN_REQUEST_SQL = `INSERT INTO human_request_registry
  (request_id, conversation_ref, subtype, legacy_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (request_id) DO NOTHING`;
const CLOSE_REQUEST_SQL = `UPDATE human_request_registry
  SET status = $2, updated_at = now()
WHERE request_id = $1 AND status = 'OPEN'`;
const SELECT_REQUEST_SQL = `SELECT * FROM human_request_registry WHERE request_id = $1`;

/** `human_request_feed_cursor`, `human_request_deliveries` and
 *  `human_request_registry` (migration 4300). */
export class PostgresHumanRequestFeedStore implements HumanRequestFeedStore {
  constructor(private readonly pool: Pool) {}

  async readCursor(): Promise<string | null> {
    const result = await this.pool.query<{ cursor: string | null }>(
      READ_CURSOR_SQL,
      [FEED_CONSUMER_NAME],
    );
    return result.rows[0]?.cursor ?? null;
  }

  async saveCursor(cursor: string | null): Promise<void> {
    await this.pool.query(SAVE_CURSOR_SQL, [FEED_CONSUMER_NAME, cursor]);
  }

  async insertDelivery(
    item: FeedItem,
  ): Promise<{ row: DeliveryRow; inserted: boolean }> {
    const known = item.type !== 'unknown';
    const result = await this.pool.query<Row & { inserted: boolean }>(
      INSERT_DELIVERY_SQL,
      [
        item.deliveryId,
        item.cursor,
        known ? item.type : item.rawType,
        known ? item.requestId : null,
        known ? item.conversationRef : null,
        JSON.stringify(item),
      ],
    );
    const found = result.rows[0];
    if (found) return { row: toDelivery(found), inserted: found.inserted };
    // A concurrent insert committed after this statement's snapshot.
    const row = await this.getDelivery(item.deliveryId);
    if (row === null)
      throw new Error(`delivery ${item.deliveryId} vanished after insert`);
    return { row, inserted: false };
  }

  async getDelivery(deliveryId: string): Promise<DeliveryRow | null> {
    const result = await this.pool.query<Row>(SELECT_DELIVERY_SQL, [
      deliveryId,
    ]);
    return result.rows[0] ? toDelivery(result.rows[0]) : null;
  }

  async transition(
    deliveryId: string,
    expected: DeliveryExpectation,
    next: DeliveryTransition,
  ): Promise<DeliveryRow | null> {
    const result = await this.pool.query<Row>(TRANSITION_SQL, [
      deliveryId,
      expected.localState,
      expected.attemptId,
      next.localState,
      next.decision,
      next.attemptId,
      next.attemptedAt,
      next.providerMessageId,
      next.ack,
    ]);
    return result.rows[0] ? toDelivery(result.rows[0]) : null;
  }

  async completeAck(
    deliveryId: string,
    attemptId: string,
    completion: AckCompletion,
  ): Promise<boolean> {
    const key = [deliveryId, attemptId];
    let result: { rowCount: number | null };
    switch (completion.ackState) {
      case 'ACKED':
        result = await this.pool.query(ACKED_SQL, key);
        break;
      case 'FAILED_PERMANENT':
        result = await this.pool.query(ACK_FAILED_SQL, [
          ...key,
          completion.error,
        ]);
        break;
      case 'PENDING':
        result = await this.pool.query(ACK_RETRY_SQL, [
          ...key,
          completion.retryAt,
          completion.error,
        ]);
        break;
      case null:
        result = await this.pool.query(ACK_DROPPED_SQL, key);
        break;
    }
    return (result.rowCount ?? 0) > 0;
  }

  async listDueAcks(now: Date, limit: number): Promise<DeliveryRow[]> {
    const result = await this.pool.query<Row>(DUE_ACKS_SQL, [now, limit]);
    return result.rows.map(toDelivery);
  }

  async listHeld(filter: {
    conversationRef?: string;
    limit: number;
  }): Promise<DeliveryRow[]> {
    const result =
      filter.conversationRef === undefined
        ? await this.pool.query<Row>(HELD_SQL, [filter.limit])
        : await this.pool.query<Row>(HELD_FOR_SQL, [
            filter.conversationRef,
            filter.limit,
          ]);
    return result.rows.map(toDelivery);
  }

  async listStuckSending(before: Date, limit: number): Promise<DeliveryRow[]> {
    const result = await this.pool.query<Row>(STUCK_SENDING_SQL, [
      before,
      limit,
    ]);
    return result.rows.map(toDelivery);
  }

  async recordOpenRequest(input: OpenHumanRequestInput): Promise<void> {
    await this.pool.query(OPEN_REQUEST_SQL, [
      input.requestId,
      input.conversationRef,
      input.subtype,
      input.legacyId ?? null,
    ]);
  }

  async closeRequest(
    requestId: string,
    status: Exclude<HumanRequestStatus, 'OPEN'>,
  ): Promise<boolean> {
    const result = await this.pool.query(CLOSE_REQUEST_SQL, [
      requestId,
      status,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async getRequest(requestId: string): Promise<HumanRequestRecord | null> {
    const result = await this.pool.query<RegistryRow>(SELECT_REQUEST_SQL, [
      requestId,
    ]);
    const row = result.rows[0];
    return row
      ? {
          requestId: row.request_id,
          conversationRef: row.conversation_ref,
          subtype: row.subtype,
          legacyId: row.legacy_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }
}

const toDelivery = (row: Row): DeliveryRow => ({
  deliveryId: row.delivery_id,
  cursor: row.cursor,
  type: row.type,
  requestId: row.request_id,
  conversationRef: row.conversation_ref,
  item: row.payload,
  localState: row.local_state,
  decision: row.decision,
  attemptId: row.attempt_id,
  providerMessageId: row.provider_message_id,
  attemptedAt:
    row.attempted_at === null ? null : row.attempted_at.toISOString(),
  ackState: row.ack_state,
  ackOutcome: row.ack_outcome,
  ackAttempts: row.ack_attempts,
  nextAckAt: row.next_ack_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
