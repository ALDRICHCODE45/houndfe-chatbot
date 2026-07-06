import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import {
  ConversationState,
  ConversationStore,
} from '../domain/conversation-store';
import { PG_POOL } from '../../database/postgres-pool.provider';

interface ConversationRow {
  sender_id: string;
  last_message_at: Date;
  data: ConversationState['data'];
}

/**
 * Durable (Postgres) implementation of ConversationStore.
 *
 * Schema: see migrations/1700000000000_create-conversation-state.js —
 * one table keyed by sender_id with a jsonb `data` payload. Access is
 * PK-only, so no secondary index is required.
 *
 * **Merge parity (mirrors InMemoryConversationStore byte-identically):**
 * `update()` does a read-modify-write in APP code: `existing ? {...existing, ...patch} : {senderId, ...patch}`.
 * A patch WITHOUT `data` preserves the stored `data`; a patch WITH `data`
 * replaces it wholesale (no JSONB deep merge at the storage layer).
 * The UPSERT then writes the whole merged object via
 * `INSERT ... ON CONFLICT (sender_id) DO UPDATE SET ...`.
 *
 * **timestamptz ↔ ISO 8601:** WRITE binds the ISO string with an
 * explicit `$n::timestamptz` cast so Postgres parses it; READ returns
 * `row.last_message_at.toISOString()` (pg coerces timestamptz → JS Date
 * by default). JS ms ⊆ PG µs, so the value round-trips exact at ms
 * precision.
 *
 * **W2 — knowingly-accepted lost-update window.** The read-then-
 * UPSERT pattern has a window where two concurrent updates could
 * clobber each other's changes. This is acceptable for the v1
 * single-bot-per-sender workload (one writer per sender id) and is
 * explicitly documented here per gate-review W2.
 */
@Injectable()
export class PostgresConversationStore implements ConversationStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async get(senderId: string): Promise<ConversationState | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      'SELECT sender_id, last_message_at, data FROM conversation_state WHERE sender_id = $1',
      [senderId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      senderId: row.sender_id,
      lastMessageAt: row.last_message_at.toISOString(),
      data: row.data,
    };
  }

  async create(
    senderId: string,
    state: Omit<ConversationState, 'senderId'>,
  ): Promise<ConversationState> {
    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, $2::timestamptz, $3::jsonb)
       RETURNING sender_id, last_message_at, data`,
      [senderId, state.lastMessageAt, JSON.stringify(state.data)],
    );
    return this.toState(rows[0]);
  }

  async update(
    senderId: string,
    patch: Partial<Omit<ConversationState, 'senderId'>>,
  ): Promise<ConversationState> {
    // Read-modify-write: merge in APP code to mirror InMemory's
    // `{ ...existing, ...patch }` exactly (data REPLACES if patch
    // carries it, PRESERVES if omitted).
    const existing = await this.get(senderId);
    const merged = existing
      ? { ...existing, ...patch }
      : { senderId, ...patch };

    if (typeof merged.lastMessageAt !== 'string') {
      throw new Error(
        `ConversationStore.update requires lastMessageAt for senderId: ${senderId}`,
      );
    }
    const data = merged.data ?? {};

    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, $2::timestamptz, $3::jsonb)
       ON CONFLICT (sender_id) DO UPDATE
         SET last_message_at = EXCLUDED.last_message_at,
             data = EXCLUDED.data
       RETURNING sender_id, last_message_at, data`,
      [senderId, merged.lastMessageAt, JSON.stringify(data)],
    );
    return this.toState(rows[0]);
  }

  private toState(row: ConversationRow): ConversationState {
    return {
      senderId: row.sender_id,
      lastMessageAt: row.last_message_at.toISOString(),
      data: row.data,
    };
  }
}