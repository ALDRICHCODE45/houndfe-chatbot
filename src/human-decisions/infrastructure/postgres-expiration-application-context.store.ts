import type { Pool } from 'pg';
import { z } from 'zod';
import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import type { ActiveReservation } from '../domain/shared-reservation';

export interface RecordedExpirationContext {
  readonly reservation: Omit<ActiveReservation, 'intake'> & {
    readonly route: 'EXPIRATION';
    readonly intake: Readonly<ExpirationIntakeInput>;
  };
  readonly backendDecisionId: string;
  readonly postAttemptedAt: string;
  readonly receiptRecordedAt: string;
}
export type ExpirationContextRead =
  | { readonly action: 'recorded'; readonly context: RecordedExpirationContext }
  | { readonly action: 'missing' }
  | { readonly action: 'hold' };

const SQL = `SELECT sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE'`;
/** EXPIRATION request_key/key are strict RFC 4122 v1-v8 UUIDs; syntax is
 * case-insensitive but the persisted bytes are compared unchanged. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTAKE_KEYS = ['sourceRequestId', 'type', 'productId', 'variantId'];
const INSTANT = z.iso.datetime({ offset: true });
const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID.test(v);
/** EXPIRATION's receipt contract requires the canonical lowercase backend id. */
const canonicalId = (v: unknown): v is string =>
  typeof v === 'string' && UUID.test(v) && v === v.toLowerCase();
const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);

/** DB timestamptz Date or strictly valid ISO string -> detached canonical UTC.
 * No freshness, timestamp ordering or POST TTL is implied by this read. */
function timestamp(value: unknown): string | null {
  const epoch =
    value instanceof Date
      ? Date.prototype.getTime.call(value)
      : typeof value === 'string' && INSTANT.safeParse(value).success
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}
/** Exact own-data snapshot of a plain four-key object, then the strict
 * normalizer validates every byte; extra, accessor or symbol keys fail closed. */
function exactIntake(value: unknown): Readonly<ExpirationIntakeInput> | null {
  if (!plain(value) || Reflect.ownKeys(value).length !== INTAKE_KEYS.length) {
    return null;
  }
  const raw: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    raw[key] = descriptor.value;
  }
  const normalized = normalizeExpirationIntake(raw);
  if (
    !normalized ||
    Object.entries(normalized).some(([k, v]) => !Object.is(raw[k], v))
  )
    return null;
  return Object.freeze(normalized);
}

/** READ snapshot only, not ownership, provenance, freshness or send
 * eligibility, and not a resumption of tracking: rereading after a restart is
 * not the same as automatically following up. A later coordinator fetches the
 * current GET by the persisted canonical backend id + trusted configured
 * branch; policy binds the local intake to the server frozen subject. Before
 * any claim, a transaction must re-read/lock the exact reservation and compare
 * the full context. Unwired; no effects beyond one SELECT. Ordinary pg outer
 * result/row objects are trusted, not hostile proxies. Corrupt cardinality
 * throws like sibling stores; corrupt contents hold. */
export class PostgresExpirationApplicationContextStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async readRecordedForSender(
    senderId: string,
  ): Promise<ExpirationContextRead> {
    if (
      typeof senderId !== 'string' ||
      !senderId ||
      senderId !== senderId.trim() ||
      Array.from(senderId).some((char) => {
        const code = char.charCodeAt(0);
        return code <= 31 || (code >= 127 && code <= 159);
      })
    )
      return { action: 'hold' };
    const { rows, rowCount } = await this.pool.query<Record<string, unknown>>(
      SQL,
      [senderId],
    );
    if (
      !Array.isArray(rows) ||
      !Number.isInteger(rowCount) ||
      rowCount !== rows.length ||
      rows.length > 1 ||
      !rows.every(plain)
    )
      throw new Error('inconsistent expiration context read');
    if (rows.length === 0) return { action: 'missing' };
    try {
      const row = rows[0];
      const intake = exactIntake(row.intake);
      const postAttemptedAt = timestamp(row.post_attempted_at);
      const receiptRecordedAt = timestamp(row.receipt_recorded_at);
      if (
        row.sender_id !== senderId ||
        row.status !== 'ACTIVE' ||
        row.route !== 'EXPIRATION' ||
        row.post_state !== 'RECEIPT_RECORDED' ||
        !isUuid(row.request_key) ||
        !canonicalId(row.backend_decision_id) ||
        row.unknown_observed_at !== null ||
        !intake ||
        row.request_key !== intake.sourceRequestId ||
        !postAttemptedAt ||
        !receiptRecordedAt
      ) {
        return { action: 'hold' };
      }
      return {
        action: 'recorded',
        context: Object.freeze({
          reservation: Object.freeze({
            status: 'ACTIVE',
            route: 'EXPIRATION',
            senderId,
            requestKey: row.request_key,
            intake,
          }),
          backendDecisionId: row.backend_decision_id,
          postAttemptedAt,
          receiptRecordedAt,
        }),
      };
    } catch {
      return { action: 'hold' };
    }
  }
}
