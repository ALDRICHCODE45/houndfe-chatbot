import type { Pool } from 'pg';

/** One discovered local identity. It is a HINT only: the caller must still
 * re-read and revalidate the full ACTIVE EXPIRATION RECEIPT_RECORDED context by
 * sender before any GET, preparation, claim or send. Ledger delivery state is
 * not projected: a recorded inquiry is not send permission. */
export interface ExpirationRecoveryHint {
  readonly senderId: string;
  readonly requestKey: string;
}

export interface ExpirationRecoveryDiscoveryQuery {
  /** Bounded page size; omitted -> DEFAULT_PAGE_SIZE, always <= MAX_PAGE_SIZE. */
  readonly limit?: number;
  /** Exclusive resume cursor: the last requestKey already observed. */
  readonly afterRequestKey?: string | null;
}

/** A page of hints plus the restartable position; `nextCursor` is null on a short page. */
export type ExpirationRecoveryDiscovery =
  | Readonly<{
      action: 'page';
      hints: readonly ExpirationRecoveryHint[];
      nextCursor: string | null;
    }>
  | Readonly<{ action: 'hold' }>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const HOLD = Object.freeze({ action: 'hold' as const });
/** Strict RFC 4122 v1-v8 UUID, case-insensitive; persisted bytes are kept. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Existing schema only: `(route, request_key)` is the table's unique replay
 * index, so ORDER BY request_key is a total order usable for keyset paging. */
const SELECT = `SELECT sender_id, request_key FROM human_decision_reservations WHERE route = 'EXPIRATION' AND status = 'ACTIVE' AND post_state = 'RECEIPT_RECORDED'`;
const FIRST = `${SELECT} ORDER BY request_key LIMIT $1`;
const NEXT = `${SELECT} AND request_key > $2 ORDER BY request_key LIMIT $1`;

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
/** Non-empty, unpadded string; the context reader revalidates every hint. */
const isSender = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Unwired read-only, restartable keyset discovery of ACTIVE EXPIRATION
 * RECEIPT_RECORDED inquiry hints: no timer, registration, send or mutation. It
 * never reads the application ledger, so a mixed delivery state is neither
 * interpreted nor turned into permission. Corrupt rows hold; SQL propagates. */
export class PostgresExpirationRecoveryDiscoveryStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async discoverRecordedHints(
    input: ExpirationRecoveryDiscoveryQuery = {},
  ): Promise<ExpirationRecoveryDiscovery> {
    const raw: unknown = input;
    if (!isPlain(raw)) return HOLD;
    const limit =
      raw.limit === undefined ? DEFAULT_PAGE_SIZE : (raw.limit as unknown);
    const after = raw.afterRequestKey ?? null;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE
    )
      return HOLD;
    if (after !== null && !isUuid(after)) return HOLD;
    const { rows, rowCount } = await this.pool.query<Record<string, unknown>>(
      after === null ? FIRST : NEXT,
      after === null ? [limit + 1] : [limit + 1, after],
    );
    if (
      !Array.isArray(rows) ||
      !Number.isInteger(rowCount) ||
      rowCount !== rows.length ||
      rowCount > limit + 1
    )
      throw new Error('inconsistent expiration recovery discovery');
    const hints: ExpirationRecoveryHint[] = [];
    for (const row of rows.slice(0, limit)) {
      if (!isPlain(row) || !isSender(row.sender_id) || !isUuid(row.request_key))
        return HOLD;
      hints.push(
        Object.freeze({
          senderId: row.sender_id,
          requestKey: row.request_key,
        }),
      );
    }
    const nextCursor =
      rowCount > limit ? hints[hints.length - 1].requestKey : null;
    return Object.freeze({
      action: 'page' as const,
      hints: Object.freeze(hints),
      nextCursor,
    });
  }
}
