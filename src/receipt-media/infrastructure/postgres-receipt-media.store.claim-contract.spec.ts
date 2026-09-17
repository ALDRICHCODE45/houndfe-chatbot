/** STORED-1 query-contract spec: verifies claimBatch issues SQL that
 * excludes the STORED status from automatic eligibility by exercising the
 * real PostgresReceiptMediaStore.claimBatch with a structural Pool/PoolClient
 * double that captures issued queries and parameters. No Testcontainers.
 *
 * Scope: this is a contract-only test — it proves the query structure
 * and parameter binding without executing against a real PostgreSQL instance.
 * SQL runtime behavior (predicate selectivity, concurrency, fencing) remains
 * pending; it is not certified by this spec.
 *
 * RED: the current store includes "status = 'STORED'" in the candidate
 * predicate — the STORED assertion fails. After STORED-1 removal, all
 * assertions pass.
 *
 * NOTE: strict TDD was enabled (Engram #2437) but original RED is
 * UNPROVEN and user explicitly accepted preserve-and-verify. This spec
 * is a future regression test only; its passing does not retroactively
 * establish prior RED. */
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';

// ---------------------------------------------------------------------------
// Pool / PoolClient doubles
// ---------------------------------------------------------------------------

/** Records every c.query(sql, params) call in call order. */
class RecordingPoolClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];

  async query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql: (sql ?? '').trim(), params: params ?? [] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  release(): void {
    // no-op for recording
  }
}

/** Supplies RecordingPoolClient instances and records BEGIN/COMMIT via them. */
class RecordingPool {
  readonly client = new RecordingPoolClient();

  connect(): Promise<RecordingPoolClient> {
    return Promise.resolve(this.client);
  }

  async end(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claimBatch SQL contract — STORED-1', () => {
  /** The real store with a recording pool so we can observe actual query
   * issuance without any database connection. */
  let store: PostgresReceiptMediaStore;
  let pool: RecordingPool;

  beforeEach(() => {
    pool = new RecordingPool();
    store = new PostgresReceiptMediaStore(pool as unknown as import('pg').Pool);
  });

  // -------------------------------------------------------------------------
  // Core exclusion: STORED must not appear in candidate predicate
  // -------------------------------------------------------------------------

  it('excludes STORED from the claimBatch candidate predicate', async () => {
    await store.claimBatch(5, 'test-owner');
    // Select the UPDATE call from recorded calls and assert STORED is absent
    const updateCall = pool.client.calls.find((c) =>
      /UPDATE\s+receipt_media\s+r\s+SET/i.test(c.sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).not.toMatch(/'STORED'/);
    expect(updateCall!.sql).not.toMatch(/status\s*=\s*'STORED'/i);
    expect(updateCall!.sql).not.toMatch(/status\s*IN\s*\('STORED'/i);
  });

  // -------------------------------------------------------------------------
  // Eligibility retention: RESERVED, DOWNLOADED, ATTACHING must be present
  // -------------------------------------------------------------------------

  it('retains RESERVED as a claimable status', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/status\s*=\s*'RESERVED'/i);
  });

  it('retains DOWNLOADED as a claimable status', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/status\s*=\s*'DOWNLOADED'/i);
  });

  it('retains ATTACHING as a claimable status', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/status\s*=\s*'ATTACHING'/i);
  });

  // -------------------------------------------------------------------------
  // Attempt-limit clauses retained
  // -------------------------------------------------------------------------

  it('retains meta_attempts < 3 for RESERVED', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/meta_attempts\s*<\s*3/i);
  });

  it('retains storage_attempts < 3 and meta_attempts < 3 for DOWNLOADED', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/storage_attempts\s*<\s*3/i);
    expect(allSql).toMatch(/meta_attempts\s*<\s*3/i);
  });

  // -------------------------------------------------------------------------
  // Transaction structure: BEGIN → claim CTE → UPDATE → COMMIT
  // -------------------------------------------------------------------------

  it('issues BEGIN, the claim CTE, the UPDATE, and COMMIT', async () => {
    await store.claimBatch(5, 'test-owner');
    const sqls = pool.client.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    const hasUpdate = sqls.some((s) =>
      /UPDATE\s+receipt_media\s+r\s+SET/i.test(s),
    );
    expect(hasUpdate).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Real query parameters: limit and owner are passed positionally
  // -------------------------------------------------------------------------

  it('passes [limit, owner] as the two positional parameters', async () => {
    await store.claimBatch(7, 'owner-alpha');
    // Select the UPDATE call from recorded calls and assert exact params
    const updateCall = pool.client.calls.find((c) =>
      /UPDATE\s+receipt_media\s+r\s+SET/i.test(c.sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.params).toHaveLength(2);
    expect(updateCall!.params[0]).toBe(7);
    expect(updateCall!.params[1]).toBe('owner-alpha');
  });

  it('issues exactly two parameters for the actual claim call', async () => {
    await store.claimBatch(3, 'owner-beta');
    // Select the UPDATE call from recorded calls and assert param count
    const updateCall = pool.client.calls.find((c) =>
      /UPDATE\s+receipt_media\s+r\s+SET/i.test(c.sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.params).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Locking and ordering clauses retained
  // -------------------------------------------------------------------------

  it('uses FOR UPDATE SKIP LOCKED', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  });

  it('orders by next_attempt_at, created_at', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/ORDER\s+BY\s+next_attempt_at/i);
    expect(allSql).toMatch(/created_at/i);
  });

  it('issues a 60-second lease interval', async () => {
    await store.claimBatch(5, 'test-owner');
    const allSql = pool.client.calls.map((c) => c.sql).join('\n');
    expect(allSql).toMatch(/interval\s+'60\s+seconds'/i);
  });

  // -------------------------------------------------------------------------
  // Isolation: the recording client is shared across the transaction
  // -------------------------------------------------------------------------

  it('uses the same client instance for all calls within one claimBatch', async () => {
    const clients: unknown[] = [];
    pool.connect = () => {
      const c = pool.client;
      clients.push(c);
      return Promise.resolve(c);
    };
    await store.claimBatch(5, 'test-owner');
    // All calls in the transaction must use the same client
    expect(clients).toHaveLength(1);
  });
});
