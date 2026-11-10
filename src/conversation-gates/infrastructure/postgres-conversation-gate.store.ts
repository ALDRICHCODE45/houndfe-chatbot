import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  boundedGatePurgeBatch,
  isConversationGateKind,
  isConversationGatePayload,
  serializeConversationGate,
  type ConversationGate,
  type ConversationGateKind,
  type ConversationGateMatch,
  type ConversationGateStore,
} from '../domain/conversation-gate.store';

export const CONVERSATION_GATE_STORE_CLOCK = Symbol(
  'CONVERSATION_GATE_STORE_CLOCK',
);

interface GateRow {
  sender_id: string;
  gate_kind: string;
  payload: unknown;
  expires_at: Date;
}

const COLUMNS = 'sender_id, gate_kind, payload, expires_at';

const PUT = `
INSERT INTO conversation_gates (sender_id, gate_kind, payload, expires_at)
VALUES ($1, $2, $3::jsonb, $4::timestamptz)
ON CONFLICT (sender_id, gate_kind) DO UPDATE
   SET payload = EXCLUDED.payload,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`;

const GET = `
SELECT ${COLUMNS} FROM conversation_gates
 WHERE sender_id = $1 AND gate_kind = $2 AND expires_at > $3`;

const LIST = `
SELECT ${COLUMNS} FROM conversation_gates
 WHERE sender_id = $1 AND expires_at > $2`;

// Row lock + re-check: of two concurrent consumes only one sees the row.
const CONSUME = `
DELETE FROM conversation_gates
 WHERE sender_id = $1 AND gate_kind = $2 AND expires_at > $3
   AND payload @> $4::jsonb
RETURNING ${COLUMNS}`;

const DELETE = `
DELETE FROM conversation_gates WHERE sender_id = $1 AND gate_kind = $2`;

// One bounded batch; SKIP LOCKED lets two purgers never block each other.
const PURGE = `
DELETE FROM conversation_gates
 WHERE (sender_id, gate_kind) IN (
   SELECT sender_id, gate_kind FROM conversation_gates
    WHERE expires_at <= $1
    ORDER BY expires_at
    LIMIT $2
    FOR UPDATE SKIP LOCKED
 )`;

/**
 * `ConversationGateStore` over `conversation_gates` (migration 4200). The
 * clock is the application clock, so `expires_at` is written and compared on
 * the same time base. A row that fails validation on read is treated as
 * absent and logged with fixed fields only (never the payload).
 */
@Injectable()
export class PostgresConversationGateStore implements ConversationGateStore {
  private readonly logger = new Logger(PostgresConversationGateStore.name);
  private readonly now: () => Date;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>,
    @Optional() @Inject(CONVERSATION_GATE_STORE_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async put(gate: ConversationGate): Promise<void> {
    const json = serializeConversationGate(gate);
    await this.pool.query(PUT, [
      gate.senderId,
      gate.kind,
      json,
      gate.expiresAt.toISOString(),
    ]);
  }

  async get(
    senderId: string,
    kind: ConversationGateKind,
  ): Promise<ConversationGate | null> {
    const result = await this.pool.query<GateRow>(GET, [
      senderId,
      kind,
      this.now().toISOString(),
    ]);
    return result.rows.length === 0 ? null : this.toGate(result.rows[0]);
  }

  async list(senderId: string): Promise<ConversationGate[]> {
    const result = await this.pool.query<GateRow>(LIST, [
      senderId,
      this.now().toISOString(),
    ]);
    return result.rows
      .map((row) => this.toGate(row))
      .filter((gate): gate is ConversationGate => gate !== null);
  }

  async consume(
    senderId: string,
    kind: ConversationGateKind,
    match: ConversationGateMatch = {},
  ): Promise<ConversationGate | null> {
    const result = await this.pool.query<GateRow>(CONSUME, [
      senderId,
      kind,
      this.now().toISOString(),
      JSON.stringify(match),
    ]);
    return result.rows.length === 0 ? null : this.toGate(result.rows[0]);
  }

  async delete(senderId: string, kind: ConversationGateKind): Promise<void> {
    await this.pool.query(DELETE, [senderId, kind]);
  }

  async purgeExpired(batchSize: number): Promise<number> {
    const result = await this.pool.query(PURGE, [
      this.now().toISOString(),
      boundedGatePurgeBatch(batchSize),
    ]);
    return result.rowCount ?? 0;
  }

  private toGate(row: GateRow): ConversationGate | null {
    if (
      !isConversationGateKind(row.gate_kind) ||
      !isConversationGatePayload(row.payload) ||
      !(row.expires_at instanceof Date)
    ) {
      this.logger.warn(
        `conversation gate row malformed kind_valid=${isConversationGateKind(row.gate_kind)}; treated as absent`,
      );
      return null;
    }
    return {
      senderId: row.sender_id,
      kind: row.gate_kind,
      payload: row.payload,
      expiresAt: row.expires_at,
    };
  }
}
