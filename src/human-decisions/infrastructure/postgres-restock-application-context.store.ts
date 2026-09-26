import type { Pool } from 'pg';
import { z } from 'zod';
import {
  normalizeRestockIntake,
  type RestockIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { ActiveReservation } from '../domain/shared-reservation';

export interface RecordedRestockContext {
  readonly reservation: Omit<ActiveReservation, 'intake'> & {
    readonly route: 'RESTOCK';
    readonly intake: Readonly<RestockIntakeInput>;
  };
  readonly backendDecisionId: string;
  readonly postAttemptedAt: string;
  readonly receiptRecordedAt: string;
}
export type RestockContextRead =
  | { readonly action: 'recorded'; readonly context: RecordedRestockContext }
  | { readonly action: 'missing' }
  | { readonly action: 'hold' };

const SQL = `SELECT sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = z.iso.datetime({ offset: true });
const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID.test(v);
const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);

/** DB timestamptz Date or strictly valid ISO string -> detached canonical UTC.
 * No freshness, timestamp ordering or POST TTL is implied by schema 240. */
function timestamp(value: unknown): string | null {
  const epoch =
    value instanceof Date
      ? Date.prototype.getTime.call(value)
      : typeof value === 'string' && INSTANT.safeParse(value).success
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}
function exactIntake(value: unknown): Readonly<RestockIntakeInput> | null {
  if (!plain(value) || Reflect.ownKeys(value).length !== 10) return null;
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
  const normalized = normalizeRestockIntake(raw);
  if (
    !normalized ||
    Object.entries(normalized).some(([k, v]) => !Object.is(raw[k], v))
  )
    return null;
  return Object.freeze(normalized);
}

/** READ snapshot only, not ownership, provenance, current subject interest or
 * 24h eligibility, and not a complete historical POST receipt/current decision.
 * Next coordinator fetches current GET by persisted backend id + trusted configured
 * branch; policy binds local intake to server frozen subject. Before any claim,
 * transaction must re-read/lock exact reservation and compare the full context.
 * lastMessageAt is not trusted 24h evidence (legacy now writes); source UUID's
 * receive-phone mapping is not durably available. Neither is resolved here.
 * T3d legacy truth remains a release blocker, without waiver. Unwired; no effects
 * beyond one SELECT. Ordinary pg outer result/row objects are trusted, not hostile
 * proxies. Corrupt cardinality throws like sibling stores; corrupt contents hold. */
export class PostgresRestockApplicationContextStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async readRecordedForSender(senderId: string): Promise<RestockContextRead> {
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
      throw new Error('inconsistent restock context read');
    if (rows.length === 0) return { action: 'missing' };
    try {
      const row = rows[0];
      const intake = exactIntake(row.intake);
      const postAttemptedAt = timestamp(row.post_attempted_at);
      const receiptRecordedAt = timestamp(row.receipt_recorded_at);
      if (
        row.sender_id !== senderId ||
        row.status !== 'ACTIVE' ||
        row.route !== 'RESTOCK' ||
        row.post_state !== 'RECEIPT_RECORDED' ||
        !isUuid(row.request_key) ||
        !isUuid(row.backend_decision_id) ||
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
            route: 'RESTOCK',
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
