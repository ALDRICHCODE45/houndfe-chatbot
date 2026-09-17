import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/postgres-pool.provider';
import {
  type CreateHumanHandoffInput,
  type HumanHandoffStore,
} from '../domain/human-handoff-store.port';
import type {
  HumanHandoffDigest,
  HumanHandoffKind,
  HumanHandoffRequest,
  HumanHandoffResolution,
} from '../domain/human-handoff.types';

interface HumanHandoffRow {
  id: string;
  customer_id: string;
  agent_id: string;
  kind: string;
  digest: unknown;
  status: string;
  resolution: unknown;
  created_at: Date;
  resolved_at: Date | null;
}

/**
 * Durable (Postgres) implementation of HumanHandoffStore.
 *
 * Schema: see migrations/1900000000000_human_handoff_requests.js.
 * JSONB columns are stored as `JSON.stringify(payload)` on write and
 * parsed on read; timestamptz round-trips via `Date.toISOString()` (pg
 * coerces timestamptz → JS Date by default — JS ms ⊆ PG µs, so the
 * value round-trips exact at ms precision, matching the existing
 * `conversation_state` adapter).
 *
 * `findByRef` strips the `HF-` prefix case-insensitively and falls back
 * to `findById` so a single match path backs both lookups.
 */
@Injectable()
export class PostgresHumanHandoffStore implements HumanHandoffStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(input: CreateHumanHandoffInput): Promise<HumanHandoffRequest> {
    const { rows } = await this.pool.query<HumanHandoffRow>(
      `INSERT INTO human_handoff_requests
        (id, customer_id, agent_id, kind, digest, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
       RETURNING id, customer_id, agent_id, kind, digest, status, resolution,
                 created_at, resolved_at`,
      [
        input.id,
        input.customerId,
        input.agentId,
        input.kind,
        JSON.stringify(input.digest),
      ],
    );
    return this.toRequest(rows[0]);
  }

  async findById(id: string): Promise<HumanHandoffRequest | null> {
    const { rows } = await this.pool.query<HumanHandoffRow>(
      `SELECT id, customer_id, agent_id, kind, digest, status, resolution,
              created_at, resolved_at
       FROM human_handoff_requests WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.toRequest(rows[0]) : null;
  }

  async findByRef(ref: string): Promise<HumanHandoffRequest | null> {
    const id = stripRefPrefix(ref);
    if (id === null) {
      return null;
    }
    return this.findById(id);
  }

  async findLatestPendingForAgent(
    agentId: string,
  ): Promise<HumanHandoffRequest | null> {
    const { rows } = await this.pool.query<HumanHandoffRow>(
      `SELECT id, customer_id, agent_id, kind, digest, status, resolution,
              created_at, resolved_at
       FROM human_handoff_requests
       WHERE agent_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [agentId],
    );
    return rows[0] ? this.toRequest(rows[0]) : null;
  }

  async resolve(
    id: string,
    resolution: HumanHandoffResolution,
  ): Promise<HumanHandoffRequest | null> {
    const { rows } = await this.pool.query<HumanHandoffRow>(
      `UPDATE human_handoff_requests
       SET status = 'resolved',
           resolution = $2::jsonb,
           resolved_at = now()
       WHERE id = $1
       RETURNING id, customer_id, agent_id, kind, digest, status, resolution,
                 created_at, resolved_at`,
      [id, JSON.stringify(resolution)],
    );
    return rows[0] ? this.toRequest(rows[0]) : null;
  }

  private toRequest(row: HumanHandoffRow): HumanHandoffRequest {
    return {
      id: row.id,
      customerId: row.customer_id,
      agentId: row.agent_id,
      kind: row.kind as HumanHandoffKind,
      digest: row.digest as HumanHandoffDigest,
      status: row.status as 'pending' | 'resolved',
      resolution:
        row.resolution === null
          ? null
          : (row.resolution as HumanHandoffResolution),
      createdAt: row.created_at.toISOString(),
      resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    };
  }
}

/** Strip `HF-` / `hf-` prefix from a ref; return null on malformed input. */
function stripRefPrefix(ref: string): string | null {
  if (typeof ref !== 'string') return null;
  const match = /^[Hh][Ff]-?([A-Za-z0-9_-]{4,32})$/.exec(ref.trim());
  return match ? (match[1] ?? null) : null;
}
