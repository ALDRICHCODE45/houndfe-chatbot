import type { Pool } from 'pg';
import {
  normalizeCustomerInboundObservation,
  type CustomerInboundObservation,
} from '../domain/customer-inbound-observation';
import type {
  CustomerInboundObservationLatest,
  CustomerInboundObservationRecord,
  CustomerInboundObservationStore,
} from '../domain/customer-inbound-observation-store.port';

const COLUMNS = `receiving_phone_number_id AS "receivingPhoneNumberId",
sender_id AS "senderId", message_id AS "messageId",
provider_timestamp_seconds::text AS "providerTimestampSeconds",
observed_at AS "observedAt"`;
const INSERT = `INSERT INTO customer_inbound_observations
(receiving_phone_number_id, sender_id, message_id, provider_timestamp_seconds, observed_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (receiving_phone_number_id, message_id) DO NOTHING
RETURNING ${COLUMNS}`;
const READ_EVENT = `SELECT ${COLUMNS} FROM customer_inbound_observations
WHERE receiving_phone_number_id = $1 AND message_id = $2`;
const READ_LATEST = `SELECT ${COLUMNS} FROM customer_inbound_observations
WHERE sender_id = $1 AND receiving_phone_number_id = $2
ORDER BY provider_timestamp_seconds DESC, message_id DESC LIMIT 1`;
const HOLD = Object.freeze({ kind: 'hold' as const });

// The ordinary pg envelope is not trusted: an incoherent rows/rowCount pair
// throws a bounded generic error, and no branch ever reads more than one row.
function rows(result: unknown): unknown[] {
  if (typeof result !== 'object' || result === null)
    throw new Error('invalid observation result');
  const { rows: raw, rowCount } = result as {
    rows?: unknown;
    rowCount?: unknown;
  };
  if (
    !Array.isArray(raw) ||
    !Number.isInteger(rowCount) ||
    rowCount !== raw.length ||
    raw.length > 1
  )
    throw new Error('inconsistent observation result');
  return raw as unknown[];
}

// Mirrors the committed normalizer's opaque-identity rule for the two-field
// lookup key that the exact five-field normalizer cannot accept.
function opaqueIdentity(value: unknown, limit: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function lookup(
  senderId: unknown,
  receivingPhoneNumberId: unknown,
): Readonly<{ senderId: string; receivingPhoneNumberId: string }> | null {
  return opaqueIdentity(senderId, 200) &&
    typeof receivingPhoneNumberId === 'string' &&
    /^[0-9]{1,24}$/.test(receivingPhoneNumberId)
    ? { senderId, receivingPhoneNumberId }
    : null;
}

// The four immutable coordinates; observedAt may differ on a delayed retry.
function immutable(
  left: CustomerInboundObservation,
  right: CustomerInboundObservation,
): boolean {
  return (
    left.senderId === right.senderId &&
    left.receivingPhoneNumberId === right.receivingPhoneNumberId &&
    left.messageId === right.messageId &&
    left.providerTimestampSeconds === right.providerTimestampSeconds
  );
}

/**
 * Unwired first-record/replay/latest adapter over a standalone pool: no caller
 * transaction, retry, update, logging or ambient clock; it neither captures nor
 * sends. `record` detaches and freezes validated input before any await, keeps
 * the first stored observation on an exact event replay even when the retry's
 * `observedAt` differs, and holds on immutable conflict, proven absence or an
 * unreadable stored row. A zero-row INSERT reads that same
 * `(receiving_phone_number_id, message_id)` key once, never the latest sender.
 * `readLatest` validates before I/O and selects only the numerically greatest
 * provider time for the exact sender/phone. Driver incoherence throws and SQL
 * errors propagate once, since an uncertain insert may already have committed.
 * A stored row is persistence only: no provenance, latest-delivered or send
 * authority.
 */
export class PostgresCustomerInboundObservationStore implements CustomerInboundObservationStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async record(input: unknown): Promise<CustomerInboundObservationRecord> {
    const snapshot = normalizeCustomerInboundObservation(input);
    if (!snapshot) return HOLD;
    const inserted = rows(
      await this.pool.query(INSERT, [
        snapshot.receivingPhoneNumberId,
        snapshot.senderId,
        snapshot.messageId,
        snapshot.providerTimestampSeconds,
        snapshot.observedAt,
      ]),
    );
    if (inserted.length) {
      const observation = normalizeCustomerInboundObservation(inserted[0]);
      return observation &&
        immutable(observation, snapshot) &&
        observation.observedAt === snapshot.observedAt
        ? Object.freeze({ kind: 'recorded' as const, observation })
        : HOLD;
    }
    const existing = rows(
      await this.pool.query(READ_EVENT, [
        snapshot.receivingPhoneNumberId,
        snapshot.messageId,
      ]),
    );
    if (existing.length === 0) return HOLD;
    const stored = normalizeCustomerInboundObservation(existing[0]);
    return stored && immutable(stored, snapshot)
      ? Object.freeze({ kind: 'replay' as const, observation: stored })
      : HOLD;
  }

  async readLatest(
    senderId: string,
    receivingPhoneNumberId: string,
  ): Promise<CustomerInboundObservationLatest> {
    const key = lookup(senderId, receivingPhoneNumberId);
    if (!key) return HOLD;
    const found = rows(
      await this.pool.query(READ_LATEST, [
        key.senderId,
        key.receivingPhoneNumberId,
      ]),
    );
    if (found.length === 0) return Object.freeze({ kind: 'missing' as const });
    const observation = normalizeCustomerInboundObservation(found[0]);
    return observation &&
      observation.senderId === key.senderId &&
      observation.receivingPhoneNumberId === key.receivingPhoneNumberId
      ? Object.freeze({ kind: 'found' as const, observation })
      : HOLD;
  }
}
