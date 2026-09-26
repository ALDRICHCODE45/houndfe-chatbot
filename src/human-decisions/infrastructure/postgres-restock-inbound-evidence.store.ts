import type { Pool } from 'pg';
import {
  normalizeRestockInboundEvidence,
  type RestockInboundEvidence,
} from '../domain/restock-inbound-evidence';

export type RestockInboundEvidenceWrite =
  | Readonly<{
      action: 'recorded' | 'replay';
      evidence: RestockInboundEvidence;
    }>
  | Readonly<{ action: 'hold' }>;
export type RestockInboundEvidenceRead =
  | Readonly<{ action: 'found'; evidence: RestockInboundEvidence }>
  | Readonly<{ action: 'missing' | 'hold' }>;
export interface RestockInboundEvidencePort {
  record(input: RestockInboundEvidence): Promise<RestockInboundEvidenceWrite>;
  readBySource(sourceRequestId: string): Promise<RestockInboundEvidenceRead>;
}
const HOLD = Object.freeze({ action: 'hold' as const });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = `source_request_id AS "sourceRequestId",
receiving_phone_number_id AS "receivingPhoneNumberId", sender_id AS "senderId",
message_id AS "messageId", provider_timestamp_seconds AS "providerTimestampSeconds",
observed_at AS "observedAt", version`;
const INSERT = `INSERT INTO restock_inbound_evidence
(source_request_id, receiving_phone_number_id, sender_id, message_id,
provider_timestamp_seconds, observed_at, version)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`;
const READ = `SELECT ${COLUMNS} FROM restock_inbound_evidence WHERE source_request_id = $1`;

// Ordinary pg outer results assumed; nested projections use the strict normalizer.
function rows(result: unknown): unknown[] {
  if (typeof result !== 'object' || result === null)
    throw new Error('invalid evidence result');
  const { rows, rowCount } = result as { rows?: unknown; rowCount?: unknown };
  if (
    !Array.isArray(rows) ||
    !Number.isInteger(rowCount) ||
    rowCount !== rows.length ||
    rows.length > 1
  )
    throw new Error('inconsistent evidence result');
  return rows as unknown[];
}
function same(
  left: RestockInboundEvidence,
  right: RestockInboundEvidence,
): boolean {
  return (
    left.sourceRequestId === right.sourceRequestId &&
    left.receivingPhoneNumberId === right.receivingPhoneNumberId &&
    left.senderId === right.senderId &&
    left.messageId === right.messageId &&
    left.providerTimestampSeconds === right.providerTimestampSeconds &&
    left.version === right.version
  );
}

/**
 * Unwired INSERT/read only. First persisted observation wins, not first arrival.
 * Future trusted SignatureGuard capture owns authentication/configured channel
 * binding; this store proves neither provenance nor latest inbound/24h authority.
 * No synthetic backfill. DB failures propagate: an uncertain insert may commit.
 */
export class PostgresRestockInboundEvidenceStore implements RestockInboundEvidencePort {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async readBySource(
    sourceRequestId: string,
  ): Promise<RestockInboundEvidenceRead> {
    if (typeof sourceRequestId !== 'string' || !UUID.test(sourceRequestId))
      return HOLD;
    const found = rows(await this.pool.query(READ, [sourceRequestId]));
    if (!found.length) return Object.freeze({ action: 'missing' });
    const evidence = normalizeRestockInboundEvidence(found[0]);
    return evidence &&
      evidence.sourceRequestId === sourceRequestId.toLowerCase()
      ? Object.freeze({ action: 'found', evidence })
      : HOLD;
  }

  async record(
    input: RestockInboundEvidence,
  ): Promise<RestockInboundEvidenceWrite> {
    const snapshot = normalizeRestockInboundEvidence(input);
    if (!snapshot) return HOLD;
    const found = rows(
      await this.pool.query(INSERT, [
        snapshot.sourceRequestId,
        snapshot.receivingPhoneNumberId,
        snapshot.senderId,
        snapshot.messageId,
        snapshot.providerTimestampSeconds,
        snapshot.observedAt,
        snapshot.version,
      ]),
    );
    if (found.length) {
      const evidence = normalizeRestockInboundEvidence(found[0]);
      return evidence &&
        same(evidence, snapshot) &&
        evidence.observedAt === snapshot.observedAt
        ? Object.freeze({ action: 'recorded', evidence })
        : HOLD;
    }
    const existing = await this.readBySource(snapshot.sourceRequestId);
    return existing.action === 'found' && same(existing.evidence, snapshot)
      ? Object.freeze({ action: 'replay', evidence: existing.evidence })
      : HOLD;
  }
}
